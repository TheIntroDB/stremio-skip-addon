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
    cuts: "blocking",
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

test("cutting can be switched off entirely", async () => {
  const engine = new PackageEngine(settings({ cuts: "off" }));
  const status = await engine.start();
  assert.equal(status.ok, true);
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
