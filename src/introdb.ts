// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * TheIntroDB lookups.
 *
 * One public request per title: `GET /v4/media` with an IMDb id (plus season and
 * episode for series). The response holds one array per segment kind; each entry
 * is a pair of millisecond bounds, either of which may be null:
 *
 *   {"intro":[{"start_ms":228665,"end_ms":246498}],
 *    "credits":[{"start_ms":3432884,"end_ms":null}]}
 *
 * What this module guarantees about turning that into skip windows:
 *
 * - A null `end_ms` means "runs to the end of the file", not "unknown".
 * - A null `start_ms` means 0 (the API only serves it on intros/recaps).
 * - An entry with BOTH bounds absent or zero is TheIntroDB's "no such segment"
 *   claim -- a statement about existence, not a timestamp. It is dropped here and
 *   must never reach a splice: its range is empty, so it would match nothing on
 *   one release and everything on another.
 * - A null-end segment starting at 0:00 would cut the whole file, so it is dropped.
 * - Overlapping or touching windows are merged before splicing, so a recap that
 *   runs into the intro is one cut rather than two.
 */

import { getHttpCache, type HttpCache } from "./cache.js";
import { parseStremioId } from "./config.js";
import type {
  Env,
  IntroDbMediaResponse,
  IntroDbSegment,
  SegmentType,
  SkipWindow,
} from "./types.js";

export const DEFAULT_API_BASE = "https://api.theintrodb.org";

/** Read-path cache lifetimes. Community timings move on the order of days. */
const TTL_FOUND_SECONDS = 6 * 60 * 60;
const TTL_MISSING_SECONDS = 15 * 60;
const REQUEST_TIMEOUT_MS = 4000;

export interface LookupResult {
  /** `ok` = a usable answer (possibly with no windows), `not_found` = the API has no media. */
  status: "ok" | "not_found" | "unavailable";
  windows: SkipWindow[];
  /** Machine-readable detail for logs and response headers. */
  reason: string;
  cached: boolean;
  /** Present when the API answered, for debugging against the real release cluster. */
  tvdbId?: number | null;
  groupDurationMs?: number | null;
}

export interface LookupOptions {
  cache?: HttpCache;
  fetchImpl?: typeof fetch;
}

/** Look up the timings for one Stremio id and reduce them to skip windows. */
export async function lookupSkipWindows(
  env: Env,
  config: { key?: string; types: SegmentType[] },
  stremioId: string,
  options: LookupOptions = {},
): Promise<LookupResult> {
  const cache = options.cache ?? getHttpCache(env);
  const fetchImpl = options.fetchImpl ?? fetch;

  const parsed = parseStremioId(stremioId);
  if (!parsed) {
    return { status: "unavailable", windows: [], reason: "unsupported_id", cached: false };
  }
  if (config.types.length === 0) {
    return { status: "ok", windows: [], reason: "no_segment_types_enabled", cached: false };
  }

  const apiUrl = buildApiUrl(env, parsed);
  const cacheKey = `introdb:${apiUrl}`;
  const hit = await cache.match(cacheKey);
  if (hit) {
    return toResult(hit.status, hit.body, config.types, "cache_hit", true);
  }

  const apiKey = config.key || env.TIDB_API_KEY || "";
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  let response: Response;
  try {
    response = await fetchImpl(apiUrl, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      status: "unavailable",
      windows: [],
      reason: `request_failed:${describeError(error)}`,
      cached: false,
    };
  }

  const body = await response.text();

  if (response.status === 200) {
    await cache.put(
      cacheKey,
      { status: 200, body, contentType: "application/json" },
      TTL_FOUND_SECONDS,
    );
    return toResult(200, body, config.types, "fresh", false);
  }

  if (response.status === 404) {
    await cache.put(
      cacheKey,
      { status: 404, body, contentType: "application/json" },
      TTL_MISSING_SECONDS,
    );
    return toResult(404, body, config.types, errorCode(body) ?? "media_not_found", false);
  }

  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    return {
      status: "unavailable",
      windows: [],
      reason: `rate_limited${retryAfter ? `:retry_after=${retryAfter}` : ""}`,
      cached: false,
    };
  }

  return {
    status: "unavailable",
    windows: [],
    reason: `http_${response.status}`,
    cached: false,
  };
}

/** Reduce a `/v4/media` body to the windows for the enabled segment kinds. */
export function mediaToWindows(
  media: IntroDbMediaResponse,
  types: readonly SegmentType[],
): SkipWindow[] {
  const windows: SkipWindow[] = [];
  for (const type of types) {
    const entries = media[type];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const window = toWindow(type, entry);
      if (window) windows.push(window);
    }
  }
  return mergeWindows(windows);
}

function toWindow(type: SegmentType, entry: IntroDbSegment | null | undefined): SkipWindow | null {
  if (!entry || typeof entry !== "object") return null;

  const startRaw = entry.start_ms;
  const endRaw = entry.end_ms;
  // A bound that is present but not a number is not something to act on.
  if (startRaw !== null && startRaw !== undefined && typeof startRaw !== "number") return null;
  if (endRaw !== null && endRaw !== undefined && typeof endRaw !== "number") return null;
  if (typeof startRaw === "number" && !Number.isFinite(startRaw)) return null;
  if (typeof endRaw === "number" && !Number.isFinite(endRaw)) return null;

  const startMs = normalizeBound(startRaw);
  const endMs = normalizeBound(endRaw);

  // "No such segment": both bounds absent or zero. Never a range.
  if (startMs === null && endMs === null) return null;

  const start = startMs ?? 0;

  if (endMs !== null && endMs <= start) return null;
  // Credits/preview that start at 0:00 and never end would cut the whole file.
  if (endMs === null && start <= 0) return null;

  return { type, startMs: start, endMs };
}

function normalizeBound(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value <= 0) return null;
  return Math.round(value);
}

/** Sort and fuse windows that overlap or touch. */
export function mergeWindows(windows: readonly SkipWindow[]): SkipWindow[] {
  const sorted = [...windows].sort((a, b) => a.startMs - b.startMs);
  const merged: SkipWindow[] = [];
  for (const window of sorted) {
    const last = merged[merged.length - 1];
    if (!last) {
      merged.push({ ...window });
      continue;
    }
    if (last.endMs === null) continue; // already runs to the end
    if (window.startMs <= last.endMs) {
      // Keep the widest end; a null end swallows everything after it.
      last.endMs = window.endMs === null ? null : Math.max(last.endMs, window.endMs);
      continue;
    }
    merged.push({ ...window });
  }
  return merged;
}

/** The `/v4/media` URL for one id, including the season/episode an episode needs. */
export function buildApiUrl(
  env: Pick<Env, "INTRODB_API_BASE">,
  parsed: { imdbId: string; season: number | null; episode: number | null },
): string {
  const base = (env.INTRODB_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, "");
  const url = new URL(`${base}/v4/media`);
  url.searchParams.set("imdb_id", parsed.imdbId);
  if (parsed.season !== null && parsed.episode !== null) {
    url.searchParams.set("season", String(parsed.season));
    url.searchParams.set("episode", String(parsed.episode));
  }
  return url.toString();
}

function toResult(
  status: number,
  body: string,
  types: SegmentType[],
  reason: string,
  cached: boolean,
): LookupResult {
  if (status === 404) {
    return { status: "not_found", windows: [], reason, cached };
  }

  let media: IntroDbMediaResponse;
  try {
    media = JSON.parse(body) as IntroDbMediaResponse;
  } catch {
    return { status: "unavailable", windows: [], reason: "invalid_json", cached };
  }

  return {
    status: "ok",
    windows: mediaToWindows(media, types),
    reason,
    cached,
    tvdbId: media.tvdb_id ?? null,
    groupDurationMs: media.group_duration_ms ?? null,
  };
}

function errorCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { code?: unknown };
    return typeof parsed.code === "string" ? parsed.code : null;
  } catch {
    return null;
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.name === "TimeoutError" ? "timeout" : error.name;
  return "unknown";
}
