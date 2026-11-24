// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * The source of streams.
 *
 * This addon does not scrape anything: it relays whichever stream addon the user
 * already runs (AIOStreams, Torrentio, Comet, MediaFusion, ...). Sources are tried
 * in order and the first one that answers with at least one stream wins, so a
 * second URL is a backup rather than a second catalogue.
 */

import type { AddonConfig, Env, UpstreamStream } from "./types.js";

export interface SourceResult {
  base: string;
  ok: boolean;
  count: number;
  error?: string;
}

export interface StreamsResult {
  streams: UpstreamStream[];
  sources: SourceResult[];
  /** The source addon whose streams were used, if any. */
  used?: string;
}

const REQUEST_TIMEOUT_MS = 8000;
/** A stream list is rendered in a UI: more than this is noise. */
export const MAX_STREAMS = 40;

export async function fetchStreams(
  env: Env,
  config: AddonConfig,
  type: string,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<StreamsResult> {
  const sources: SourceResult[] = [];

  for (const base of config.src) {
    const requestUrl = `${base}/stream/${encodeURIComponent(type)}/${id}.json`;
    let response: Response;
    try {
      response = await fetchImpl(requestUrl, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      sources.push({ base, ok: false, count: 0, error: errorName(error) });
      continue;
    }

    if (!response.ok) {
      sources.push({ base, ok: false, count: 0, error: `http_${response.status}` });
      continue;
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      sources.push({ base, ok: false, count: 0, error: "invalid_json" });
      continue;
    }

    const streams = extractStreams(payload);
    sources.push({ base, ok: true, count: streams.length });
    if (streams.length > 0) {
      return { streams: streams.slice(0, MAX_STREAMS), sources, used: base };
    }
  }

  return { streams: [], sources };
}

function extractStreams(payload: unknown): UpstreamStream[] {
  if (typeof payload !== "object" || payload === null) return [];
  const streams = (payload as { streams?: unknown }).streams;
  if (!Array.isArray(streams)) return [];
  return streams.filter(
    (entry): entry is UpstreamStream => typeof entry === "object" && entry !== null,
  );
}

/** Label a source addon by host: no extra subrequest, and unambiguous in the UI. */
export function sourceLabel(base: string): string {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
}

/**
 * Wrap one upstream stream so its playlist comes back through this Worker.
 *
 * The release's own labels are left alone: `title` is what tells two releases of
 * one episode apart and `name` is where a source addon puts its quality tag, so
 * the addon's mark goes on `name` as a suffix and the cut list goes on
 * `description`, which is the field nothing else depends on.
 *
 * Streams that are not fetchable URLs (a torrent `infoHash`, or a URL that only
 * resolves on the user's own machine) are returned untouched: there is no playlist
 * to rewrite and a rewrite would break playback.
 */
export function wrapStream(
  stream: UpstreamStream,
  options: {
    playUrl: (target: string) => string;
    label: string;
    cutSummary: string | null;
    allowPrivateHosts: boolean;
    /** The source addon base, used to resolve a relative stream URL. */
    sourceBase: string;
  },
): UpstreamStream {
  const target = resolveTarget(stream.url, options.sourceBase);
  const wrapped: UpstreamStream = { ...stream };
  const base = stream.description || filenameOf(stream);
  const note = options.cutSummary;

  // A source that asks for its own headers on every request keeps it that way:
  // this relay does not carry them, so the stream is better off untouched.
  if (needsCustomHeaders(stream)) {
    if (note) {
      wrapped.description = [
        base,
        `${note} (this stream is left as it is: its source asks for custom headers).`,
      ]
        .filter(Boolean)
        .join("\n");
    }
    return wrapped;
  }

  if (!target || !isFetchableByWorker(target, options.allowPrivateHosts)) {
    if (note) {
      wrapped.description = [base, `${note} (this stream cannot be rewired: not an HTTP(S) URL).`]
        .filter(Boolean)
        .join("\n");
    }
    return wrapped;
  }

  wrapped.url = options.playUrl(target);
  const name = typeof stream.name === "string" ? stream.name.trim() : "";
  wrapped.name = name ? `${name} · TheIntroDB` : options.label;
  if (note) {
    wrapped.description = [base, `${note}`].filter(Boolean).join("\n");
  }
  return wrapped;
}

function filenameOf(stream: UpstreamStream): string {
  const hints = stream.behaviorHints;
  if (hints && typeof hints.filename === "string") return hints.filename;
  return "";
}

/** True when the source addon declared request headers the player must send. */
function needsCustomHeaders(stream: UpstreamStream): boolean {
  const hints = stream.behaviorHints;
  if (!hints) return false;
  const proxy = hints.proxyHeaders;
  if (!proxy || typeof proxy !== "object") return false;
  const request = (proxy as { request?: unknown }).request;
  return Boolean(request && typeof request === "object" && Object.keys(request).length > 0);
}

/** A stream URL is usually absolute; a relative one is resolved against its addon. */
export function resolveTarget(raw: unknown, sourceBase: string): string {
  if (typeof raw !== "string") return "";
  const value = raw.trim();
  if (!value) return "";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return value;
  try {
    return new URL(value, `${sourceBase.replace(/\/+$/, "")}/`).toString();
  } catch {
    return "";
  }
}

/** URLs this Worker cannot or must not fetch. */
export function isFetchableByWorker(target: string, allowPrivateHosts = false): boolean {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;

  const host = url.hostname.toLowerCase();
  // Stremio's own localhost proxy (and any LAN address) is not reachable from the
  // edge; leaving the stream alone lets the local client play it directly.
  if (host === "localhost" || host.endsWith(".local")) return false;
  if (!allowPrivateHosts && isPrivateHost(host)) return false;
  return true;
}

/** A coarse private/loopback test, enough to keep the relay from being an SSRF tool. */
export function isPrivateHost(host: string): boolean {
  if (host === "[::1]" || host === "::1") return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  return /(^|\.)internal$/.test(host) || /(^|\.)home\.arpa$/.test(host);
}

function errorName(error: unknown): string {
  if (error instanceof Error) return error.name === "TimeoutError" ? "timeout" : error.name;
  return "unknown";
}
