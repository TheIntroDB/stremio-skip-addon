// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * The install configuration, packed into the addon URL.
 *
 * Stremio installs an addon by URL and re-requests every resource from that
 * same URL, so a per-user setting has nowhere to live except the URL itself.
 * The config is the first path segment of every request:
 *
 *   https://<worker>/<config>/manifest.json
 *   https://<worker>/<config>/stream/series/tt0903747:1:1.json
 *
 * It is base64url of a small JSON object. base64url is used (not base64) so the
 * segment survives as a path component without percent-encoding.
 */

import {
  DEFAULT_SEGMENT_TYPES,
  SEGMENT_TYPES,
  parseCutMode,
  parseMarginSeconds,
  type AddonConfig,
  type SegmentType,
} from "./types.js";

const MAX_SOURCES = 5;
const MAX_SOURCE_URL_LENGTH = 2048;
const MAX_NAME_LENGTH = 40;
const MAX_KEY_LENGTH = 200;

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

/** A valid config that the addon can serve, or null. */
export function decodeConfig(encoded: string): AddonConfig | null {
  if (!encoded || !BASE64URL_RE.test(encoded)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(fromBase64Url(encoded));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;

  const input = raw as Record<string, unknown>;
  const src = normalizeSources(input.src);
  if (src.length === 0) return null;

  const config: AddonConfig = {
    src,
    types: normalizeTypes(input.types),
  };

  const key = typeof input.key === "string" ? input.key.trim() : "";
  if (key) config.key = key.slice(0, MAX_KEY_LENGTH);

  if (input.proxy === true) config.proxy = true;

  // Only one of the three known modes is accepted, so a hand-edited URL cannot ask
  // for something the engine does not implement.
  const cuts = parseCutMode(input.cuts);
  if (cuts) config.cuts = cuts;

  // Likewise, only a margin the service offers is accepted: a hand-edited link cannot
  // ask for a negative one.
  const margin = parseMarginSeconds(input.margin);
  if (margin !== null) config.margin = margin;
  if (input.splash === false) config.splash = false;

  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name) config.name = sanitizeName(name);

  return config;
}

/** Pack a config into the addon URL. Deterministic for a given config. */
export function encodeConfig(config: AddonConfig): string {
  const packed: Record<string, unknown> = {
    src: normalizeSources(config.src),
    types: normalizeTypes(config.types),
  };
  if (config.key) packed.key = config.key.trim().slice(0, MAX_KEY_LENGTH);
  if (config.proxy) packed.proxy = true;
  if (config.cuts) packed.cuts = config.cuts;
  if (typeof config.margin === "number") packed.margin = config.margin;
  if (config.splash === false) packed.splash = false;
  if (config.name) packed.name = sanitizeName(config.name);
  return toBase64Url(JSON.stringify(packed));
}

/** A source addon URL as a base: `https://host/path/manifest.json` -> `https://host/path`. */
export function sourceBase(manifestUrl: string): string {
  const trimmed = manifestUrl.trim().replace(/\/+$/, "");
  return trimmed.replace(/\/manifest\.json$/i, "");
}

/**
 * `tt0903747:1:1` -> `{ imdbId: "tt0903747", season: 1, episode: 1 }`.
 * Returns null when the id is not an IMDb id, or not an episode address.
 */
export function parseStremioId(
  id: string,
): { imdbId: string; season: number | null; episode: number | null } | null {
  const parts = id.split(":");
  const imdbId = parts[0] ?? "";
  if (!/^tt\d{4,}$/.test(imdbId)) return null;

  if (parts.length === 1) return { imdbId, season: null, episode: null };

  if (parts.length !== 3) return null;
  const season = Number(parts[1]);
  const episode = Number(parts[2]);
  if (!Number.isInteger(season) || !Number.isInteger(episode)) return null;
  if (season < 0 || episode < 0) return null;
  return { imdbId, season, episode };
}

/** Short stable hash, used to give every config its own addon id in Stremio. */
export function configIdSuffix(encoded: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < encoded.length; i++) {
    hash ^= encoded.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function normalizeSources(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "string") continue;
    const url = entry.trim();
    if (!url || url.length > MAX_SOURCE_URL_LENGTH) continue;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    const normalized = sourceBase(url);
    if (!out.includes(normalized)) out.push(normalized);
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}

function normalizeTypes(value: unknown): SegmentType[] {
  if (value === undefined) return [...DEFAULT_SEGMENT_TYPES];
  if (!Array.isArray(value)) return [...DEFAULT_SEGMENT_TYPES];
  const out: SegmentType[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const type = SEGMENT_TYPES.find((known) => known === entry);
    if (type && !out.includes(type)) out.push(type);
  }
  return out;
}

function sanitizeName(name: string): string {
  return name.replace(/[<>&"]/g, "").slice(0, MAX_NAME_LENGTH).trim();
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(encoded: string): string {
  const padded = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
