// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * The request router.
 *
 * Everything here is standard `Request`/`Response`: the core is runtime-agnostic
 * and `server.ts` is the only place that knows about Node.
 *
 * Routes:
 *
 *   GET /                                  the configuration page
 *   GET /health                            liveness, configuration, cut cache
 *   GET /manifest.json                     manifest for a bare install (needs configuring)
 *   GET /<config>/manifest.json            manifest for an install
 *   GET /<config>/stream/{movie,series}/<id>.json
 *                                          the stream list, relayed from the source addon
 *   GET /<config>/play?u=&id=              a playlist (spliced) or a cut file
 *   GET /<config>/seg?u=                   one media resource (opt-in proxy mode)
 *   GET /<config>/subs.m3u8?f=             the growing subtitle rendition's playlist
 *   GET /<config>/subs/<name>.vtt?f=       one chunk of that track
 *
 * Every request after install carries the config as the first path segment, which
 * is the only place a Stremio addon can keep per-user settings.
 */

import { decodeConfig, parseStremioId } from "./config.js";
import { INTRODB_API_BASE, INTRODB_API_VERSION, INTRODB_SITE } from "./constants.js";
import type { PackageEngine } from "./packages.js";
import { describeSettings, type Settings } from "./env.js";
import { describeCuts } from "./format.js";
import { corsPreflight, errorResponse, html, json, text } from "./http.js";
import { lastLookupFailure, lookupSkipWindows } from "./introdb.js";
import { ADDON_VERSION, buildManifest } from "./manifest.js";
import { renderDebugJson, renderDebugPage, type DebugOptions } from "./debug.js";
import { diagnostics } from "./diagnostics.js";
import { cacheReport, formatBytes, purgeCache } from "./drain.js";
import { renderConfigPage } from "./page.js";
import { handlePlay, handleSegment } from "./play.js";
import { handleSubtitleChunk, handleSubtitlePlaylist, SubtitleEngine } from "./subtitles.js";
import { cardSeconds } from "./splash.js";
import { Transcriber } from "./transcribe.js";
import type { AddonConfig } from "./types.js";
import {
  fetchStreams,
  isFetchableByWorker,
  resolveTarget,
  sourceLabel,
  streamIdentity,
  wrapStream,
} from "./upstream.js";
import { playUrl } from "./urls.js";

/**
 * Every route an install can reach, and the reason this is a whitelist rather than a
 * prefix match: a path that is not in here is never routed, however good its handler is
 * (the rendition playlist and its chunks spent a release unreachable this way -- their
 * handlers were unit-tested directly, so nothing noticed).
 */
const CONFIG_ROUTE_RE =
  /^\/([A-Za-z0-9_-]{1,4096})(?:\/(manifest\.json|stream\/[^/]+\/[^/]+\.json|play|seg|subs\.m3u8|subs\/[^/]+\.vtt))?$/;

/**
 * The shortest string that could still be a configuration.
 *
 * The smallest useful config is a JSON object with one source URL in it, which is
 * about 40 base64url characters. Someone typing a path ("/about") should still get a
 * 404 rather than an explanation about an install link, so anything much shorter than
 * a real configuration is not treated as one.
 */
const MIN_PLAUSIBLE_CONFIG_LENGTH = 24;

export async function handleRequest(
  request: Request,
  settings: Settings,
  packages: PackageEngine,
  subtitles: SubtitleEngine | null = null,
  // One engine per process, whether or not the host wired one: its jobs and the models they use
  // outlive a request, so it cannot be built per call.
  engine: SubtitleEngine = subtitles ?? new SubtitleEngine(settings, new Transcriber(settings), () => packages.lastActivity),
): Promise<Response> {
  const url = new URL(request.url);
  const origin = url.origin;
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (request.method === "OPTIONS") return corsPreflight();
  if (request.method === "POST") {
    // The one write this service accepts: the drain on /debug. It is gated on a header a
    // cross-origin form cannot send (the preflight does not allow it), so a page elsewhere cannot
    // wipe the cache by submitting a form, and on a public deployment `DRAIN_SECRET` makes it
    // something you have to know rather than something you can find.
    if (path === "/drain") return drainNow(request, settings, packages, engine);
    return errorResponse(405, "method_not_allowed", "This addon is read-only");
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorResponse(405, "method_not_allowed", "Only GET and HEAD are supported");
  }

  if (path === "/" || path === "/configure") return configPage(settings, origin, packages);
  if (path === "/health") {
    return json({
      status: "ok",
      name: "TheIntroDB Skip",
      version: ADDON_VERSION,
      site: INTRODB_SITE,
      api: `${INTRODB_API_BASE}/${INTRODB_API_VERSION}/media`,
      ...describeSettings(settings),
      subtitles: engine.status(),
      lastLookupFailure: lastLookupFailure(),
      cutsStatus: packages.stats(),
    });
  }
  if (path === "/robots.txt") return text("User-agent: *\nDisallow: /\n");
  if (path === "/manifest.json") return json(buildManifest(null));

  // What this process is doing, and the one button that stops all of it. Not cached: the whole
  // point is that it is current.
  if (path === "/debug" || path === "/debug.json") {
    const snapshot = await debugSnapshot(origin, settings, packages, engine);
    return path === "/debug"
      ? html(renderDebugPage(snapshot), 200, { "cache-control": "no-store" })
      : json(renderDebugJson(snapshot));
  }

  const match = CONFIG_ROUTE_RE.exec(path);
  if (match) {
    // Stremio percent-encodes every path component, so an episode arrives as
    // `tt0903747%3A1%3A1.json` (Stremio Core: utf8_percent_encode with
    // URI_COMPONENT_ENCODE_SET). Decode before anything looks at the id.
    const encoded = decodePathComponent(match[1]!);
    const route = match[2] ? decodePathComponent(match[2]) : null;
    const config = decodeConfig(encoded);

    // `/<config>` is a link back to the settings that produced that install, so an
    // existing install can be edited instead of starting over. Nothing is stored on
    // the service: the URL *is* the record.
    if (route === null) {
      if (config === null && encoded.length < MIN_PLAUSIBLE_CONFIG_LENGTH) {
        // Not a configuration at all: a path somebody typed.
        return html(notFoundPage(origin), 404);
      }
      return configPage(settings, origin, packages, {
        editing: config,
        configError: config
          ? null
          : "That install link could not be read — a character was probably lost when it was copied.",
      });
    }

    if (!config) {
      return errorResponse(
        400,
        "invalid_config",
        "That configuration is not readable. Re-generate the install link from the addon's own page.",
      );
    }

    if (route === "manifest.json") return json(buildManifest(config, encoded));
    if (route === "play") {
      return handlePlay({
        request, settings, packages, subtitles: engine, config, encodedConfig: encoded, origin,
      });
    }
    if (route === "seg") {
      return handleSegment({
        request, settings, packages, subtitles: engine, config, encodedConfig: encoded, origin,
      });
    }
    // The subtitle rendition a master playlist points a player at, and its chunks. The playlist
    // is read again and again while a track is being made (hence never cached); the chunks are
    // written once and never change.
    if (route === "subs.m3u8") {
      return handleSubtitlePlaylist(
        { settings, subtitles: engine, request },
        settings.splash ? cardSeconds(settings) * 1000 : 0,
      );
    }
    // A chunk is addressed by its own name in the path (`subs/0.vtt`) rather than by a query
    // parameter: ffmpeg's HLS demuxer refuses a subtitle segment whose URI has no extension at
    // all, and refusing one takes the entire rendition down with it.
    const chunkMatch = /^subs\/([^/]+)\.vtt$/.exec(route);
    if (chunkMatch) {
      const query = new URL(request.url).searchParams;
      return handleSubtitleChunk(
        { settings, subtitles: engine, request },
        query.get("f") ?? "",
        chunkMatch[1]!,
      );
    }

    // stream/<type>/<id>.json
    const streamMatch = /^stream\/([^/]+)\/(.+)\.json$/.exec(route);
    if (streamMatch) {
      return handleStreams(settings, packages, config, encoded, origin, streamMatch[1]!, streamMatch[2]!);
    }
  }

  if (path.includes(".")) return errorResponse(404, "not_found", "Not found");
  return html(notFoundPage(origin), 404);
}

async function handleStreams(
  settings: Settings,
  packages: PackageEngine,
  config: AddonConfig,
  encoded: string,
  origin: string,
  type: string,
  id: string,
): Promise<Response> {
  if (type !== "movie" && type !== "series") {
    return errorResponse(400, "unsupported_type", `Unsupported type: ${type}`);
  }

  const parsed = parseStremioId(id);
  if (!parsed) {
    return errorResponse(
      400,
      "unsupported_id",
      "Only IMDb ids are supported. Add a metadata addon that provides tt ids (Cinemeta does).",
    );
  }
  if (type === "series" && (parsed.season === null || parsed.episode === null)) {
    return errorResponse(
      400,
      "missing_episode",
      "A series request must address an episode as tt<id>:<season>:<episode>.",
    );
  }

  // One lookup decides whether any of this is worth doing. It is cached, and it is
  // what makes the "no timings" case a pure pass-through with no wrapping at all.
  const lookup = await lookupSkipWindows(settings, config, id);

  // No key anywhere is not a silent pass-through that looks like "TheIntroDB has no timings
  // for this": it is a configuration the user can fix in one step.
  if (lookup.reason === "missing_api_key") {
    return errorResponse(
      403,
      "missing_api_key",
      "This service has no TheIntroDB API key, so it cannot look up timings. " +
        "Paste one on the configuration page and reinstall (it rides in the install link), " +
        "or set TIDB_API_KEY in this service's environment.",
    );
  }

  const upstream = await fetchStreams(settings, config, type, id);

  const label = `TheIntroDB Skip · ${sourceLabel(upstream.used ?? config.src[0] ?? "")}`;
  const cutSummary = lookup.windows.length > 0 ? `${describeCuts(lookup.windows)}.` : null;

  // Relay whenever there is something to cut -- and also whenever the user asked for
  // proxying, because the reason to proxy is reachability, not cutting: a source that
  // binds its link to the requesting address stops working entirely if the stream is
  // handed over raw. A lookup failure (`403`, a block on this deployment's address,
  // an outage) must therefore cost the cut, not the playback.
  const relay = cutSummary !== null || settings.proxy === true;
  const note = cutSummary ?? "TheIntroDB has no timings for this title yet, so this stream is relayed but not cut.";

  const streams = relay
    ? upstream.streams.map((stream) =>
        wrapStream(stream, {
          playUrl: (target, streamIdentity) => playUrl(origin, encoded, target, id, streamIdentity),
          label,
          cutSummary: note,
          allowPrivateHosts: settings.ALLOW_PRIVATE_HOSTS === "1",
          sourceBase: upstream.used ?? config.src[0] ?? "",
        }),
      )
    : upstream.streams;

  if (cutSummary) {
    // Nothing is cut, probed or packaged here. A stream list is a menu, and the work belongs to
    // the playback that chooses from it (see `handlePlay`): an install that never plays a stream
    // never costs anything, and a list cannot fail because a source was slow.
    void 0;
  }

  return json(
    { streams },
    {
      headers: {
        "x-tidb-source": upstream.used ? sourceLabel(upstream.used) : "none",
        "x-tidb-lookup": lookup.reason,
        "x-tidb-windows": String(lookup.windows.length),
        "x-tidb-upstream-streams": String(upstream.streams.length),
        "x-tidb-cuts": describeWindowsHeader(lookup.windows),
      },
    },
  );
}


function describeWindowsHeader(windows: readonly { type: string; startMs: number; endMs: number | null }[]): string {
  return windows
    .map((window) => `${window.type} ${window.startMs}-${window.endMs ?? "end"}`)
    .join(", ");
}

function decodePathComponent(value: string): string {
  if (!value.includes("%")) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    // A malformed escape is not worth a 500: hand it back and let the id check fail.
    return value;
  }
}

function configPage(
  settings: Settings,
  origin: string,
  packages: PackageEngine,
  extra: { editing?: AddonConfig | null; configError?: string | null } = {},
): Response {
  const url = new URL(origin);
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname);

  return html(
    renderConfigPage({
      origin,
      siteUrl: INTRODB_SITE,
      serverKeyConfigured: Boolean(settings.TIDB_API_KEY && settings.TIDB_API_KEY.trim()),
      insecure: url.protocol === "http:" && local,
      cuts: packages.stats(),
      audioLanguage: settings.subtitlesAudioLanguage,
      editing: extra.editing ?? null,
      configError: extra.configError ?? null,
    }),
    // A page opened with an install URL holds that install, including the API key
    // when it carries one, so it must not sit in any cache. The bare page carries
    // nothing but the deployment's own settings.
    200,
    extra.editing || extra.configError ? { "cache-control": "no-store" } : {},
  );
}

function notFoundPage(origin: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Not found</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font:15px/1.5 system-ui, sans-serif; background:#0b0d0c; color:#e7ece9; margin:0">
<main style="max-width:600px;margin:0 auto;padding:60px 20px">
<h1 style="font-size:20px">Not found</h1>
<p>This is a Stremio addon, not a website. Start at <a style="color:#22c55e" href="${origin}/">${origin}/</a> to build an install link.</p>
</main></body></html>`;
}

/**
 * What `/debug` shows, gathered in one place so the page and the JSON cannot disagree.
 *
 * Nothing secret: `describeSettings` already reports whether a key is configured rather than the
 * key itself, and the drain secret is reported only as "is one required".
 */
async function debugSnapshot(
  origin: string,
  settings: Settings,
  packages: PackageEngine,
  engine: SubtitleEngine,
): Promise<DebugOptions> {
  return {
    origin,
    version: ADDON_VERSION,
    settings: describeSettings(settings),
    subtitles: engine.status(),
    cuts: packages.stats(),
    cache: await cacheReport(settings.cacheDir),
    lastError: diagnostics.lastError,
    drainProtected: Boolean((settings.drainSecret ?? "").trim()),
    drained: null,
  };
}

/**
 * `POST /drain` -- stop everything, wipe the working cache.
 *
 * A new stream test wants a clean process: no ffmpeg still cutting the last title, no track still
 * being recognised, no segments left on disk. The one thing it must not do is delete the speech
 * models, which are minutes of network to fetch again.
 */
async function drainNow(
  request: Request,
  settings: Settings,
  packages: PackageEngine,
  engine: SubtitleEngine,
): Promise<Response> {
  // A header, not a query parameter: a browser will not send a custom header to a form post from
  // another origin, and the preflight does not allow this one, so a drive-by page cannot drain.
  if (request.headers.get("x-tidb-drain") !== "1") {
    return errorResponse(403, "drain_refused", "Draining needs the x-tidb-drain header");
  }
  const secret = (settings.drainSecret ?? "").trim();
  if (secret && request.headers.get("x-tidb-drain-secret") !== secret) {
    return errorResponse(403, "drain_refused", "This deployment requires the drain secret");
  }
  const jobs = engine.drain();
  const stoppedPackages = packages.drain();
  const purged = await purgeCache(settings.cacheDir);
  console.log(
    `  drained        ${jobs} subtitle job(s), ${stoppedPackages} package(s), ${formatBytes(purged.bytes)} deleted`,
  );
  return json({
    stopped: { jobs, packages: stoppedPackages },
    purged: { ...purged, human: formatBytes(purged.bytes) },
    at: new Date().toISOString(),
  });
}
