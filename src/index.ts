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
 *
 * Every request after install carries the config as the first path segment, which
 * is the only place a Stremio addon can keep per-user settings.
 */

import { decodeConfig, parseStremioId } from "./config.js";
import { INTRODB_API_BASE, INTRODB_API_VERSION, INTRODB_SITE } from "./constants.js";
import type { CutEngine } from "./cut.js";
import { describeSettings, type Settings } from "./env.js";
import { describeCuts } from "./format.js";
import { corsPreflight, errorResponse, html, json, text } from "./http.js";
import { lastLookupFailure, lookupSkipWindows } from "./introdb.js";
import { ADDON_VERSION, buildManifest } from "./manifest.js";
import { renderConfigPage } from "./page.js";
import { handlePlay, handleSegment } from "./play.js";
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

const CONFIG_ROUTE_RE =
  /^\/([A-Za-z0-9_-]{1,4096})(?:\/(manifest\.json|stream\/[^/]+\/[^/]+\.json|play|seg))?$/;

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
  cuts: CutEngine,
): Promise<Response> {
  const url = new URL(request.url);
  const origin = url.origin;
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (request.method === "OPTIONS") return corsPreflight();
  if (request.method === "POST") {
    return errorResponse(405, "method_not_allowed", "This addon is read-only");
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorResponse(405, "method_not_allowed", "Only GET and HEAD are supported");
  }

  if (path === "/" || path === "/configure") return configPage(settings, origin, cuts);
  if (path === "/health") {
    return json({
      status: "ok",
      name: "TheIntroDB Skip",
      version: ADDON_VERSION,
      site: INTRODB_SITE,
      api: `${INTRODB_API_BASE}/${INTRODB_API_VERSION}/media`,
      ...describeSettings(settings),
      lastLookupFailure: lastLookupFailure(),
      cutsStatus: cuts.stats(),
    });
  }
  if (path === "/robots.txt") return text("User-agent: *\nDisallow: /\n");
  if (path === "/manifest.json") return json(buildManifest(null));

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
      return configPage(settings, origin, cuts, {
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
      return handlePlay({ request, settings, cuts, config, encodedConfig: encoded, origin });
    }
    if (route === "seg") {
      return handleSegment({ request, settings, cuts, config, encodedConfig: encoded, origin });
    }

    // stream/<type>/<id>.json
    const streamMatch = /^stream\/([^/]+)\/(.+)\.json$/.exec(route);
    if (streamMatch) {
      return handleStreams(settings, cuts, config, encoded, origin, streamMatch[1]!, streamMatch[2]!);
    }
  }

  if (path.includes(".")) return errorResponse(404, "not_found", "Not found");
  return html(notFoundPage(origin), 404);
}

async function handleStreams(
  settings: Settings,
  cuts: CutEngine,
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

  // The key is required, so a deployment without one gets a loud answer rather than
  // a silent pass-through that looks like "TheIntroDB has no timings for this".
  if (lookup.reason === "missing_api_key") {
    return errorResponse(
      403,
      "missing_api_key",
      "This service has no TheIntroDB API key, so it cannot look up timings. " +
        "Set TIDB_API_KEY in the environment (or add one on the configuration page), then reinstall.",
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
  const relay = cutSummary !== null || config.proxy === true;
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
    preCut(settings, cuts, upstream, config, lookup.windows);
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

/**
 * Warm the cut cache for the sources a player is most likely to pick.
 *
 * A cut of a feature takes a while (it copies the whole file once), and the stream
 * list is fetched moments before playback, so this is a head start rather than a
 * guarantee: the first playback may still be handed the original.
 */
function preCut(
  settings: Settings,
  cuts: CutEngine,
  upstream: { streams: Array<Record<string, unknown>>; used?: string },
  config: AddonConfig,
  windows: Parameters<CutEngine["schedule"]>[1],
): void {
  if (!cuts.enabled || windows.length === 0) return;
  const limit = settings.precutSources;
  if (limit <= 0) return;
  const sourceBase = upstream.used ?? config.src[0] ?? "";
  let scheduled = 0;
  for (const stream of upstream.streams) {
    if (scheduled >= limit) break;
    const target = resolveTarget(stream.url, sourceBase);
    if (!target || !isFetchableByWorker(target, settings.ALLOW_PRIVATE_HOSTS === "1")) continue;
    // The same identity the play URL carries, so the head start warms the cut the
    // player will look up.
    cuts.schedule(target, windows, streamIdentity(stream, sourceBase, target));
    scheduled++;
  }
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
  cuts: CutEngine,
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
      cuts: cuts.stats(),
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
