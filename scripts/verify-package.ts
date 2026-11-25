// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * Package one source of your own and report what came out.
 *
 *   npm run verify:package -- 'https://…/episode.mkv'            # skip 60-90s
 *   npm run verify:package -- 'https://…/episode.mkv' 735 765    # skip 735-765s
 *
 * The two numbers it exists to answer: how long the first segment took (what a player
 * waits before it can start) and how much of the window survived the keyframe grid.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Settings } from "../src/env.js";
import { run } from "../src/ffmpeg.js";
import { PackageEngine } from "../src/packages.js";

const [url, startArg, endArg] = process.argv.slice(2);
if (!url) {
  console.error(
    "usage: npm run verify:package -- <url> [startSeconds [endSeconds]]",
  );
  process.exit(2);
}

const startMs = startArg ? Math.round(Number(startArg) * 1000) : 60_000;
const endMs = endArg ? Math.round(Number(endArg) * 1000) : startMs + 30_000;
const window = { type: "intro" as const, startMs, endMs };

const cacheDir = await mkdtemp(path.join(tmpdir(), "tidb-verify-"));
const settings: Settings = {
  TIDB_API_KEY: "verify",
  ALLOW_PRIVATE_HOSTS: "1",
  port: 0,
  cacheDir,
  cacheMaxBytes: 10 * 1024 ** 3,
  skipMarginSeconds: 3,
  proxy: true,
subtitles: false,
subtitlesLanguage: "en",
subtitlesChunkSeconds: 300,
subtitlesTtlHours: 24,
subtitlesIdleSeconds: 120,
subtitlesAudioLanguage: "en",
  splash: true,
  prerollSeconds: 10,
  cutWaitSeconds: 120,
  cutConcurrency: 1,
  precutSources: 0,
  ffmpegPath: "ffmpeg",
  ffprobePath: "ffprobe",
};

const engine = new PackageEngine(settings);
const status = await engine.start();
console.log(`ffmpeg        ${status.detail}`);
console.log(`skipping      ${(startMs / 1000).toFixed(1)}s-${(endMs / 1000).toFixed(1)}s`);

const key = engine.keyFor(url, [window], "verify");
const started = Date.now();
engine.schedule(url, [window], "verify");

const first = await engine.waitForFirstSegment(key, 180_000);
if (!first) {
  console.error(`no segment: ${JSON.stringify(engine.state(key), null, 2)}`);
  process.exit(1);
}
console.log(
  `first segment ${((Date.now() - started) / 1000).toFixed(1)}s ` +
    `(${first.segments} segments, ${(first.durationMs / 1000).toFixed(1)}s of video) ` +
    "— this is what a player waits for",
);

const deadline = Date.now() + 30 * 60_000;
let view = first;
while (!view.complete && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  view = (await engine.manifest(key)) ?? view;
}
if (!view.complete) {
  console.error("the package never finished");
  process.exit(1);
}
console.log(
  `finished in   ${((Date.now() - started) / 1000).toFixed(1)}s: ` +
    `${view.segments} segments, ${(view.durationMs / 1000).toFixed(1)}s of video`,
);

const state = engine.state(key);
console.log(`bytes         ${state?.bytes ?? "?"}`);
if (state?.error) console.log(`last error    ${state.error}`);

// The playlist a player would get, minus the round trip.
const dir = path.join(cacheDir, "hls", key);
await writeFile(path.join(dir, "index.m3u8"), view.body.replaceAll(`seg?f=${key}/`, ""));
const probe = await run("ffprobe", [
  "-v", "error",
  "-show_entries", "format=duration,format_name",
  "-of", "default=nw=1",
  path.join(dir, "index.m3u8"),
], 120_000);
console.log(`playlist      ${probe.stdout.trim().split("\n").join(", ")}`);
const decode = await run("ffmpeg", ["-v", "error", "-i", path.join(dir, "index.m3u8"), "-f", "null", "-"], 30 * 60_000);
console.log(`decodes       ${decode.code === 0 && !decode.stderr.trim() ? "yes, end to end" : `no: ${decode.stderr.slice(-300)}`}`);

console.log("\n--- the playlist it serves ---");
console.log(view.body.split("\n").slice(0, 24).join("\n"));
console.log(`... ${view.segments} segments`);
