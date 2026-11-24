// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * `/play` -- the endpoint that makes the skip happen.
 *
 * It is handed the origin stream URL, and it answers with one of two things:
 *
 * - an HLS playlist with the skip windows removed (masters are rewritten so their
 *   variants come back here, then the variant playlist is spliced);
 * - a `302` to the origin URL, for anything that is not HLS.
 *
 * A progressive `.mkv`/`.mp4` cannot be cut in a Worker -- there is no transcoder
 * and no way to splice the container -- so those always take the redirect. That is
 * the honest boundary of a manifest-only implementation, and it is why the README
 * says the addon helps HLS sources only.
 */

import { describeWindows } from "./format.js";
import { isMasterPlaylist, isPlaylist, rewriteMasterPlaylist, spliceMediaPlaylist, type UriRewriters } from "./hls.js";
import { playlist, redirectTo, text } from "./http.js";
import { lookupSkipWindows } from "./introdb.js";
import { isPrivateHost } from "./upstream.js";
import type { AddonConfig, Env } from "./types.js";
import { playUrl, segmentUrl } from "./urls.js";

/** Playlists are text and small; anything bigger is not a playlist. */
const MAX_PLAYLIST_BYTES = 4 * 1024 * 1024;
const SNIFF_BYTES = 8192;
const UPSTREAM_TIMEOUT_MS = 10000;
const SEGMENT_TIMEOUT_MS = 30000;

/** Extensions that are never a playlist, so a sniff can be skipped entirely. */
const MEDIA_EXTENSIONS = [
  ".mp4", ".m4v", ".mkv", ".webm", ".avi", ".mov", ".flv", ".wmv", ".mpg", ".mpeg", ".m2ts",
  ".ts", ".iso", ".mp3", ".m4a", ".aac", ".flac", ".srt", ".vtt", ".ass",
];

export interface PlayContext {
  request: Request;
  env: Env;
  config: AddonConfig;
  encodedConfig: string;
  origin: string;
}

export async function handlePlay(context: PlayContext): Promise<Response> {
  const requestUrl = new URL(context.request.url);
  const target = requestUrl.searchParams.get("u");
  const id = requestUrl.searchParams.get("id") ?? "";

  if (!target) return text("Missing u parameter", { status: 400 });
  const blocked = targetRejection(target, context.env);
  if (blocked) return text(blocked, { status: 400 });

  // The player asked for a byte range of a file it already knows, or a HEAD probe:
  // nothing to rewrite, hand it straight to the origin.
  if (context.request.method === "HEAD" || requestUrl.searchParams.has("whole")) {
    return redirectTo(target, "pass_through");
  }
  if (looksLikeProgressiveFile(target)) {
    return redirectTo(target, "not_hls");
  }

  const rewriters: UriRewriters = {
    playlistUri: (absoluteUri) =>
      playUrl(context.origin, context.encodedConfig, absoluteUri, id),
    resourceUri: (absoluteUri) =>
      context.config.proxy
        ? segmentUrl(context.origin, context.encodedConfig, absoluteUri)
        : absoluteUri,
  };

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      headers: forwardedHeaders(context.request),
      redirect: "follow",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    // An unreachable playlist is not a reason to fail playback: the player may
    // still reach the origin itself.
    return redirectTo(target, "upstream_unreachable");
  }

  if (upstream.status >= 400) return redirectTo(target, `upstream_${upstream.status}`);

  const contentType = upstream.headers.get("content-type") ?? "";
  const sniffed = await readPlaylist(upstream, target, contentType);

  if (sniffed === null) return redirectTo(target, "not_a_playlist");
  if (!isPlaylist(sniffed.text)) return redirectTo(target, "not_a_playlist");

  if (isMasterPlaylist(sniffed.text)) {
    const rewritten = rewriteMasterPlaylist(sniffed.text, target, rewriters);
    return playlist(rewritten, { "x-tidb-play": "master" }, 60);
  }

  const lookup = await lookupSkipWindows(context.env, context.config, id);
  const spliced = spliceMediaPlaylist(sniffed.text, {
    baseUrl: target,
    windows: lookup.windows,
    rewriters,
    forceRewrite: context.config.proxy === true,
  });

  if (!spliced) return redirectTo(target, "not_a_media_playlist");

  if (spliced.degenerate) {
    // Every segment overlapped a window: serving an empty playlist would break
    // playback, so pass the original through and say so in the headers.
    return playlistFor(target, sniffed.text, {
      "x-tidb-play": "degenerate_windows",
      "x-tidb-lookup": lookup.reason,
    });
  }

  if (!spliced.changed) {
    return playlistFor(target, sniffed.text, {
      "x-tidb-play": context.config.proxy ? "rewritten_uris" : "unchanged",
      "x-tidb-lookup": lookup.reason,
      "x-tidb-windows": String(spliced.windows.length),
      "x-tidb-cuts": describeWindows(spliced.windows),
    });
  }

  return playlistFor(target, spliced.text, {
    "x-tidb-play": "spliced",
    "x-tidb-lookup": lookup.reason,
    "x-tidb-windows": String(spliced.windows.length),
    "x-tidb-cuts": describeWindows(spliced.windows),
    "x-tidb-dropped-segments": String(spliced.droppedSegments),
    "x-tidb-dropped-ms": String(spliced.droppedMs),
    "x-tidb-duration-ms": String(spliced.durationMs),
  });
}

/**
 * `/seg` -- optional passthrough for the media resources of a playlist.
 *
 * Used only when the config asks for it (a source that needs the same headers or
 * cookies for every segment). Real-Debrid-style links are bound to the IP that
 * generated them, so proxying segments moves the request to a Cloudflare egress
 * address and can be refused -- which is why this is opt-in.
 */
export async function handleSegment(context: PlayContext): Promise<Response> {
  const requestUrl = new URL(context.request.url);
  const target = requestUrl.searchParams.get("u");
  if (!target) return text("Missing u parameter", { status: 400 });
  const blocked = targetRejection(target, context.env);
  if (blocked) return text(blocked, { status: 400 });

  const headers: Record<string, string> = {};
  for (const name of ["range", "user-agent", "accept", "accept-language"]) {
    const value = context.request.headers.get(name);
    if (value) headers[name] = value;
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: context.request.method === "HEAD" ? "HEAD" : "GET",
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(SEGMENT_TIMEOUT_MS),
    });
  } catch {
    return text("Upstream unreachable", { status: 502 });
  }

  const passthrough = new Headers();
  passthrough.set("access-control-allow-origin", "*");
  passthrough.set("cache-control", "public, max-age=3600");
  for (const name of [
    "content-type",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
  ]) {
    const value = upstream.headers.get(name);
    if (value) passthrough.set(name, value);
  }
  // Only relay the length when the body is not re-encoded by the edge.
  if (!upstream.headers.get("content-encoding")) {
    const length = upstream.headers.get("content-length");
    if (length) passthrough.set("content-length", length);
  }

  return new Response(upstream.body, { status: upstream.status, headers: passthrough });
}

/** Read a playlist body, sniffing anything whose content type does not say so. */
async function readPlaylist(
  response: Response,
  target: string,
  contentType: string,
): Promise<{ text: string } | null> {
  if (!response.body) return null;

  const declared =
    /mpegurl/i.test(contentType) || /\.m3u8?(\?|$)/i.test(new URL(target).pathname + new URL(target).search);

  if (declared) {
    const body = await readCapped(response, MAX_PLAYLIST_BYTES);
    if (body === null) return null;
    return { text: body };
  }

  // A generic content type on a playlist is common (proxies serve `.m3u8` as
  // `application/octet-stream`), but so is a video file. Read a prefix and decide.
  const prefix = await readPrefix(response, SNIFF_BYTES);
  if (!isPlaylist(prefix)) return null;

  const full = await fetch(target, {
    redirect: "follow",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  const body = await readCapped(full, MAX_PLAYLIST_BYTES);
  return body === null ? null : { text: body };
}

/** Read at most `maxBytes` of a body, cancelling the rest. Null when it overflows. */
async function readCapped(response: Response, maxBytes: number): Promise<string | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let out = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      out += decoder.decode(value, { stream: true });
    }
  } catch {
    return null;
  }
  return out + decoder.decode();
}

/** Read a prefix of a body and hang up, without downloading the whole thing. */
async function readPrefix(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let out = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      out += decoder.decode(value, { stream: true });
      if (total >= maxBytes) break;
    }
  } catch {
    // A truncated read still tells us what the first bytes were.
  }
  await reader.cancel().catch(() => undefined);
  return out;
}

function forwardedHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  const range = request.headers.get("range");
  if (range) headers.range = range;
  const userAgent = request.headers.get("user-agent");
  if (userAgent) headers["user-agent"] = userAgent;
  return headers;
}

function playlistFor(
  target: string,
  body: string,
  debugHeaders: Record<string, string>,
): Response {
  return playlist(body, debugHeaders);
}

function looksLikeProgressiveFile(target: string): boolean {
  try {
    const path = new URL(target).pathname.toLowerCase();
    return MEDIA_EXTENSIONS.some((extension) => path.endsWith(extension));
  } catch {
    return true;
  }
}

/** Null when the URL may be fetched, otherwise the reason to refuse it. */
export function targetRejection(target: string, env: Env): string | null {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return "Invalid u parameter";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "Only http(s) URLs can be relayed";
  }
  if (env.ALLOW_PRIVATE_HOSTS === "1") return null;
  if (isPrivateHost(url.hostname.toLowerCase())) {
    return "Refusing to relay a private address";
  }
  return null;
}
