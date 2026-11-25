// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * `/play` -- the endpoint that makes the skip happen.
 *
 * It is handed the origin stream URL, and it answers with one of three things:
 *
 * - an HLS playlist with the skip windows removed (masters are rewritten so their
 *   variants come back here, then the variant playlist is spliced);
 * - a cut file, for a progressive `.mkv`/`.mp4` whose intro was remuxed out by
 *   `cut.ts` (see there: the first playback warms it, later ones are cut);
 * - a `302` to the origin URL, for anything that cannot be cut, or while a cut is
 *   still being prepared.
 *
 * Nothing here re-encodes: HLS is cut by dropping segments, a progressive file by
 * copying the ranges that survive.
 */

import { getHttpCache } from "./cache.js";
import type { ManifestView, PackageEngine } from "./packages.js";
import type { Settings } from "./env.js";
import { serveFile } from "./files.js";
import { describeWindows } from "./format.js";
import {
  isMasterPlaylist,
  isPlaylist,
  rewriteMasterPlaylist,
  spliceMediaPlaylist,
  type UriRewriters,
} from "./hls.js";
import { CORS_HEADERS, playlist, redirectTo, text } from "./http.js";
import { lookupSkipWindows } from "./introdb.js";
import { isPrivateHost } from "./upstream.js";
import type { AddonConfig, CutMode, SkipWindow } from "./types.js";
import { playUrl, segmentUrl } from "./urls.js";

/** Playlists are text and small; anything bigger is not a playlist. */
const MAX_PLAYLIST_BYTES = 4 * 1024 * 1024;
const SNIFF_BYTES = 8192;
const UPSTREAM_TIMEOUT_MS = 10000;
const SEGMENT_TIMEOUT_MS = 30000;
/** How long a "this target is not a playlist" verdict is remembered. */
const NOT_PLAYLIST_TTL_SECONDS = 60 * 60;

/** Extensions that are never a playlist, so a sniff can be skipped entirely. */
const MEDIA_EXTENSIONS = [
  ".mp4", ".m4v", ".mkv", ".webm", ".avi", ".mov", ".flv", ".wmv", ".mpg", ".mpeg", ".m2ts",
  ".ts", ".iso", ".mp3", ".m4a", ".aac", ".flac", ".srt", ".vtt", ".ass",
];

export interface PlayContext {
  request: Request;
  settings: Settings;
  packages: PackageEngine;
  config: AddonConfig;
  encodedConfig: string;
  origin: string;
}

export async function handlePlay(context: PlayContext): Promise<Response> {
  const requestUrl = new URL(context.request.url);
  const target = requestUrl.searchParams.get("u");
  const id = requestUrl.searchParams.get("id") ?? "";
  // The stable identity of the source stream, from the stream list. Without it a cut
  // is keyed on a URL that a debrid source re-mints, which is how a ready cut used to
  // be missed on the next playback.
  const streamKey = requestUrl.searchParams.get("k");

  if (!target) return text("Missing u parameter", { status: 400 });
  const blocked = targetRejection(target, context.settings);
  if (blocked) return text(blocked, { status: 400 });

  // The timings decide whether anything can be cut, so they come first.
  const lookup = id ? await lookupSkipWindows(context.settings, context.config, id) : null;
  const windows = lookup?.windows ?? [];
  // The install's own choice wins over the deployment's default, so `off` in the URL
  // means nothing is cut (or copied) for that install while the service keeps cutting
  // for everyone else.
  const cutMode: CutMode = context.config.cuts ?? context.settings.cuts;
  const cutting = cutMode !== "off" && context.packages.enabled;
  const cutKey =
    windows.length > 0 && cutting ? context.packages.keyFor(target, windows, streamKey) : null;

  // A package that already exists is served before anything else is decided: this is
  // what makes a debrid `.mkv` skip its intro on every playback after the first, and
  // (in `on` mode) what makes it skip from the very first one.
  if (cutKey) {
    const ready = await context.packages.manifest(cutKey);
    if (ready) return manifestResponse(ready, cutKey, lookup?.reason ?? "");
  }

  const proxyOn = context.config.proxy === true;
  const cache = getHttpCache();
  const verdictKey = `play:verdict:${target}`;

  if (proxyOn) {
    // With proxying on, the player never touches the source addon. That is not only
    // about segments: a debrid link is minted for the address that asked for it, and
    // this service is that address, so a file has to be streamed from here too --
    // otherwise the player opens the link from its own network and the source answers
    // "this stream link only works on the internet connection that requested it".
    if (looksLikeProgressiveFile(target)) {
      return handleProgressive(
        context, target, windows, "proxied_file", streamKey, cutMode, lookup?.reason ?? "",
      );
    }
  } else {
    // A HEAD probe, or a byte range the player already knows it wants: nothing to
    // rewrite. A playlist is never range-requested in practice, and a progressive
    // file is range-requested on every seek.
    if (context.request.method === "HEAD" || requestUrl.searchParams.has("whole")) {
      return redirectTo(target, "pass_through");
    }
    if (context.request.headers.has("range") && !cutKey) {
      return redirectTo(target, "range_request");
    }
    if (looksLikeProgressiveFile(target)) {
      return handleProgressive(context, target, windows, "not_hls", streamKey, cutMode, lookup?.reason ?? "");
    }
    if (await cache.match(verdictKey)) {
      return handleProgressive(
        context, target, windows, "not_a_playlist_cached", streamKey, cutMode, lookup?.reason ?? "",
      );
    }
  }

  const rewriters: UriRewriters = {
    playlistUri: (absoluteUri) => playUrl(context.origin, context.encodedConfig, absoluteUri, id),
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

  if (sniffed === null || !isPlaylist(sniffed.text)) {
    await cache.put(
      verdictKey,
      { status: 302, body: "not_a_playlist", contentType: "text/plain" },
      NOT_PLAYLIST_TTL_SECONDS,
    );
    // A file behind a URL with no extension (a debrid `/playback/<token>`, for
    // instance): the prefix read above already had to come from here, so the rest
    // does too -- which `handleProgressive` does when the config asks for proxying.
    return handleProgressive(
      context, target, windows, "not_a_playlist", streamKey, cutMode, lookup?.reason ?? "",
    );
  }

  if (isMasterPlaylist(sniffed.text)) {
    const rewritten = rewriteMasterPlaylist(sniffed.text, target, rewriters);
    return playlist(rewritten, { "x-tidb-play": "master" }, 60);
  }

  const spliced = spliceMediaPlaylist(sniffed.text, {
    baseUrl: target,
    windows,
    rewriters,
    forceRewrite: context.config.proxy === true,
  });

  if (!spliced) return redirectTo(target, "not_a_media_playlist");

  if (spliced.degenerate) {
    // Every segment overlapped a window: serving an empty playlist would break
    // playback, so pass the original through and say so in the headers.
    return playlistFor(sniffed.text, {
      "x-tidb-play": "degenerate_windows",
      "x-tidb-lookup": lookup?.reason ?? "",
    });
  }

  if (!spliced.changed) {
    return playlistFor(sniffed.text, {
      "x-tidb-play": context.config.proxy ? "rewritten_uris" : "unchanged",
      "x-tidb-lookup": lookup?.reason ?? "",
      "x-tidb-windows": String(spliced.windows.length),
      "x-tidb-cuts": describeWindows(spliced.windows),
    });
  }

  return playlistFor(spliced.text, {
    "x-tidb-play": "spliced",
    "x-tidb-lookup": lookup?.reason ?? "",
    "x-tidb-windows": String(spliced.windows.length),
    "x-tidb-cuts": describeWindows(spliced.windows),
    "x-tidb-dropped-segments": String(spliced.droppedSegments),
    "x-tidb-dropped-ms": String(spliced.droppedMs),
    "x-tidb-duration-ms": String(spliced.durationMs),
  });
}

/**
 * A file with no playlist to rewrite: get it cut, and serve it once it is.
 *
 * In `on` mode the first playback is handed to the origin and the remux runs in
 * the background, so nothing blocks; `blocking` holds the request (bounded by
 * CUT_WAIT_SECONDS) and falls back the same way.
 */
async function handleProgressive(
  context: PlayContext,
  target: string,
  windows: readonly SkipWindow[],
  reason: string,
  streamKey: string | null = null,
  mode: CutMode = context.settings.cuts,
  lookupReason = "",
): Promise<Response> {
  if (windows.length > 0 && mode !== "off" && context.packages.enabled) {
    return packageOrProxy(context, target, windows, streamKey, mode, reason, lookupReason);
  }
  return passThrough(context, target, reason, lookupReason);
}

/**
 * The source itself: proxied when the config asks for it, otherwise handed over.
 *
 * A debrid link is minted for the address that asked for it, so with proxying on this
 * service has to be the one to fetch it -- the player opening the link from its own
 * network is what produces "this stream link only works on the internet connection
 * that requested it".
 */
function passThrough(
  context: PlayContext,
  target: string,
  reason: string,
  lookupReason = "",
): Promise<Response> | Response {
  if (context.config.proxy === true) {
    // `x-tidb-play` says what happened, `x-tidb-fallback` says why the original was
    // served instead of a package: two different questions, and an operator asking
    // "why is the intro still there" needs the second one.
    return streamThrough(context.request, target, {
      cacheControl: "no-store",
      timeoutMs: null,
      debug: {
        "x-tidb-play": "proxied_file",
        ...(reason && reason !== "proxied_file" ? { "x-tidb-fallback": reason } : {}),
        ...(lookupReason ? { "x-tidb-lookup": lookupReason } : {}),
      },
    });
  }
  return redirectTo(target, reason);
}

/**
 * A playlist built from this key's package, starting the generation when there is
 * none yet.
 *
 * This is the answer to "the player gives up before the file has downloaded": what is
 * waited for here is one segment, a couple of seconds of work, and not the file.
 * `on` mode does not even wait for that: it plays the source now and cuts from the
 * next playback. Whatever happens, a player that plays something is better than one
 * that fails, so a source too slow to produce a segment inside the window is passed
 * through untouched.
 */
async function packageOrProxy(
  context: PlayContext,
  target: string,
  windows: readonly SkipWindow[],
  streamKey: string | null,
  mode: CutMode,
  reason: string,
  lookupReason: string,
): Promise<Response> {
  const key = context.packages.keyFor(target, windows, streamKey);
  const ready = await context.packages.manifest(key);
  if (ready) return manifestResponse(ready, key, lookupReason);

  context.packages.schedule(target, windows, streamKey);
  if (mode !== "blocking") return passThrough(context, target, "package_warming", lookupReason);

  const waited = await context.packages.waitForFirstSegment(
    key,
    context.settings.cutWaitSeconds * 1000,
  );
  if (waited) return manifestResponse(waited, key, lookupReason);
  return passThrough(context, target, "package_slow", lookupReason);
}

function manifestResponse(view: ManifestView, key: string, lookupReason: string): Response {
  return playlist(
    view.body,
    {
      "x-tidb-play": view.complete ? "package_vod" : "package_live",
      // Which package was served. Two playbacks of the same release must show the same
      // key even though the source re-minted its link in between.
      "x-tidb-package": key,
      "x-tidb-segments": String(view.segments),
      "x-tidb-content-ms": String(view.durationMs),
      ...(lookupReason ? { "x-tidb-lookup": lookupReason } : {}),
    },
    // Re-read on every poll: an EVENT playlist grows while the player watches.
    0,
  );
}

/**
 * `/seg` -- passthrough for the media resources of a playlist.
 *
 * Used when the config asks for proxying: the player fetches every segment from here
 * instead of from the source, which is what makes a source that binds its links to
 * the requesting address work.
 */
export async function handleSegment(context: PlayContext): Promise<Response> {
  const requestUrl = new URL(context.request.url);

  // A segment of a package this service generated (`f=<key>/<name>`): served from the
  // cache it was written to. A segment never changes once written, so the player may
  // keep it -- which is what makes a replay cheap.
  const file = requestUrl.searchParams.get("f");
  if (file) {
    const slash = file.lastIndexOf("/");
    const local =
      slash > 0 ? context.packages.segmentPath(file.slice(0, slash), file.slice(slash + 1)) : null;
    if (!local) return text("Malformed f parameter", { status: 400 });
    return serveFile(context.request, local, "ts", {
      "x-tidb-play": "package_segment",
      "cache-control": "public, max-age=21600",
    });
  }

  const target = requestUrl.searchParams.get("u");
  if (!target) return text("Missing u parameter", { status: 400 });
  const blocked = targetRejection(target, context.settings);
  if (blocked) return text(blocked, { status: 400 });

  return streamThrough(context.request, target, {
    // A segment is small and immutable, unlike a whole film.
    cacheControl: "public, max-age=3600",
    debug: { "x-tidb-seg": "streamed" },
  });
}

interface StreamOptions {
  cacheControl: string;
  debug?: Record<string, string>;
  /**
   * Abort the upstream request after this long. `null` means no timeout: a whole film
   * can stream for minutes, and the player closing the connection is what ends it
   * (the response body is cancelled, which tears the upstream request down).
   */
  timeoutMs?: number | null;
}

/**
 * Fetch a source and hand its bytes to the player unchanged.
 *
 * The body is streamed, never buffered, and the range headers go both ways, so
 * seeking works exactly as it would against the source. Only the headers a player has
 * any use for are passed through: a length is relayed only when nothing re-encoded
 * the body in between.
 */
async function streamThrough(
  request: Request,
  target: string,
  options: StreamOptions,
): Promise<Response> {
  const headers: Record<string, string> = {};
  for (const name of ["range", "user-agent", "accept", "accept-language"]) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method === "HEAD" ? "HEAD" : "GET",
      headers,
      redirect: "follow",
      ...(options.timeoutMs === null
        ? {}
        : { signal: AbortSignal.timeout(options.timeoutMs ?? SEGMENT_TIMEOUT_MS) }),
    });
  } catch {
    return text("Upstream unreachable", {
      status: 502,
      headers: { "x-tidb-proxy": "unreachable", ...options.debug },
    });
  }

  const passthrough = new Headers(CORS_HEADERS);
  passthrough.set("cache-control", options.cacheControl);
  passthrough.set("x-tidb-proxy", "streamed");
  passthrough.set("x-tidb-upstream-status", String(upstream.status));
  for (const [name, value] of Object.entries(options.debug ?? {})) passthrough.set(name, value);
  for (const name of ["content-type", "content-range", "accept-ranges", "etag", "last-modified"]) {
    const value = upstream.headers.get(name);
    if (value) passthrough.set(name, value);
  }
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
    /mpegurl/i.test(contentType) ||
    /\.m3u8?(\?|$)/i.test(new URL(target).pathname + new URL(target).search);

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

function playlistFor(body: string, debugHeaders: Record<string, string>): Response {
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
export function targetRejection(target: string, env: Settings): string | null {
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
