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
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import type { Settings } from "../src/addon/env.js";
import { hasRoomFor, keptRanges, run } from "../src/streams/ffmpeg.js";
import { audioMap, PackageEngine } from "../src/streams/packages.js";
import type { StreamInfo } from "../src/streams/streaminfo.js";

const SAMPLE_SECONDS = 30;
const LONG_SECONDS = 180;
const INTRO = { type: "intro" as const, startMs: 10_000, endMs: 13_000 };
/** Sent slowly, the way a debrid link behaves when a player gives up on it. */
const THROTTLE_CHUNK = 16 * 1024;
const THROTTLE_MS = 40;

let workDir: string;
let samplePath: string;
let longPath: string;
let hevcPath: string;
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
    subtitlesGenerate: false,
    subtitlesLanguage: "en",
    subtitlesChunkSeconds: 300,
    subtitlesTtlHours: 24,
    subtitlesIdleSeconds: 120,
    subtitlesAudioLanguage: "en",
    drainSecret: "",
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
  const result = await run(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file],
    60_000,
  );
  assert.equal(result.code, 0, `ffprobe failed: ${result.stderr}`);
  return Math.round(Number(result.stdout.trim()) * 1000);
}

/** The first video timestamp in a file, in seconds: what a demuxer sees first. */
async function firstVideoPts(file: string): Promise<number> {
  const result = await run(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v",
      "-show_entries",
      "packet=pts_time",
      "-of",
      "csv=p=0",
      file,
    ],
    60_000,
  );
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

  // 30 seconds of something predictable, in Matroska, with a keyframe every second -- and an
  // embedded WebVTT track, because most releases have one. ffmpeg 8 happens to tolerate copying it
  // into the HLS muxer; the build in the deployment image does not and refuses the entire output
  // ("Exactly one WebVTT stream is needed"), which is a package that never gets made at all. The
  // segments are written with `-sn -dn`, so the release a source arrives in cannot decide whether
  // a package can be made.
  const subPath = path.join(workDir, "sample.vtt");
  await writeFile(subPath, "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nhello\n");
  const generated = await run(
    "ffmpeg",
    [
      "-nostdin",
      "-hide_banner",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `testsrc=size=320x240:rate=10:duration=${SAMPLE_SECONDS}`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=440:duration=${SAMPLE_SECONDS}`,
      "-i",
      subPath,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-map",
      "2:s:0",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "30",
      "-g",
      "10",
      "-c:a",
      "aac",
      "-b:a",
      "64k",
      "-c:s",
      "webvtt",
      "-y",
      samplePath,
    ],
    120_000,
  );
  assert.equal(generated.code, 0, `could not generate the sample: ${generated.stderr}`);

  // Three minutes of the same thing, in a file small enough to generate quickly but
  // served slowly: packaging it then takes long enough that "a playlist is ready
  // before the file is" is an interval rather than a race.
  longPath = path.join(workDir, "long.mkv");
  const long = await run(
    "ffmpeg",
    [
      "-nostdin",
      "-hide_banner",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `testsrc=size=160x120:rate=5:duration=${LONG_SECONDS}`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "35",
      "-g",
      "5",
      "-y",
      longPath,
    ],
    300_000,
  );
  assert.equal(long.code, 0, `could not generate the long sample: ${long.stderr}`);

  // Ten seconds of HEVC, which is what a package has to be written as fMP4 for. Small, but big
  // enough that the first stretch takes long enough to be seen while it is being cut.
  hevcPath = path.join(workDir, "hevc.mkv");
  const hevc = await run(
    "ffmpeg",
    [
      "-nostdin",
      "-hide_banner",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=640x360:rate=10:duration=20",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=20",
      "-c:v",
      "libx265",
      "-preset",
      "ultrafast",
      "-crf",
      "30",
      "-g",
      "10",
      "-x265-params",
      "log-level=error",
      "-c:a",
      "aac",
      "-b:a",
      "64k",
      "-y",
      hevcPath,
    ],
    300_000,
  );
  assert.equal(hevc.code, 0, `could not generate the HEVC sample: ${hevc.stderr}`);

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
      const hevcSource = request.url === "/hevc.mkv";
      const long = request.url === "/long.mkv";
      const file = await readFile(hevcSource ? hevcPath : long ? longPath : samplePath);
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
        if (long || hevcSource) {
          // Dribbled out, so a whole-file read takes seconds: exactly the situation
          // that used to leave a player watching a spinner. The HEVC one is slower still, so
          // the first stretch is still being cut while a test is looking at it.
          const chunk = hevcSource ? 2048 : THROTTLE_CHUNK;
          const pause = hevcSource ? 50 : THROTTLE_MS;
          for (let at = start; at <= end; at += chunk) {
            response.write(file.subarray(at, Math.min(at + chunk, end + 1)));
            await new Promise((resolve) => setTimeout(resolve, pause));
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
  const withIdentity = engine.keyFor(
    `${base}/playback/abc?token=1`,
    [INTRO],
    "stream:tt0903747:1:1",
  );
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
  while (!view?.complete && Date.now() < deadline) {
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
  await writeFile(
    path.join(stale, "plan.json"),
    JSON.stringify({ key: "x", windows: [], ranges: [{ startMs: 0, endMs: 1000 }] }),
  );
  await mkdir(finished, { recursive: true });
  await writeFile(
    path.join(finished, "plan.json"),
    JSON.stringify({ key: "y", windows: [], ranges: [{ startMs: 0, endMs: 1000 }] }),
  );
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
  await writeFile(
    path.join(oldDir, "plan.json"),
    JSON.stringify({ key: oldKey, windows: [], ranges: [{ startMs: 0, endMs: 1000 }] }),
  );
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
    assert.ok(
      Date.now() < deadline,
      `the old package was evicted (still there: ${left.join(", ")})`,
    );
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
  await writeFile(
    path.join(busyDir, "plan.json"),
    JSON.stringify({ key: busyKey, windows: [], ranges: [{ startMs: 0, endMs: 1000 }] }),
  );
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
  assert.ok(
    left.includes(busyKey),
    `the package in use survived eviction (left: ${left.join(", ")})`,
  );
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
  while (!view?.complete && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    view = (await engine.manifest(key)) ?? view;
  }
  assert.ok(view?.complete, "the package finished");

  // Splitting on the discontinuity gives the stretches: each is its own timeline,
  // which is what the tag declares.
  const stretches = view.body
    .split(/^#EXT-X-DISCONTINUITY$/m)
    .map((part) => [...part.matchAll(/^seg\?f=[^/]+\/(seg\d{5}\.ts)$/gm)].map((match) => match[1]!))
    .filter((names) => names.length > 0);
  assert.ok(
    stretches.length >= 2,
    `a window in the middle makes two stretches (${stretches.length})`,
  );

  const dir = path.join(workDir, "cache-timeline", "hls", key);
  const firstAudioPts = async (file: string): Promise<number> => {
    const result = await run(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "a",
        "-show_entries",
        "packet=pts_time",
        "-of",
        "csv=p=0",
        file,
      ],
      60_000,
    );
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
      assert.ok(Math.abs(audio - video) < 0.5, `${name}: video at ${video}s, audio at ${audio}s`);
    }
    // Every stretch begins at the beginning of its own timeline.
    assert.ok(
      Math.abs((await firstVideoPts(path.join(dir, stretch[0]!))) - 0) < 0.5,
      "a stretch starts at zero",
    );
  }
});

test("a cold play is given the card while the film is cut, and never after it can play", async () => {
  // Two things are being proven: a player is given something to look at at once instead of a
  // spinner, and the card is only ever the *wait* -- the moment the pre-roll is on disk it is gone
  // and the film starts at position zero. A card that survives the wait is a viewer watching
  // "Processing…" over an episode that is ready to play.
  const engine = new PackageEngine(
    settings({ cacheDir: path.join(workDir, "cache-card"), splash: true }),
  );
  await engine.start();
  const windows = [INTRO];
  const key = engine.keyFor(samplePath, windows, "stream:card");
  const dir = path.join(workDir, "cache-card", "hls", key);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "plan.json"),
    JSON.stringify({
      key,
      windows,
      ranges: [
        { startMs: 0, endMs: INTRO.startMs },
        { startMs: INTRO.endMs, endMs: SAMPLE_SECONDS * 1000 },
      ],
      createdAt: Date.now(),
    }),
  );
  await writeFile(
    path.join(dir, "duration.json"),
    JSON.stringify({
      durationMs: SAMPLE_SECONDS * 1000,
      bitrate: 1000,
      width: 320,
      height: 180,
      codecs: "",
    }),
  );

  // Nothing packaged yet, so the player gets the card rather than nothing.
  const started = Date.now();
  const card = await engine.splashView(key, windows);
  assert.ok(card, "the card is served");
  assert.ok(Date.now() - started < 15_000, `and quickly (${Date.now() - started}ms)`);
  assert.equal(card.card, 1, "one piece of it");
  assert.equal(card.segments, 0, "and nothing of the episode, because there is none");
  assert.ok(card.body.includes("splash00000.ts"), "which the playlist lists");

  // The card is real, playable video of a known length: a player has to be able to fetch it.
  const first = engine.segmentPath(key, "splash00000.ts");
  assert.ok(first, "a piece is servable by name");
  const pieceMs = await durationOf(first!);
  assert.ok(pieceMs > 8_000, `a piece runs ${pieceMs}ms`);
  assert.equal(await engine.cardMs(key), 10_000, "and the card is the buffer's length");

  // Then the pre-roll arrives: no card, and the film is the first thing in the playlist.
  await writeFile(
    path.join(dir, "pass-0.csv"),
    "seg00000.ts,0.000000,5.000000\nseg00001.ts,5.000000,10.000000\n",
  );
  await writeFile(
    path.join(dir, "pass-1.csv"),
    "seg00002.ts,0.000000,5.000000\nseg00003.ts,5.000000,10.000000\nseg00004.ts,10.000000,17.000000\n",
  );
  const view = await engine.manifest(key);
  assert.ok(view, "the playlist is served");
  assert.equal(view.card, 0, "the card is not in it any more");
  assert.ok(!view.body.includes("splash"), "not one piece of it");
  assert.ok(view.bufferedMs >= 10_000, `${view.bufferedMs}ms of the episode is on disk`);
  const firstUri = view.body.split("\n").find((line) => !line.startsWith("#"));
  assert.match(firstUri ?? "", /seg00000\.ts/, "and the film is the first thing in it");

  // And it does not come back: a card is a wait, not a pre-roll.
  const later = await engine.advanceCard(key);
  assert.equal(later?.card ?? 0, 0, "the card never returns");
});

test("a job that stopped does not leave the card up for ever", async () => {
  // The failure this exists for: packaging that cannot work, a card drawn over it, and a player
  // watching "Processing…" until it gives up. A job that has stopped has a null answer here, and
  // the caller answers that by handing over the source untouched.
  const engine = new PackageEngine(
    settings({ cacheDir: path.join(workDir, "cache-stopped"), splash: true }),
  );
  await engine.start();
  const windows = [INTRO];
  const url = "http://127.0.0.1:1/never.mkv";
  const key = engine.keyFor(url, windows, "stream:stopped");
  engine.schedule(url, windows, "stream:stopped");

  const deadline = Date.now() + 60_000;
  while (engine.state(key)?.status !== "failed") {
    assert.ok(Date.now() < deadline, `the job stops (${engine.state(key)?.status})`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.equal(await engine.manifest(key), null, "there is no playlist to serve");
  assert.equal(await engine.splashView(key, windows), null, "and no card is drawn over it");
  assert.equal(await engine.advanceCard(key), null, "and a polling player is not kept on one");
});

/**
 * Where a live player starts: an `#EXT-X-PLAYLIST-TYPE:EVENT` playlist is joined three target
 * durations before its end (`liveSyncDurationCount` in hls.js, the same rule in AVFoundation).
 */
function liveStart(body: string): { uri: string; atMs: number; fromEndMs: number } {
  const target = Number(/#EXT-X-TARGETDURATION:(\d+)/.exec(body)?.[1] ?? 6) * 1000;
  const lines = body.split("\n");
  const entries: Array<{ uri: string; ms: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const span = /^#EXTINF:([0-9.]+),/.exec(lines[i] ?? "");
    if (!span) continue;
    entries.push({ uri: lines[i + 1] ?? "", ms: Math.round(Number(span[1]) * 1000) });
    i += 1;
  }
  const total = entries.reduce((sum, entry) => sum + entry.ms, 0);
  const want = Math.max(0, total - 3 * target);
  let at = 0;
  for (const entry of entries) {
    if (at + entry.ms > want) return { uri: entry.uri, atMs: at, fromEndMs: total - at };
    at += entry.ms;
  }
  return { uri: entries[entries.length - 1]?.uri ?? "", atMs: at, fromEndMs: 0 };
}

test("the placeholder is a cushion at the write head, not the rest of the episode", async () => {
  // An EVENT playlist is joined at its live edge -- three target durations before the end -- so a
  // tail that declares the *whole episode* puts the place a player opens at inside the placeholder
  // for the entire packaging, and the moment the film finishes that position is the very end of the
  // episode: the only way out is to close the player. (Measured on a 20-minute episode: 45
  // placeholder entries at the end of 284, and that is where Stremio opened.)
  const window = { type: "intro" as const, startMs: 30_000, endMs: 36_000 };
  const engine = new PackageEngine(
    settings({ cacheDir: path.join(workDir, "cache-tail"), splash: true }),
  );
  await engine.start();
  const url = `${base}/long.mkv`;
  const key = engine.keyFor(url, [window], "stream:tail");

  // The handler learns the length before it answers (see rememberDuration).
  const duration = await engine.rememberDuration(key, url);
  assert.ok(duration && Math.abs(duration - LONG_SECONDS * 1000) < 2_000, `probed ${duration}ms`);
  const dir = path.join(workDir, "cache-tail", "hls", key);
  await writeFile(
    path.join(dir, "plan.json"),
    JSON.stringify({
      key,
      windows: [window],
      ranges: keptRanges([window], duration),
      createdAt: Date.now(),
    }),
  );

  // Nothing packaged: the card, and a cushion behind it -- never the rest of a three-minute episode.
  const card = await engine.splashView(key, [window]);
  assert.ok(card, "a playlist is served straight away");
  assert.equal(card.card, 1, "with the card in it, because nothing has been cut yet");
  assert.equal(card.expectedMs, LONG_SECONDS * 1000 - 6_000, "the episode's own length");
  assert.ok(card.padding > 0, "with a cushion of placeholder");
  const cardMs = await engine.cardMs(key);
  const tail = card.durationMs - cardMs - card.bufferedMs;
  assert.ok(tail <= 12_500, `the cushion is ${tail}ms past the film, not the episode's remainder`);
  // The placeholder is real, fetchable media, and it is not the card: a player that joins here is
  // looking at the film's own seconds, so it must not be shown "Processing…" over them.
  const piece = /seg\?f=[^/]+\/(pad\d{5}\.ts)/.exec(card.body)?.[1];
  assert.ok(piece, `the cushion names its own piece (${card.body.slice(0, 200)})`);
  const piecePath = engine.segmentPath(key, piece!);
  assert.ok(piecePath, "which the service will serve");
  assert.ok((await durationOf(piecePath!)) > 1_000, "and which is real media");

  // Twenty-eight seconds of the film on disk: the live edge is inside it, not in the tail.
  const rows: string[] = [];
  for (let i = 0; i < 7; i += 1) {
    const name = `seg${String(i).padStart(5, "0")}.ts`;
    rows.push(`${name},${(i * 4).toFixed(3)},${((i + 1) * 4).toFixed(3)}`);
  }
  await writeFile(path.join(dir, "pass-0.csv"), `${rows.join("\n")}\n`);
  const view = (await engine.manifest(key))!;
  assert.equal(view.card, 0, "the film is enough to play, so the card is gone");
  assert.equal(view.bufferedMs, 28_000, "twenty-eight seconds of the film");
  const live = liveStart(view.body);
  assert.match(live.uri, /seg0000\d\.ts/, `a live player starts in the film (${live.uri})`);
  assert.ok(
    live.atMs >= view.bufferedMs - 12_000,
    `and near the write head (${live.atMs}ms of ${view.bufferedMs}ms)`,
  );
});

test("the film is handed over the moment the pre-roll is on disk", async () => {
  // The rule that makes a playback start on the episode rather than on a card: once
  // `PREROLL_SECONDS` of the *cut* film is packaged, the playlist starts with the film. Nine
  // seconds of it is a card; ten is the episode.
  const engine = new PackageEngine(
    settings({ cacheDir: path.join(workDir, "cache-buffer"), splash: true, prerollSeconds: 10 }),
  );
  await engine.start();
  const windows = [INTRO];
  const key = engine.keyFor(samplePath, windows, "stream:buffer");
  const dir = path.join(workDir, "cache-buffer", "hls", key);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "plan.json"),
    JSON.stringify({
      key,
      windows,
      ranges: [
        { startMs: 0, endMs: INTRO.startMs },
        { startMs: INTRO.endMs, endMs: SAMPLE_SECONDS * 1000 },
      ],
      createdAt: Date.now(),
    }),
  );
  await writeFile(
    path.join(dir, "duration.json"),
    JSON.stringify({
      durationMs: SAMPLE_SECONDS * 1000,
      bitrate: 1000,
      width: 320,
      height: 180,
      codecs: "",
    }),
  );

  const none = await engine.splashView(key, windows);
  assert.equal(none?.card, 1, "nothing cut yet, so the card");

  await writeFile(
    path.join(dir, "pass-0.csv"),
    "seg00000.ts,0.000000,5.000000\nseg00001.ts,5.000000,9.000000\n",
  );
  const nine = (await engine.manifest(key))!;
  assert.equal(nine.bufferedMs, 9_000, "nine seconds of the film");
  assert.equal(nine.card, 1, "is not the pre-roll, so the card stays");

  await writeFile(
    path.join(dir, "pass-0.csv"),
    "seg00000.ts,0.000000,5.000000\nseg00001.ts,5.000000,10.000000\n",
  );
  const ten = (await engine.manifest(key))!;
  assert.equal(ten.bufferedMs, 10_000, "ten seconds of the film");
  assert.equal(ten.card, 0, "is the pre-roll, so the card goes");
  const head = ten.body.split("\n").find((line) => !line.startsWith("#"));
  assert.match(head ?? "", /seg00000\.ts/, "and the episode is the head of the playlist");
});

test("an fMP4 package is described with its initialisation section", async () => {
  // HEVC cannot be demuxed out of MPEG-TS by hls.js, which is every browser player, so those
  // packages are written as fMP4. A player needs the initialisation section before any sample,
  // and without it the playlist is a pile of unreadable fragments.
  const engine = new PackageEngine(settings({ splash: true }));
  await engine.start();
  const windows = [INTRO];
  const key = engine.keyFor(samplePath, windows, "fmp4-test");
  const dir = path.join(workDir, "cache", "hls", key);
  await mkdir(dir, { recursive: true });

  await writeFile(
    path.join(dir, "plan.json"),
    JSON.stringify({
      key,
      windows,
      ranges: [
        { startMs: 0, endMs: INTRO.startMs },
        { startMs: INTRO.endMs, endMs: SAMPLE_SECONDS * 1000 },
      ],
      createdAt: Date.now(),
    }),
  );
  await writeFile(
    path.join(dir, "duration.json"),
    JSON.stringify({
      durationMs: SAMPLE_SECONDS * 1000,
      bitrate: 5359114,
      width: 3840,
      height: 2160,
      codecs: "hvc1.2.4.L153.B0,ec-3",
    }),
  );
  await writeFile(
    path.join(dir, "format.json"),
    JSON.stringify({
      container: "mp4",
      inits: ["init-0.mp4", "init-1.mp4"],
    }),
  );
  await writeFile(path.join(dir, "pass-0.csv"), "seg00000.m4s,0.000000,3.000000\n");
  await writeFile(
    path.join(dir, "pass-1.csv"),
    "seg00001.m4s,0.000000,8.500000\nseg00002.m4s,8.500000,17.000000\n",
  );
  await writeFile(path.join(dir, "done"), "");
  await writeFile(path.join(dir, "init-0.mp4"), "INIT");

  const view = (await engine.manifest(key))!;
  const lines = view.body.split("\n");
  const firstMap = lines.findIndex((line) => line.startsWith("#EXT-X-MAP"));
  const firstSegment = lines.findIndex((line) => line.includes("seg00000.m4s"));
  assert.ok(firstMap >= 0, "the playlist declares an initialisation section");
  assert.ok(lines[firstMap]!.includes(`init-0.mp4`), "the one written for that pass");
  assert.ok(firstMap < firstSegment, "before the first sample, which a player needs it for");
  assert.equal(
    lines.filter((line) => line.startsWith("#EXT-X-MAP")).length,
    2,
    "one per stretch, since each pass was cut by its own ffmpeg run",
  );
  assert.ok(!lines.some((line) => line.includes("splash")), "an fMP4 package has no TS card");
  assert.ok(
    lines.includes("#EXT-X-START:TIME-OFFSET=0"),
    "and playback starts at the head, not at the live edge an EVENT playlist is joined at",
  );
  assert.equal(view.card, 0, "and says so");

  // And the initialisation section is servable, typed as what it is.
  const init = engine.segmentPath(key, "init-0.mp4");
  assert.ok(init, "the init section is a name the segment route accepts");
});

test("the package keeps the audio the install asked for", () => {
  // A release with dubs marks one as its default, and ffmpeg's own selection keeps that one -- so
  // an install that asked for English used to be served the dub. The choice is the same one the
  // configuration page makes, applied to what the package carries.
  //
  // The selector is the stream's own index, not its place among the audio streams: `0:a:1` on a
  // file whose single sound track is stream 1 asks for a second sound that does not exist, and
  // ffmpeg refuses the whole output -- a package that is never made.
  const info = {
    durationMs: 60_000,
    bitrate: 1,
    width: 1920,
    height: 1080,
    codecs: "",
    audio: [
      { index: 1, language: "es", isDefault: true },
      { index: 2, language: "en", isDefault: false },
    ],
  } as unknown as StreamInfo;
  assert.deepEqual(
    audioMap(info, "en"),
    ["-map", "0:v:0", "-map", "0:2"],
    "the English track, not the dub",
  );
  assert.deepEqual(audioMap(info, "es"), ["-map", "0:v:0", "-map", "0:1"], "or the one asked for");
  assert.deepEqual(
    audioMap(info, "de"),
    ["-map", "0:v:0", "-map", "0:2"],
    "and English when absent",
  );
  assert.deepEqual(audioMap(null, "en"), [], "without a probe ffmpeg still decides");
  // A silent release: asking for an audio stream that is not there fails the same way.
  const silent = { ...info, audio: [] } as unknown as StreamInfo;
  assert.deepEqual(audioMap(silent, "en"), ["-map", "0:v:0"], "the picture, and nothing else");
});

test("a different audio preference is a different package", () => {
  const engine = new PackageEngine(settings({}));
  const url = `${base}/playback/abc`;
  assert.notEqual(
    engine.keyFor(url, [INTRO], "stream:tt1", "en"),
    engine.keyFor(url, [INTRO], "stream:tt1", "es"),
    "one package per audio track, or a viewer gets the wrong one",
  );
  assert.equal(
    engine.keyFor(url, [INTRO], "stream:tt1"),
    engine.keyFor(url, [INTRO], "stream:tt1", ""),
    "a deployment with no preference keeps the keys it had",
  );
});

test("a package that was made earlier has no card in front of it", async () => {
  // The card exists to cover the packaging, so a finished package never needs one: a playback that
  // starts on it is watching "Processing…" over an episode that was cut yesterday.
  const engine = new PackageEngine(
    settings({ cacheDir: path.join(workDir, "cache-cardless"), splash: true }),
  );
  await engine.start();
  const windows = [INTRO];
  const key = engine.keyFor(samplePath, windows, "cardless-test");
  const dir = path.join(workDir, "cache-cardless", "hls", key);
  await mkdir(dir, { recursive: true });

  await writeFile(
    path.join(dir, "plan.json"),
    JSON.stringify({
      key,
      windows,
      ranges: [
        { startMs: 0, endMs: INTRO.startMs },
        { startMs: INTRO.endMs, endMs: SAMPLE_SECONDS * 1000 },
      ],
      createdAt: Date.now(),
    }),
  );
  await writeFile(
    path.join(dir, "duration.json"),
    JSON.stringify({
      durationMs: SAMPLE_SECONDS * 1000,
      bitrate: 1000,
      width: 320,
      height: 180,
      codecs: "",
    }),
  );
  await writeFile(
    path.join(dir, "pass-0.csv"),
    "seg00000.ts,0.000000,5.000000\nseg00001.ts,5.000000,10.000000\n",
  );
  await writeFile(
    path.join(dir, "pass-1.csv"),
    "seg00002.ts,0.000000,8.500000\nseg00003.ts,8.500000,17.000000\n",
  );
  await writeFile(path.join(dir, "splash.list"), "splash00000.ts 10000\n");
  await writeFile(path.join(dir, "done"), "");

  assert.equal(await engine.isComplete(key), true, "the engine says the film is ready");

  const view = (await engine.manifest(key))!;
  assert.equal(view.card, 0, "no card is listed");
  assert.ok(!view.body.includes("splash"), "and no piece of it");
  assert.equal(view.complete, true, "the film is still declared complete");
  const head = view.body.split("\n").find((line) => !line.startsWith("#"));
  assert.match(head ?? "", /seg00000\.ts/, "and the playlist starts at the head of the episode");
});

test("an HEVC package is playable while its first stretch is still being cut", async () => {
  // The fMP4 HLS muxer has no `-segment_list`, so the segment record used to be written only once
  // a pass had *exited*: an HEVC episode reported nothing until a whole stretch -- the intro's
  // position, a minute or more of video -- had been copied, and the play request was held for
  // exactly that long. The playlist the muxer appends to is readable while it runs.
  const engine = new PackageEngine(
    settings({ cacheDir: path.join(workDir, "cache-hevc"), splash: true }),
  );
  await engine.start();
  const window = { type: "intro" as const, startMs: 6_000, endMs: 8_000 };
  const url = `${base}/hevc.mkv`;
  const key = engine.keyFor(url, [window], "stream:hevc");
  const duration = await engine.rememberDuration(key, url);
  engine.schedule(url, [window], "stream:hevc", duration);

  let early: Awaited<ReturnType<PackageEngine["manifest"]>> = null;
  const deadline = Date.now() + 120_000;
  for (;;) {
    const view = await engine.manifest(key);
    if (view && view.segments > 0) {
      early = view;
      break;
    }
    const state = engine.state(key);
    assert.notEqual(state?.status, "failed", state?.error);
    assert.ok(Date.now() < deadline, "a segment is reported while the stretch is being written");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(early, "the package is playable");
  assert.equal(early.complete, false, "before the film is finished");
  assert.equal(engine.state(key)?.status, "generating", "while ffmpeg is still writing it");
  assert.ok(early.body.includes(".m4s"), "as fMP4, which is what a browser can demux HEVC from");
  assert.ok(early.body.includes("seg00000.m4s"), "starting at the first segment of the stretch");

  await engine.waitForFirstSegment(key, 120_000);
  engine.drain();
});

test("an fMP4 package's placeholder is fMP4 too", async () => {
  // The placeholder is what a player falls back to when it outruns the packaging. A TS piece -- or
  // an AVC one -- inside an fMP4 HEVC playlist is a demux error at the end of the buffer, which is
  // a stream that stops instead of one that waits.
  const engine = new PackageEngine(
    settings({ cacheDir: path.join(workDir, "cache-fmp4pad"), splash: true }),
  );
  await engine.start();
  const windows = [INTRO];
  const key = engine.keyFor(samplePath, windows, "fmp4-pad");
  const dir = path.join(workDir, "cache-fmp4pad", "hls", key);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "plan.json"),
    JSON.stringify({
      key,
      windows,
      ranges: [
        { startMs: 0, endMs: INTRO.startMs },
        { startMs: INTRO.endMs, endMs: SAMPLE_SECONDS * 1000 },
      ],
      createdAt: Date.now(),
    }),
  );
  await writeFile(
    path.join(dir, "duration.json"),
    JSON.stringify({
      durationMs: SAMPLE_SECONDS * 1000,
      bitrate: 5359114,
      width: 3840,
      height: 2160,
      codecs: "hvc1.2.4.L153.B0,ec-3",
      video: "hevc",
    }),
  );
  await writeFile(
    path.join(dir, "format.json"),
    JSON.stringify({ container: "mp4", inits: ["init-0.mp4", "init-1.mp4"] }),
  );
  // One segment of the film: a playlist with nothing at all in it is not served (the caller waits
  // for the first segment instead), and it is the placeholder behind what is there that matters.
  await writeFile(path.join(dir, "pass-0.csv"), "seg00000.m4s,0.000000,3.000000\n");

  const view = (await engine.manifest(key))!;
  assert.equal(view.card, 0, "an fMP4 package has no card");
  assert.ok(view.padding > 0, "and the remainder is still padded");
  assert.match(
    view.body,
    /#EXT-X-MAP:URI="seg\?f=[^"]+init-pad\.mp4"/,
    "the placeholder declares its own initialisation section",
  );
  assert.match(view.body, /pad00000\.m4s/, "and its segments are fMP4");
  assert.ok(!view.body.includes("pad00000.ts"), "not a TS piece inside an fMP4 playlist");
  assert.ok(engine.segmentPath(key, "pad00000.m4s"), "and the placeholder is servable");
});
