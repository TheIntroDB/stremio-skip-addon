// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/** Response helpers: the addon transport is HTTP JSON + playlist text, read cross-origin. */

export const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "Origin, Content-Type, Accept, Authorization, Range",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
};

export function corsPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: { ...CORS_HEADERS, "access-control-max-age": "86400" },
  });
}

export function json(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/json; charset=utf-8",
      // Addon responses are per-config and short-lived; never let a CDN hold them.
      "cache-control": "no-store",
      ...init.headers,
    },
  });
}

export function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

export function text(
  body: string,
  init: { status?: number; contentType?: string; headers?: Record<string, string> } = {},
): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: {
      ...CORS_HEADERS,
      "content-type": init.contentType ?? "text/plain; charset=utf-8",
      ...init.headers,
    },
  });
}

/** A playlist, served with the CORS and cache headers a player needs. */
export function playlist(
  body: string,
  extraHeaders: Record<string, string>,
  maxAgeSeconds = 300,
): Response {
  return new Response(body, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/vnd.apple.mpegurl",
      "cache-control": `public, max-age=${maxAgeSeconds}`,
      ...extraHeaders,
    },
  });
}

/** Send the player to the origin URL unchanged (non-HLS sources, or any failure). */
export function redirectTo(target: string, reason: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      ...CORS_HEADERS,
      location: target,
      "cache-control": "no-store",
      "x-tidb-play": reason,
    },
  });
}

export function errorResponse(status: number, code: string, message: string): Response {
  return json({ error: message, code }, { status });
}
