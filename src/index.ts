// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * The Worker entry point and router.
 *
 * Routes:
 *
 *   GET /                                  the configuration page
 *   GET /health                            liveness + which API it talks to
 *   GET /manifest.json                     manifest for a bare install (needs configuring)
 *   GET /<config>/manifest.json            manifest for an install
 *   GET /<config>/stream/{movie,series}/<id>.json
 *                                          the stream list, relayed from the source addon
 *   GET /<config>/play?u=&id=              one playlist, spliced
 *   GET /<config>/seg?u=                   one media resource (opt-in proxy mode)
 *
 * Every request after install carries the config as the first path segment, which
 * is the only place a Stremio addon can keep per-user settings.
 */

import { decodeConfig, parseStremioId } from "./config.js";
import { INTRODB_API_BASE, INTRODB_API_VERSION, INTRODB_SITE } from "./constants.js";
import { describeCuts } from "./format.js";
import { corsPreflight, errorResponse, html, json, text } from "./http.js";
import { lookupSkipWindows } from "./introdb.js";
import { ADDON_VERSION, buildManifest } from "./manifest.js";
import { renderConfigPage } from "./page.js";
import { handlePlay, handleSegment } from "./play.js";
import type { AddonConfig, Env } from "./types.js";
import { fetchStreams, sourceLabel, wrapStream } from "./upstream.js";
import { playUrl } from "./urls.js";

const CONFIG_ROUTE_RE =
  /^\/([A-Za-z0-9_-]{1,4096})\/(manifest\.json|stream\/[^/]+\/[^/]+\.json|play|seg)$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const origin = url.origin;
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (request.method === "OPTIONS") return corsPreflight();
  if (request.method === "POST") return errorResponse(405, "method_not_allowed", "This addon is read-only");
  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorResponse(405, "method_not_allowed", "Only GET and HEAD are supported");
  }

  if (path === "/") return configPage(env, origin);
  if (path === "/configure") return configPage(env, origin);
  if (path === "/health") {
    return json({
      status: "ok",
      name: "TheIntroDB Skip",
      version: ADDON_VERSION,
      api: `${INTRODB_API_BASE}/${INTRODB_API_VERSION}/media`,
      site: INTRODB_SITE,
      apiKeyConfigured: Boolean(env.TIDB_API_KEY && env.TIDB_API_KEY.trim()),
    });
  }
  if (path === "/robots.txt") return text("User-agent: *\nDisallow: /\n");
  if (path === "/manifest.json") {
    return json(buildManifest(null));
  }

  const match = CONFIG_ROUTE_RE.exec(path);
  if (match) {
    // Stremio percent-encodes every path component, so an episode arrives as
    // `tt0903747%3A1%3A1.json` (Stremio Core: utf8_percent_encode with
    // URI_COMPONENT_ENCODE_SET). Decode before anything looks at the id.
    const encoded = decodePathComponent(match[1]!);
    const route = decodePathComponent(match[2]!);
    const config = decodeConfig(encoded);
    if (!config) {
      return errorResponse(
        400,
        "invalid_config",
        "That configuration is not readable. Re-generate the install link from the addon's own page.",
      );
    }

    if (route === "manifest.json") {
      return json(buildManifest(config, encoded));
    }
    if (route === "play") {
      return handlePlay({ request, env, config, encodedConfig: encoded, origin });
    }
    if (route === "seg") {
      return handleSegment({ request, env, config, encodedConfig: encoded, origin });
    }

    // stream/<type>/<id>.json
    const streamMatch = /^stream\/([^/]+)\/(.+)\.json$/.exec(route);
    if (streamMatch) {
      return handleStreams(env, config, encoded, origin, streamMatch[1]!, streamMatch[2]!);
    }
  }

  if (path.includes(".")) {
    return errorResponse(404, "not_found", "Not found");
  }
  return html(notFoundPage(origin), 404);
}

async function handleStreams(
  env: Env,
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
  const lookup = await lookupSkipWindows(env, config, id);

  // The key is required, so a deployment without one gets a loud answer rather than
  // a silent pass-through that looks like "TheIntroDB has no timings for this".
  if (lookup.reason === "missing_api_key") {
    return errorResponse(
      403,
      "missing_api_key",
      "This deployment has no TheIntroDB API key, so it cannot look up timings. " +
        "Set TIDB_API_KEY as a Worker secret (npx wrangler secret put TIDB_API_KEY) " +
        "or add a key on the addon's configuration page, then reinstall.",
    );
  }

  const upstream = await fetchStreams(env, config, type, id);

  const label = `TheIntroDB Skip · ${sourceLabel(upstream.used ?? config.src[0] ?? "")}`;
  const cutSummary = lookup.windows.length > 0 ? `${describeCuts(lookup.windows)}.` : null;

  const streams = cutSummary
    ? upstream.streams.map((stream) =>
        wrapStream(stream, {
          playUrl: (target) => playUrl(origin, encoded, target, id),
          label,
          cutSummary,
          allowPrivateHosts: env.ALLOW_PRIVATE_HOSTS === "1",
          sourceBase: upstream.used ?? config.src[0] ?? "",
        }),
      )
    : upstream.streams;

  return json(
    { streams },
    {
      headers: {
        "x-tidb-source": upstream.used ? sourceLabel(upstream.used) : "none",
        "x-tidb-lookup": lookup.reason,
        "x-tidb-windows": String(lookup.windows.length),
        "x-tidb-upstream-streams": String(upstream.streams.length),
      },
    },
  );
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

function configPage(env: Env, origin: string): Response {
  const url = new URL(origin);
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname);

  return html(
    renderConfigPage({
      origin,
      siteUrl: INTRODB_SITE,
      serverKeyConfigured: Boolean(env.TIDB_API_KEY && env.TIDB_API_KEY.trim()),
      insecure: url.protocol === "http:" && local,
    }),
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
