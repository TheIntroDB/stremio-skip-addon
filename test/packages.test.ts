// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * The package engine, exercised against real ffmpeg and a real 30-second file.
 *
 * The property these tests care about most is the one a player notices: a playlist
 * exists and is playable long before the file has been packaged, and what it lists is
 * the stretches that survive the windows.
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import type { Settings } from "../src/env.js";
import { hasRoomFor, keptRanges, run } from "../src/ffmpeg.js";
import { PackageEngine } from "../src/packages.js";

const SAMPLE_SECONDS = 30;
const LONG_SECONDS = 180;
const INTRO = { type: "intro" as const, startMs: 10_000, endMs: 13_000 };
/** Sent slowly, the way a debrid link behaves when a player gives up on it. */
const THROTTLE_CHUNK = 16 * 1024;
const THROTTLE_MS = 40;

let workDir: string;
let samplePath: string;
let longPath: string;
let server: Server;
let base = "";

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    TIDB_API_KEY: "test-key",
    ALLOW_PRIVATE_HOSTS: "1",
    port: 0,
    cacheDir: path.join(workDir, "cache"),
    cacheMaxBytes: 10 * 1024 ** 3,
    proxy: true,
    subtitles: false,
    subtitlesLanguage: "en",
    subtitlesChunkSeconds: 300,
  subtitlesTtlHours: 24,
    skipMarginSeconds: 0,
    splash: false,
    prerollSeconds: 10,
    cutWaitSeconds: 60,
    cutConcurrency: 2,
    precutSources: 2,
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
    ...overrides,
  };
}

/** Probe a media file (or a playlist) for its duration in ms. */
async function durationOf(file: string): Promise<number> {
  const result = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=nw=1:nk=1",
    file,
  ], 60_000);
  assert.equal(result.code, 0, `ffprobe failed: ${result.stderr}`);
  return Math.round(Number(result.stdout.trim()) * 1000);
}

/** The first video timestamp in a file, in seconds: what a demuxer sees first. */
async function firstVideoPts(file: string): Promise<number> {
  const result = await run("ffprobe", [
    "-v", "error", "-select_streams", "v",
    "-show_entries", "packet=pts_time", "-of", "csv=p=0", file,
  ], 60_000);
  const first = Number(result.stdout.split("\n")[0]?.replace(",", "").trim());
  assert.ok(Number.isFinite(first), `no timestamp in ${file}: ${result.stdout} ${result.stderr}`);
  return first;
}

/** Decode a playlist end to end, the way a player would. */
async function decodes(file: string): Promise<string> {
  const result = await run("ffmpeg", ["-v", "error", "-i", file, "-f", "null", "-"], 120_000);
  return result.stderr;
}

before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "tidb-package-"));
  samplePath = path.join(workDir, "sample.mkv");

  // 30 seconds of something predictable, in Matroska, with a keyframe every second.
  const generated = await run("ffmpeg", [
    "-nostdin", "-hide_banner", "-v", "error",
    "-f", "lavfi", "-i", `testsrc=size=320x240:rate=10:duration=${SAMPLE_SECONDS}`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${SAMPLE_SECONDS}`,
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-g", "10",
    "-c:a", "aac", "-b:a", "64k",
    "-y", samplePath,
  ], 120_000);
  assert.equal(generated.code, 0, `could not generate the sample: ${generated.stderr}`);

  // Three minutes of the same thing, in a file small enough to generate quickly but
  // served slowly: packaging it then takes long enough that "a playlist is ready
  // before the file is" is an interval rather than a race.
  longPath = path.join(workDir, "long.mkv");
  const long = await run("ffmpeg", [
    "-nostdin", "-hide_banner", "-v", "error",
    "-f", "lavfi", "-i", `testsrc=size=160x120:rate=5:duration=${LONG_SECONDS}`,
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "35", "-g", "5",
    "-y", longPath,
  ], 300_000);
  assert.equal(long.code, 0, `could not generate the long sample: ${long.stderr}`);

  // Serve it the way a CDN does: byte ranges, 206.
  server = createServer((request, response) => {
    void (async () => {
      if (request.url === "/master.m3u8") {
        const body =
          "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:31\n" +
          `#EXTINF:30.0,\nhttp://127.0.0.1:${(server.address() as AddressInfo).port}/sample.mkv\n` +
          "#EXT-X-ENDLIST\n";
        response.writeHead(200, {
          "content-type": "application/vnd.apple.mpegurl",
          "content-length": String(Buffer.byteLength(body)),
        });
        response.end(body);
        return;
      }
      const long = request.url === "/long.mkv";
      const file = await readFile(long ? longPath : samplePath);
      const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? "");
      if (range) {
        const start = range[1] ? Number(range[1]) : 0;
        const end = range[2] ? Number(range[2]) : file.length - 1;
        response.writeHead(206, {
          "content-type": "video/x-matroska",
          "content-range": `bytes ${start}-${end}/${file.length}`,
          "content-length": String(end - start + 1),
          "accept-ranges": "bytes",
        });
        if (long) {
          // Dribbled out, so a whole-file read takes seconds: exactly the situation
          // that used to leave a player watching a spinner.
          for (let at = start; at <= end; at += THROTTLE_CHUNK) {
            response.write(file.subarray(at, Math.min(at + THROTTLE_CHUNK, end + 1)));
            await new Promise((resolve) => setTimeout(resolve, THROTTLE_MS));
          }
          response.end();
          return;
        }
        response.end(file.subarray(start, end + 1));
        return;
      }
      response.writeHead(200, {
        "content-type": "video/x-matroska",
        "content-length": String(file.length),
        "accept-ranges": "bytes",
      });
      response.end(file);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- what survives

test("no windows keeps the whole file", () => {
  assert.deepEqual(keptRanges([], 30_000), [{ startMs: 0, endMs: 30_000 }]);
});

test("a window in the middle leaves the head and the tail", () => {
  assert.deepEqual(keptRanges([INTRO], 30_000), [
    { startMs: 0, endMs: 10_000 },
    { startMs: 13_000, endMs: 30_000 },
  ]);
});

test("a null end runs to the end of the file", () => {
  const credits = { type: "credits" as const, startMs: 20_000, endMs: null };
  assert.deepEqual(keptRanges([credits], 30_000), [{ startMs: 0, endMs: 20_000 }]);
});

test("a window covering everything leaves nothing to serve", () => {
  const all = { type: "preview" as const, startMs: 0, endMs: 30_000 };
  assert.deepEqual(keptRanges([all], 30_000), []);
});

test("slivers shorter than half a second are dropped rather than cut", () => {
  const almostAll = { type: "recap" as const, startMs: 200, endMs: 30_000 };
  assert.deepEqual(keptRanges([almostAll], 30_000), []);
});

test("a window that starts past the end of the file is not in this file", () => {
  const late = { type: "credits" as const, startMs: 90_000, endMs: null };
  assert.deepEqual(keptRanges([late], 30_000), [{ startMs: 0, endMs: 30_000 }]);
});

test("a window that runs past the end of the file is clipped", () => {
  const late = { type: "credits" as const, startMs: 25_000, endMs: 90_000 };
  assert.deepEqual(keptRanges([late], 30_000), [{ startMs: 0, endMs: 25_000 }]);
});

test("windows in order leave the pieces between them", () => {
  const windows = [
    { type: "intro" as const, startMs: 5_000, endMs: 8_000 },
    { type: "recap" as const, startMs: 12_000, endMs: 14_000 },
    { type: "credits" as const, startMs: 25_000, endMs: null },
  ];
  assert.deepEqual(keptRanges(windows, 30_000), [
    { startMs: 0, endMs: 5_000 },
    { startMs: 8_000, endMs: 12_000 },
    { startMs: 14_000, endMs: 25_000 },
  ]);
});

test("a copy is refused when the source does not fit on the disk", () => {
  assert.equal(hasRoomFor(10 * 1024 ** 3, 10 * 1024 ** 3), false);
  assert.equal(hasRoomFor(5 * 1024 ** 3, 10 * 1024 ** 3), true);
  // A debrid link that reports no size is allowed through: refusing those would
  // remove the feature from the sources that need it most.
  assert.equal(hasRoomFor(null, 1), true);
});

// ---------------------------------------------------------------- identity

test("a stream identity keeps a package findable when the source re-mints its link", () => {
  const engine = new PackageEngine(settings());
  const withIdentity = engine.keyFor(`${base}/playback/abc?token=1`, [INTRO], "stream:tt0903747:1:1");
  const reMinted = engine.keyFor(`${base}/playback/abc?token=2`, [INTRO], "stream:tt0903747:1:1");
  const withoutIdentity = engine.keyFor(`${base}/playback/abc?token=1`, [INTRO]);
  const alsoWithout = engine.keyFor(`${base}/playback/abc?token=2`, [INTRO]);

  assert.equal(withIdentity, reMinted, "the same stream, a new token, still one package");
  assert.equal(withoutIdentity, alsoWithout, "without an identity, the path is the fallback");
  // The same file with different windows is a different package.
  const other = { type: "recap" as const, startMs: 0, endMs: 4_000 };
  assert.notEqual(engine.keyFor(base, [INTRO]), engine.keyFor(base, [other]));
});

// ---------------------------------------------------------------- the engine

test("the engine reports ffmpeg as available", async () => {
  const engine = new PackageEngine(settings());
  const status = await engine.start();
  assert.equal(status.ok, true, status.detail);
  assert.equal(engine.enabled, true);
});

test("a deployment with no usable ffmpeg reports the engine off, so files pass through", async () => {
  // The cutting mode is the install's choice, so the engine cannot be switched off from the
  // environment any more -- but a host without ffmpeg still has to say so rather than fail
  // the first person who plays a `.mkv`.
  const engine = new PackageEngine(settings({ ffmpegPath: path.join(workDir, "no-such-ffmpeg") }));
  const status = await engine.start();
  assert.equal(status.ok, false);
  assert.match(status.detail, /not runnable/);
  assert.equal(engine.enabled, false);
});

test("a playlist is playable long before the file has been packaged", async () => {
  // This is the whole point of the design: the player is handed a playable playlist
  // after the first segment, not after the file. Served slowly, so the difference is
  // visible rather than a race.
  const engine = new PackageEngine(settings({ cacheDir: path.join(workDir, "cache-early") }));
  await engine.start();
  const window = { type: "intro" as const, startMs: 60_000, endMs: 63_000 };
  const url = `${base}/long.mkv`;
  const key = engine.keyFor(url, [window], "stream:early");
  engine.schedule(url, [window], "stream:early", LONG_SECONDS * 1000);

  const started = Date.now();
  const first = await engine.waitForFirstSegment(key, 120_000);
  const latency = Date.now() - started;
  assert.ok(first, "a first segment arrived inside the window");
  assert.ok(first.segments >= 1);
  assert.ok(first.body.includes(`seg?f=${key}/`), "segments come back to this service");
  assert.ok(first.body.includes("#EXT-X-DISCONTINUITY"), "the stretches are joined across the gap");
  assert.ok(
    first.durationMs > 0 && first.durationMs < LONG_SECONDS * 1000,
    `what it lists is a part of the file (${first.durationMs}ms)`,
  );
  if (!first.complete) {
    assert.ok(first.body.includes("#EXT-X-PLAYLIST-TYPE:EVENT"), "a playlist that grows");
    assert.ok(!first.body.includes("#EXT-X-ENDLIST"), "no end marker while it is still being made");
  }

  // It finished later: the file was still being read when the player was given this.
  let finished = first;
  const deadline = Date.now() + 180_000;
  while (!finished.complete && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    finished = (await engine.manifest(key)) ?? finished;
  }
  assert.equal(finished.complete, true, "the package finished");
  assert.ok(finished.body.includes("#EXT-X-PLAYLIST-TYPE:VOD"));
  assert.ok(finished.body.includes("#EXT-X-ENDLIST"));
  assert.ok(
    finished.durationMs > first.durationMs,
    "and the playlist grew after the player had started on it",
  );
  assert.ok(latency < 30_000, `the first segment came quickly (${latency}ms), not after the file`);
  // What the player would see: the stretches, and most of the window gone.
  const kept = LONG_SECONDS * 1000 - finished.durationMs;
  assert.ok(kept > 2_000, `expected most of the 3000ms window gone, removed ${kept}ms`);
  assert.ok(kept < 6_000, `expected no more than the window plus slack, removed ${kept}ms`);
});

test("the playlist a player is given decodes, with the window's video absent", async () => {
  const engine = new PackageEngine(settings({ cacheDir: path.join(workDir, "cache-decode") }));
  await engine.start();
  const url = `${base}/sample.mkv`;
  const key = engine.keyFor(url, [INTRO], "stream:decode");
  engine.schedule(url, [INTRO], "stream:decode", SAMPLE_SECONDS * 1000);

  const deadline = Date.now() + 120_000;
  let view = await engine.manifest(key);
  while ((!view || !view.complete) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    view = (await engine.manifest(key)) ?? view;
  }
  assert.ok(view?.complete, "the package finished");

  // Hand the playlist to ffmpeg as a player would, with the segments addressed
  // locally: this is the served playlist, byte for byte, minus the round trip.
  const dir = path.join(workDir, "cache-decode", "hls", key);
  const local = view.body.replaceAll(`seg?f=${encodeURIComponent(key)}/`, "");
  const playlistPath = path.join(dir, "index.m3u8");
  await writeFile(playlistPath, local);

  const duration = await durationOf(playlistPath);
  const removed = SAMPLE_SECONDS * 1000 - duration;
  // Nothing is re-encoded, so a cut can only be as precise as the keyframe grid: this
  // sample has one keyframe per second, so a little of the window always stays.
  assert.ok(removed > 1_500, `expected the intro gone from the playlist, removed ${removed}ms`);
  assert.ok(removed < 6_000, `expected no more than the window plus slack, removed ${removed}ms`);
  assert.equal(await decodes(playlistPath), "", "it decodes end to end with nothing to report");

  // Every segment it lists is on disk under this key, and served under a name the
  // engine accepts.
  const names = [...view.body.matchAll(new RegExp(`seg\\?f=${key}/(seg\\d{5}\\.ts)`, "g"))].map(
    (match) => match[1]!,
  );
  assert.ok(names.length >= 2);
  for (const name of names) {
    const local2 = engine.segmentPath(key, name);
    assert.ok(local2, `${name} is a name the engine will serve`);
    assert.ok((await stat(local2)).size > 0, `${name} has bytes`);
  }
});

test("a second ask is served from the package that already exists", async () => {
  const cacheDir = path.join(workDir, "cache-again");
  const engine = new PackageEngine(settings({ cacheDir }));
  await engine.start();
  const url = `${base}/sample.mkv`;
  const key = engine.keyFor(url, [INTRO], "stream:again");
  engine.schedule(url, [INTRO], "stream:again", SAMPLE_SECONDS * 1000);
  await engine.waitForFirstSegment(key, 60_000);

  // A fresh engine, as if the service had restarted: the package is on disk, so it is
  // found again without ffmpeg being asked for anything.
  const restarted = new PackageEngine(settings({ cacheDir }));
  await restarted.start();
  const found = await restarted.existing(key);
  assert.ok(found, "the package was found on disk");
  assert.ok(found.segments >= 1, `segments were counted back (${found.segments})`);
  const view = await restarted.manifest(key);
  assert.ok(view, "and its playlist is served");
  assert.equal(view.segments, found.segments);
});

test("an unreachable source fails instead of hanging, and the player is told", async () => {
  const engine = new PackageEngine(settings({ cacheDir: path.join(workDir, "cache-dead") }));
  await engine.start();
  const url = "http://127.0.0.1:1/not-there.mkv";
  const key = engine.keyFor(url, [INTRO], "stream:dead");
  engine.schedule(url, [INTRO], "stream:dead");

  const started = Date.now();
  const view = await engine.waitForFirstSegment(key, 60_000);
  const waited = Date.now() - started;
  assert.equal(view, null, "there is nothing to serve");
  assert.ok(waited < 30_000, `it gave up rather than holding the player (${waited}ms)`);
  const state = engine.state(key);
  assert.equal(state?.status, "failed");
  assert.ok((state?.error ?? "").length > 0, "with a reason an operator can read");
});

test("a package left behind by a killed run is cleaned up at boot", async () => {
  const value = settings({ cacheDir: path.join(workDir, "cache-boot") });
  const stale = path.join(value.cacheDir, "hls", "deadbeefdeadbeef1234");
  const finished = path.join(value.cacheDir, "hls", "cafebabecafebabe1234");
  await mkdir(stale, { recursive: true });
  await writeFile(path.join(stale, "plan.json"), JSON.stringify({ key: "x", windows: [], ranges: [{ startMs: 0, endMs: 1000 }] }));
  await mkdir(finished, { recursive: true });
  await writeFile(path.join(finished, "plan.json"), JSON.stringify({ key: "y", windows: [], ranges: [{ startMs: 0, endMs: 1000 }] }));
  await writeFile(path.join(finished, "done"), "");
  // A package from the version that copied files instead of segmenting them.
  const legacy = path.join(value.cacheDir, ".parts-old");
  await mkdir(legacy, { recursive: true });

  const engine = new PackageEngine(value);
  await engine.start();
  const left = await readdir(path.join(value.cacheDir, "hls"));
  assert.deepEqual(left, ["cafebabecafebabe1234"], "the half-made package is gone");
  await assert.rejects(stat(legacy), "and so is the leftover from the old engine");
});

test("eviction keeps the cache under its budget, oldest package first", async () => {
  const cacheDir = path.join(workDir, "cache-evict");
  const value = settings({ cacheDir, cacheMaxBytes: 4096 });
  const engine = new PackageEngine(value);
  await engine.start();

  // An older package, big enough that keeping it means going over the budget.
  const oldKey = "aaaaaaaabbbbbbbb1234";
  const oldDir = path.join(cacheDir, "hls", oldKey);
  await mkdir(oldDir, { recursive: true });
  await writeFile(path.join(oldDir, "plan.json"), JSON.stringify({ key: oldKey, windows: [], ranges: [{ startMs: 0, endMs: 1000 }] }));
  await writeFile(path.join(oldDir, "done"), "");
  await writeFile(path.join(oldDir, "seg00000.ts"), Buffer.alloc(8192));
  const longAgo = new Date(Date.now() - 86_400_000);
  await utimes(path.join(oldDir, "plan.json"), longAgo, longAgo);

  // Making a new one triggers eviction.
  const url = `${base}/sample.mkv`;
  const key = engine.keyFor(url, [INTRO], "stream:evict");
  engine.schedule(url, [INTRO], "stream:evict", SAMPLE_SECONDS * 1000);
  await engine.waitForFirstSegment(key, 60_000);

  const deadline = Date.now() + 120_000;
  for (;;) {
    const left = await readdir(path.join(cacheDir, "hls"));
    if (!left.includes(oldKey)) break;
    assert.ok(Date.now() < deadline, `the old package was evicted (still there: ${left.join(", ")})`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok((await readdir(path.join(cacheDir, "hls"))).includes(key), "the new one is kept");
});

test("a package that was just served is not evicted out from under the player", async () => {
  const cacheDir = path.join(workDir, "cache-recent");
  const value = settings({ cacheDir, cacheMaxBytes: 4096 });
  const engine = new PackageEngine(value);
  await engine.start();

  // A package that was served a moment ago: over budget, but in use.
  const busyKey = "dddddddd00000000abcd";
  const busyDir = path.join(cacheDir, "hls", busyKey);
  await mkdir(busyDir, { recursive: true });
  await writeFile(path.join(busyDir, "plan.json"), JSON.stringify({ key: busyKey, windows: [], ranges: [{ startMs: 0, endMs: 1000 }] }));
  await writeFile(path.join(busyDir, "done"), "");
  await writeFile(path.join(busyDir, "seg00000.ts"), Buffer.alloc(8192));
  await writeFile(path.join(busyDir, "pass-0.csv"), "seg00000.ts,0.000000,1.000000\n");
  const longAgo = new Date(Date.now() - 86_400_000);
  await utimes(path.join(busyDir, "plan.json"), longAgo, longAgo);
  assert.ok(await engine.manifest(busyKey), "the player is watching it");

  const url = `${base}/sample.mkv`;
  const key = engine.keyFor(url, [INTRO], "stream:recent");
  engine.schedule(url, [INTRO], "stream:recent", SAMPLE_SECONDS * 1000);
  await engine.waitForFirstSegment(key, 60_000);

  const left = await readdir(path.join(cacheDir, "hls"));
  assert.ok(left.includes(busyKey), `the package in use survived eviction (left: ${left.join(", ")})`);
  assert.ok(left.includes(key), "and the new one is there");
});

test("only names this service generated are served", async () => {
  const engine = new PackageEngine(settings({ cacheDir: path.join(workDir, "cache-names") }));
  await engine.start();
  const key = engine.keyFor(base, [INTRO], "stream:names");
  assert.ok(engine.segmentPath(key, "seg00000.ts"), "a segment of a package");
  assert.equal(engine.segmentPath(key, "../../etc/passwd"), null);
  assert.equal(engine.segmentPath(key, "seg00000.ts/../../plan.json"), null);
  assert.equal(engine.segmentPath("not-hex", "seg00000.ts"), null);
  assert.equal(engine.segmentPath(key, "index.m3u8"), null, "the playlist is written, not fetched");
  assert.equal(await engine.manifest("not-a-key"), null);
});

test("the segments of a stretch share one timeline, so a player's clock does not restart", async () => {
  // The bug this exists for: `-reset_timestamps 1` stamped every segment with the
  // same clock, so a player saw a ten-second item that restarted at each segment --
  // a looping bar, a one-segment duration, and audio drifting away from the video.
  // Reading the playlist cannot catch that (it sums #EXTINF and looks right); only
  // the timestamps a demuxer sees can.
  const engine = new PackageEngine(settings({ cacheDir: path.join(workDir, "cache-timeline") }));
  await engine.start();
  const window = { type: "recap" as const, startMs: 12_000, endMs: 16_000 };
  const url = `${base}/sample.mkv`;
  const key = engine.keyFor(url, [window], "stream:timeline");
  engine.schedule(url, [window], "stream:timeline", SAMPLE_SECONDS * 1000);

  const deadline = Date.now() + 120_000;
  let view = await engine.manifest(key);
  while ((!view || !view.complete) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    view = (await engine.manifest(key)) ?? view;
  }
  assert.ok(view?.complete, "the package finished");

  // Splitting on the discontinuity gives the stretches: each is its own timeline,
  // which is what the tag declares.
  const stretches = view.body
    .split(/^#EXT-X-DISCONTINUITY$/m)
    .map((part) =>
      [...part.matchAll(/^seg\?f=[^/]+\/(seg\d{5}\.ts)$/gm)].map((match) => match[1]!),
    )
    .filter((names) => names.length > 0);
  assert.ok(stretches.length >= 2, `a window in the middle makes two stretches (${stretches.length})`);

  const dir = path.join(workDir, "cache-timeline", "hls", key);
  const firstAudioPts = async (file: string): Promise<number> => {
    const result = await run("ffprobe", [
      "-v", "error", "-select_streams", "a",
      "-show_entries", "packet=pts_time", "-of", "csv=p=0", file,
    ], 60_000);
    return Number(result.stdout.split("\n")[0]?.replace(",", "").trim());
  };

  for (const stretch of stretches) {
    let previous = -1;
    for (const name of stretch) {
      const video = await firstVideoPts(path.join(dir, name));
      assert.ok(
        video > previous,
        `${name} starts at ${video}s, after the previous segment's ${previous}s -- the clock must climb`,
      );
      previous = video;
      // Audio must sit on the same clock, or the player drifts and speeds the video up
      // to catch up.
      const audio = await firstAudioPts(path.join(dir, name));
      assert.ok(
        Math.abs(audio - video) < 0.5,
        `${name}: video at ${video}s, audio at ${audio}s`,
      );
    }
    // Every stretch begins at the beginning of its own timeline.
    assert.ok(
      Math.abs(await firstVideoPts(path.join(dir, stretch[0]!)) - 0) < 0.5,
      "a stretch starts at zero",
    );
  }
});

test("a cold play gets the processing card, and hands over as soon as the episode can play", async () => {
  // Two things are being proven: a player is given something to look at at once instead of a
  // spinner, and the card does not keep growing in front of the film -- waiting for the whole
  // file is exactly what that looked like.
  const window = { type: "intro" as const, startMs: 30_000, endMs: 36_000 };
  const engine = new PackageEngine(
    // A small buffer, so the card is drawn before this source has produced that much: with the
    // card and the episode racing, a zero buffer would mean "no card" whenever the source won.
    settings({ cacheDir: path.join(workDir, "cache-card"), splash: true, prerollSeconds: 2 }),
  );
  await engine.start();
  const url = `${base}/long.mkv`;
  const key = engine.keyFor(url, [window], "stream:card");
  engine.schedule(url, [window], "stream:card", LONG_SECONDS * 1000);

  const started = Date.now();
  // The handler passes the windows it is about to cut, because the plan is written by the
  // job that has only just been queued.
  const card = await engine.splashView(key, [window]);
  assert.ok(card, "the card is served");
  assert.ok(Date.now() - started < 15_000, `and quickly (${Date.now() - started}ms)`);
  assert.ok(card.card >= 1, "with at least one piece of the card in it");
  assert.ok(card.body.includes("splash00000.ts"), "which the playlist lists");
  // Whether the episode's first segment is already written by now is a race with ffmpeg, not
  // something to assert; what matters is that the card comes first when it is there.
  if (card.segments > 0) {
    assert.ok(
      card.body.indexOf("splash") < card.body.indexOf("seg0"),
      "the card is the start of the film, not a screen after it",
    );
  }

  // The card is real, playable video of a known length: a player has to be able to fetch it, and
  // the episode's position in the playlist depends on how long it is.
  const first = engine.segmentPath(key, "splash00000.ts");
  assert.ok(first, "a piece is servable by name");
  const pieceMs = await durationOf(first!);
  assert.ok(pieceMs > 1200 && pieceMs < 3_000, `a piece runs ${pieceMs}ms`);
  assert.equal(await engine.cardMs(key), 2_000, "and the card is exactly the buffer it was asked for");

  // Then the episode can play: the card stops, and what the player already holds is the card
  // followed by the film.
  await engine.waitForFirstSegment(key, 180_000);
  const view = await engine.manifest(key);
  assert.ok(view, "the playlist is served");
  assert.ok(view.card >= 1, "with the card still in it");
  assert.ok(view.segments >= 1, "and the episode after it");
  assert.match(
    view.body,
    /splash0000\d\.ts[\s\S]*#EXT-X-DISCONTINUITY[\s\S]*seg0000\d\.ts/,
    "card, a declared jump, then the episode",
  );

  // One piece, always: a card whose length changed as the packaging raced would move the
  // episode under a player that was already watching it -- and under its subtitles.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const later = await engine.advanceCard(key);
  assert.equal(later?.card, 1, "and the card never grows");
  assert.equal(later?.card, view.card, "so the episode's start in the playlist is a constant");
});

test("the card is drawn once, as long as the buffer, even when nothing can play yet", async () => {
  // A source that never produces a segment is the case where the old card kept being redrawn:
  // the player watched "Processing…" move while the episode's start time moved with it.
  const window = { type: "intro" as const, startMs: 30_000, endMs: 36_000 };
  const engine = new PackageEngine(settings({ cacheDir: path.join(workDir, "cache-moving"), splash: true }));
  await engine.start();
  const url = "http://127.0.0.1:1/never.mkv";
  const key = engine.keyFor(url, [window], "stream:moving");
  engine.schedule(url, [window], "stream:moving");

  const first = await engine.splashView(key, [window]);
  assert.equal(first?.card, 1, "one piece");
  assert.equal(first?.segments, 0, "and nothing of the episode, because there is none");
  assert.ok(first?.body.includes("#EXT-X-PLAYLIST-TYPE:EVENT"), "a playlist that keeps growing");
  assert.ok(!first?.body.includes("#EXT-X-ENDLIST"), "with no end while the work goes on");
  assert.ok(await firstVideoPts(engine.segmentPath(key, "splash00000.ts")!) >= 0, "and it decodes");

  await new Promise((resolve) => setTimeout(resolve, 1200));
  const second = await engine.advanceCard(key);
  assert.equal(second?.card, 1, "still one piece, however long the work goes on");
  assert.equal(await engine.cardMs(key), 10_000, "and it is the buffer's length");
  assert.equal((await engine.splashView("deadbeefdeadbeef0000")), null, "no package, no card");
});

test("the playlist declares the whole episode from its first response", async () => {
  // Stremio marks an episode watched and jumps to the next one when the playlist it was handed
  // reaches the end -- and a playlist holding only what has been packaged so far ends after a
  // few seconds. The remainder is padded with the card, so the declared length is the episode's
  // from the very first response, however little of it has actually been cut.
  const window = { type: "intro" as const, startMs: 30_000, endMs: 36_000 };
  const engine = new PackageEngine(settings({ cacheDir: path.join(workDir, "cache-full"), splash: true }));
  await engine.start();
  const url = `${base}/long.mkv`;
  const key = engine.keyFor(url, [window], "stream:full");

  // The handler learns the length before it answers (see rememberDuration).
  const duration = await engine.rememberDuration(key, url);
  assert.ok(duration && Math.abs(duration - LONG_SECONDS * 1000) < 2_000, `probed ${duration}ms`);
  engine.schedule(url, [window], "stream:full", duration);

  const card = await engine.splashView(key, [window]);
  assert.ok(card, "the card is served");
  assert.equal(card.expectedMs, LONG_SECONDS * 1000 - 6_000, "the episode's length less the window");
  assert.ok(card.padding > 0, "with the remainder padded");
  // The presentation is the card and then the episode, so its length is both together.
  const cardMs = await engine.cardMs(key);
  assert.equal(cardMs, 10_000, "the card is the buffer's length, not a race");
  const declared = cardMs + card.expectedMs!;
  assert.ok(
    card.durationMs >= declared - 8_000 && card.durationMs <= declared + 8_000,
    `the declared length is the card plus the episode (${card.durationMs}ms against ${declared}ms)`,
  );

  // The padding is real, fetchable media rather than a dangling URI: a player that outruns the
  // packaging walks onto it.
  const piece = /seg\?f=[^/]+\/((?:pad|splash)\d{5}\.ts)/.exec(card.body)?.[1];
  assert.ok(piece, "the padding names a piece");
  const path0 = engine.segmentPath(key, piece!);
  assert.ok(path0, "which the service will serve");
  assert.ok((await durationOf(path0!)) > 1_000, "and which is real media");
});

test("the card covers the wait for the buffer, and is the buffer's length", async () => {
  // Starting playback on a couple of seconds is what made the player treat the episode as
  // finished. The card covers the wait, and it is as long as the buffer exactly, so a player
  // (and a subtitle track) can count on where the film begins.
  const window = { type: "intro" as const, startMs: 30_000, endMs: 36_000 };
  const engine = new PackageEngine(
    settings({ cacheDir: path.join(workDir, "cache-buffer"), splash: true, prerollSeconds: 10 }),
  );
  await engine.start();
  const url = `${base}/long.mkv`;
  const key = engine.keyFor(url, [window], "stream:buffer");
  engine.schedule(url, [window], "stream:buffer", LONG_SECONDS * 1000);

  const first = await engine.splashView(key, [window]);
  assert.ok(first, "the card is served straight away");
  assert.equal(first?.card, 1, "once");
  assert.equal(await engine.cardMs(key), 10_000, "and it is ten seconds of card, not a race");
  const pieceMs = await durationOf(engine.segmentPath(key, "splash00000.ts")!);
  assert.ok(pieceMs > 8_000, `the card itself runs ${pieceMs}ms`);

  // The episode is packaged behind it, and the playlist says where the film starts: after the
  // card, and it stays there.
  const deadline = Date.now() + 180_000;
  for (;;) {
    const view = await engine.manifest(key);
    if ((view?.segments ?? 0) >= 3) break;
    assert.ok(Date.now() < deadline, "the episode's own segments arrive");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const later = await engine.manifest(key);
  assert.equal(later?.card, 1, "the card is still one piece");
  assert.equal(await engine.cardMs(key), 10_000, "and still the same length");
});
