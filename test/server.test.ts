// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * The Node adapter, on a real port.
 *
 * These tests start the actual server and talk to it with `fetch`, which is what
 * exercises the parts a Worker never had: building the request URL from the
 * Host/`X-Forwarded-Proto` headers, streaming a body out of Node, and the boot
 * path that verifies ffmpeg.
 */

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { PackageEngine } from "../src/packages.js";
import type { Settings } from "../src/env.js";
import { createApp } from "../src/server.js";

let workDir: string;
let base = "";
let server: ReturnType<typeof createApp>;

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    TIDB_API_KEY: "test-key",
    ALLOW_PRIVATE_HOSTS: "1",
    port: 0,
    cacheDir: path.join(workDir, "cache"),
    cacheMaxBytes: 0,
    proxy: true,
    subtitles: false,
    subtitlesLanguage: "en",
    subtitlesChunkSeconds: 300,
  subtitlesTtlHours: 24,
  subtitlesIdleSeconds: 120,
  subtitlesAudioLanguage: "en",
  drainSecret: "",
    skipMarginSeconds: 0,
    splash: false,
    prerollSeconds: 10,
    cutWaitSeconds: 0,
    cutConcurrency: 1,
    precutSources: 2,
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
    ...overrides,
  };
}

before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "tidb-server-"));
  const settingsValue = settings();
  const packages = new PackageEngine(settingsValue);
  await packages.start();
  server = createApp(settingsValue, packages);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(workDir, { recursive: true, force: true });
});

test("health answers over a real socket", async () => {
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.status, "ok");
  assert.equal(body.apiKeyConfigured, true);
  assert.equal(body.cuts, undefined, "no deployment-wide cutting mode: the install picks");
});

test("the config page is served, and uses the forwarded host and scheme", async () => {
  const response = await fetch(`${base}/`, {
    headers: { "x-forwarded-host": "addon.example.com", "x-forwarded-proto": "https" },
  });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(html.includes("TheIntroDB Skip"));
  // The install links are built from the request origin, so a reverse proxy or a
  // platform domain must be reflected rather than the local socket.
  assert.ok(html.includes('"origin":"https://addon.example.com"'), "origin taken from x-forwarded-*");
});

test("a bare manifest is served with CORS", async () => {
  const response = await fetch(`${base}/manifest.json`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  const manifest = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(manifest.resources, ["stream"], "a stream addon, and nothing else");
  assert.ok(String(manifest.logo).includes("theintrodb-assets"));
});

test("the router's 405 for POST survives the adapter", async () => {
  const response = await fetch(`${base}/health`, { method: "POST" });
  assert.equal(response.status, 405);
  const body = (await response.json()) as { code: string };
  assert.equal(body.code, "method_not_allowed");
});

test("an unknown path returns the not-found page", async () => {
  const response = await fetch(`${base}/nope`);
  assert.equal(response.status, 404);
  assert.ok((await response.text()).includes("build an install link"));
});

test("a real request that needs an upstream still answers", async () => {
  // No config segment is valid here, so the router refuses the id before it goes
  // anywhere: the point is that the adapter returns a parsed JSON error rather
  // than an empty socket.
  const response = await fetch(`${base}/stream/movie/tt0111161.json`);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("content-type")?.startsWith("application/json"), true);
});
