// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * The Node entry point.
 *
 * The router speaks `Request`/`Response`; this adapts Node's HTTP server to it, so
 * the same handlers would run anywhere the Fetch API exists. It also owns the
 * things a long-running process has and a Worker did not: a real port, a disk
 * cache for generated segments, and a graceful shutdown.
 */

import { createServer, type IncomingMessage } from "node:http";
import { Readable } from "node:stream";

import { PackageEngine } from "./packages.js";
import { SubtitleEngine } from "./subtitles.js";
import { Transcriber } from "./transcribe.js";
import { loadSettings, type Settings } from "./env.js";
import { handleRequest } from "./index.js";
import { ADDON_VERSION } from "./manifest.js";

export function requestUrl(request: IncomingMessage): string {
  const host = request.headers["x-forwarded-host"] ?? request.headers.host ?? "localhost";
  const forwardedProto = request.headers["x-forwarded-proto"];
  const proto =
    typeof forwardedProto === "string" && forwardedProto
      ? forwardedProto.split(",")[0]!.trim()
      : "http";
  const path = request.url ?? "/";
  return `${proto}://${host}${path}`;
}

export function createApp(
  settings: Settings,
  packages: PackageEngine,
  subtitles: SubtitleEngine | null = null,
) {
  return createServer((nodeRequest, nodeResponse) => {
    void (async () => {
      try {
        // This addon is read-only, so a request body is never forwarded.
        const request = new Request(requestUrl(nodeRequest), {
          method: nodeRequest.method,
          headers: nodeRequest.headers as Record<string, string>,
        });

        const response = await handleRequest(request, settings, packages);

        const headers: Record<string, string | string[]> = {};
        response.headers.forEach((value, name) => {
          headers[name] = value;
        });
        nodeResponse.writeHead(response.status, headers);

        if (response.body) {
          Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]).pipe(
            nodeResponse,
          );
        } else {
          nodeResponse.end();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("request failed:", message);
        if (!nodeResponse.headersSent) {
          nodeResponse.writeHead(500, { "content-type": "application/json" });
        }
        nodeResponse.end(JSON.stringify({ error: "internal_error", code: "internal_error" }));
      }
    })();
  });
}

export async function main(): Promise<void> {
  const settings = loadSettings();
  const packages = new PackageEngine(settings);
  // One transcriber and one engine for the process: the speech models are loaded once and kept,
  // and the tracks they produce outlive any single request.
  const subtitles = new SubtitleEngine(settings, new Transcriber(settings));
  const packageStatus = await packages.start();

  const server = createApp(settings, packages, subtitles);
  server.listen(settings.port, () => {
    const base = `http://localhost:${settings.port}`;
    console.log(`TheIntroDB Stremio addon v${ADDON_VERSION}`);
    console.log(`  listening      ${base}`);
    console.log(`  config page    ${base}/`);
    console.log(`  health         ${base}/health`);
    console.log(
      `  api key        ${(settings.TIDB_API_KEY ?? "").trim() ? "configured" : "MISSING - lookups will refuse with 403"}`,
    );
    console.log(
      `  cutting        ${settings.cuts}${settings.cuts === "off" ? "" : ` (${settings.cacheDir}, max ${Math.round(settings.cacheMaxBytes / 1024 ** 3)} GB, ${settings.cutConcurrency} at a time)`}`,
    );
    console.log(`  ffmpeg         ${packageStatus.detail}`);
    if (!packageStatus.ok) {
      console.warn("  warning        files play uncut until the line above is fixed");
    }
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      console.log(`${signal} received, closing`);
      server.close(() => process.exit(0));
      // A long remux should not hold the process open forever.
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ""));
if (isMain) {
  void main();
}
