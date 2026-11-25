// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * Cut one real source URL, with the real engine, and report what happened.
 *
 * The unit tests generate their own video, which proves the engine works but not
 * that it works on *your* source. This is the check for that: hand it a URL the way
 * your source addon would (a debrid link, a direct file) and it will probe, copy
 * and cache exactly as a playback would.
 *
 *   npm run verify:cut -- 'https://example.com/episode.mkv'
 *   npm run verify:cut -- 'https://example.com/episode.mkv' 120   # keep 120s only
 *
 * The second argument bounds the copy: it is treated as the start of the window, so
 * only that much of the file is kept. A full episode is several gigabytes, and this
 * is usually run over something slower than the host's own disk. Keep the URL out of
 * your shell history if it carries a token (`HISTCONTROL=ignorespace` and a leading
 * space, or the `DEBRID_URL` environment variable).
 */

import { stat } from "node:fs/promises";

import { CutEngine, run } from "../src/cut.js";
import type { Settings } from "../src/env.js";

const url = process.argv[2] ?? process.env.DEBRID_URL;
if (!url) {
  console.error("usage: npm run verify:cut -- <source-url> [keep-seconds]");
  process.exit(2);
}
const keepSeconds = Number(process.argv[3] ?? process.env.KEEP_SECONDS ?? 60);
if (!Number.isFinite(keepSeconds) || keepSeconds < 1) {
  console.error("the second argument is how many seconds to keep, as a number");
  process.exit(2);
}

const settings: Settings = {
  TIDB_API_KEY: process.env.TIDB_API_KEY ?? "",
  ALLOW_PRIVATE_HOSTS: process.env.ALLOW_PRIVATE_HOSTS ?? "1",
  port: 0,
  cacheDir: process.env.CACHE_DIR ?? "./cache",
  cacheMaxBytes: Number(process.env.CACHE_MAX_GB ?? 3) * 1024 ** 3,
  cuts: "blocking",
  cutWaitSeconds: 600,
  cutConcurrency: 1,
  precutSources: 0,
  ffmpegPath: process.env.FFMPEG_PATH ?? "ffmpeg",
  ffprobePath: process.env.FFPROBE_PATH ?? "ffprobe",
};

const cuts = new CutEngine(settings);
const started = await cuts.start();
console.log("ffmpeg:", started.ok ? started.detail : `NOT AVAILABLE - ${started.detail}`);
if (!started.ok) process.exit(1);

// A window that runs to the end of the file is the shape a lookup produces for
// credits, so the kept range is everything before it and the copy stays small.
const windows = [{ type: "credits" as const, startMs: Math.round(keepSeconds * 1000), endMs: null }];
const key = cuts.keyFor(url, windows);

const begin = Date.now();
cuts.schedule(url, windows);
const file = await cuts.waitFor(key, 900_000);
const state = cuts.state(key);
console.log(`cut: ${state?.status} after ${((Date.now() - begin) / 1000).toFixed(1)}s`);
console.log("state:", JSON.stringify({ container: state?.container, bytes: state?.bytes, durationMs: state?.durationMs, error: state?.error }));

if (!file) {
  console.error("no cut file was produced");
  process.exit(1);
}

const info = await stat(file);
const probe = await run(
  settings.ffprobePath,
  ["-v", "error", "-show_entries", "format=duration,format_name", "-of", "json", file],
  60_000,
);
console.log("file:", file);
console.log(`size: ${info.size} bytes (${(info.size / 1024 ** 2).toFixed(1)} MB)`);
console.log("probe:", probe.stdout.trim().replace(/\s+/g, " "));

// A second ask must be the cache, not another remux.
const again = await cuts.waitFor(key, 5_000);
console.log("served from cache on the second ask:", again === file);
