// Drives the real cut engine against a real source URL, with a kept range small
// enough for this sandbox (the whole episode does not fit in 4 GB of free disk).
//
//   DEBRID_URL='https://...' CACHE_DIR=/tmp/engine-cache \
//     node --import tsx /opt/data/tmp/e2e-cut-engine.ts
//
// The URL carries a debrid token, so it stays in the environment and never in a
// file inside the repository.

import { stat } from "node:fs/promises";
import { CutEngine, run } from "./src/cut.ts";
import type { Settings } from "./src/env.ts";

const url = process.env.DEBRID_URL;
if (!url) throw new Error("set DEBRID_URL");

const settings: Settings = {
  TIDB_API_KEY: "unused-here",
  ALLOW_PRIVATE_HOSTS: "1",
  port: 0,
  cacheDir: process.env.CACHE_DIR ?? "/tmp/engine-cache",
  cacheMaxBytes: 3 * 1024 ** 3,
  cuts: "blocking",
  cutWaitSeconds: 600,
  cutConcurrency: 1,
  ffmpegPath: "ffmpeg",
  ffprobePath: "ffprobe",
};

const cuts = new CutEngine(settings);
const started = await cuts.start();
console.log("start:", started.ok, "-", started.detail);

// Keep only the first 60 s: the credits window runs to the end of the file, which
// is exactly the shape a real lookup produces for an episode whose credits close
// it out. The copy that follows is therefore ~100 MB instead of 4 GB.
const windows = [{ type: "credits" as const, startMs: 60_000, endMs: null }];
const key = cuts.keyFor(url, windows);
console.log("key:", key);

const begin = Date.now();
cuts.schedule(url, windows);
const file = await cuts.waitFor(key, 900_000);
const state = cuts.state(key);
console.log(`state: ${state?.status} in ${((Date.now() - begin) / 1000).toFixed(1)}s`);
console.log("detail:", JSON.stringify({ container: state?.container, bytes: state?.bytes, durationMs: state?.durationMs, error: state?.error }));

if (!file) {
  console.log("NO FILE WAS PRODUCED");
  process.exit(1);
}

const info = await stat(file);
const probe = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration,format_name", "-of", "json", file], 60_000);
console.log("cut file:", file);
console.log(`size: ${info.size} bytes (${(info.size / 1024 ** 2).toFixed(1)} MB)`);
console.log("probe:", probe.stdout.trim().replace(/\s+/g, " "));

// And the cache is reusable: a second ask for the same cut is the same file, with
// no second ffmpeg run.
const again = await cuts.waitFor(key, 5_000);
console.log("cache hit on the second ask:", again === file);
