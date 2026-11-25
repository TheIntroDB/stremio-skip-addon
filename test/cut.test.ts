// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * The cut engine, against real ffmpeg.
 *
 * A 30 second sample is generated once, served over HTTP with range support (the
 * shape a debrid link has), and then cut. Nothing here is mocked: if ffmpeg is
 * missing the suite fails, which is the point.
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, stat, utimes } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { CutEngine, keptRanges, run } from "../src/cut.js";
import type { Settings } from "../src/env.js";
import { serveFile } from "../src/files.js";

const SAMPLE_SECONDS = 30;
const INTRO = { type: "intro" as const, startMs: 10_000, endMs: 13_000 };

let workDir: string;
let samplePath: string;
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
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
    ...overrides,
  };
}

/** Probe a media file for its duration in ms. */
async function durationOf(file: string): Promise<number> {
  const result = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=nw=1:nk=1",
    file,
  ], 30_000);
  assert.equal(result.code, 0, `ffprobe failed: ${result.stderr}`);
  return Math.round(Number(result.stdout.trim()) * 1000);
}

before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "tidb-cut-"));
  samplePath = path.join(workDir, "sample.mkv");

  // 30 seconds of something predictable, in Matroska, with a keyframe every second.
  const generated = await run("ffmpeg", [
    "-nostdin", "-hide_banner", "-v", "error",
    "-f", "lavfi", "-i", `testsrc=size=320x240:rate=10:duration=${SAMPLE_SECONDS}`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${SAMPLE_SECONDS}`,
    "-c:v", "mpeg4", "-q:v", "8", "-g", "10",
    "-c:a", "libmp3lame",
    "-y", samplePath,
  ], 120_000);
  assert.equal(generated.code, 0, `could not generate the sample: ${generated.stderr}`);
  const sampleDuration = await durationOf(samplePath);
  assert.ok(
    Math.abs(sampleDuration - SAMPLE_SECONDS * 1000) < 500,
    `sample is ${sampleDuration}ms, expected about ${SAMPLE_SECONDS * 1000}ms`,
  );

  // Serve it the way a CDN does: byte ranges, 206. The master playlist is here so
  // the "an HLS source is never remuxed" test has something real to point at.
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
      const file = await readFile(samplePath);
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
  assert.deepEqual(keptRanges([{ type: "credits", startMs: 20_000, endMs: null }], 30_000), [
    { startMs: 0, endMs: 20_000 },
  ]);
});

test("a window covering everything leaves nothing to serve", () => {
  assert.deepEqual(keptRanges([{ type: "recap", startMs: 0, endMs: 60_000 }], 30_000), []);
});

test("slivers shorter than half a second are dropped rather than cut", () => {
  const windows = [
    { type: "intro" as const, startMs: 200, endMs: 5_000 },
    { type: "recap" as const, startMs: 5_000, endMs: 30_000 },
  ];
  assert.deepEqual(keptRanges(windows, 30_000), []);
});

test("the engine reports ffmpeg as available", async () => {
  const cuts = new CutEngine(settings());
  const status = await cuts.start();
  assert.equal(status.ok, true, status.detail);
  assert.equal(cuts.enabled, true);
});

test("cutting a real file writes a shorter file and caches it", async () => {
  const cuts = new CutEngine(settings());
  await cuts.start();
  const url = `${base}/sample.mkv`;

  const state = cuts.schedule(url, [INTRO]);
  // With concurrency available it has already started; either way it is a job now.
  assert.ok(["queued", "running"].includes(state.status), `unexpected status ${state.status}`);
  const cutPath = await cuts.waitFor(cuts.keyFor(url, [INTRO]), 120_000);
  assert.ok(cutPath, `cut failed: ${JSON.stringify(cuts.state(cuts.keyFor(url, [INTRO])))}`);

  const info = await stat(cutPath);
  assert.ok(info.size > 0, "the cut file has bytes");
  const duration = await durationOf(cutPath);
  // The window is 3s of a 30s file. Nothing is re-encoded, so the copy can only be
  // as precise as the keyframe grid: the result must lose most of the window, and
  // no more than the window plus a couple of keyframes.
  const removed = SAMPLE_SECONDS * 1000 - duration;
  assert.ok(removed > 1500, `expected most of the 3000ms window gone, removed ${removed}ms`);
  assert.ok(removed < 5000, `expected no more than the window plus slack, removed ${removed}ms`);

  const state2 = cuts.state(cuts.keyFor(url, [INTRO]));
  assert.equal(state2?.status, "ready");
  assert.equal(state2?.container, "mkv");

  // A second playback is a cache hit: same path, no second remux.
  const again = await cuts.waitFor(cuts.keyFor(url, [INTRO]), 5_000);
  assert.equal(again, cutPath);
});

test("the same file with different windows is a different cut", async () => {
  const cuts = new CutEngine(settings());
  await cuts.start();
  const url = `${base}/sample.mkv`;
  const other = { type: "recap" as const, startMs: 0, endMs: 4_000 };

  assert.notEqual(cuts.keyFor(url, [INTRO]), cuts.keyFor(url, [other]));
  cuts.schedule(url, [other]);
  const cutPath = await cuts.waitFor(cuts.keyFor(url, [other]), 120_000);
  assert.ok(cutPath);
  const duration = await durationOf(cutPath);
  const removed = SAMPLE_SECONDS * 1000 - duration;
  assert.ok(removed > 2000, `expected most of the 4000ms window gone, removed ${removed}ms`);
  assert.ok(removed < 6000, `expected no more than the window plus slack, removed ${removed}ms`);
});

test("an HLS source is skipped: there is nothing to remux, that is a playlist", async () => {
  const cuts = new CutEngine(settings());
  await cuts.start();
  const url = `${base}/master.m3u8`;

  cuts.schedule(url, [INTRO]);
  await cuts.waitFor(cuts.keyFor(url, [INTRO]), 30_000);
  const state = cuts.state(cuts.keyFor(url, [INTRO]));
  assert.equal(state?.status, "skipped", `unexpected status ${state?.status}: ${state?.error}`);
  assert.equal(state?.path, undefined, "no file was written for a playlist");
});

test("an unreachable source fails the cut instead of hanging", async () => {
  const cuts = new CutEngine(settings());
  await cuts.start();
  const url = "http://127.0.0.1:1/not-there.mkv";
  cuts.schedule(url, [INTRO]);
  await cuts.waitFor(cuts.keyFor(url, [INTRO]), 60_000);
  const state = cuts.state(cuts.keyFor(url, [INTRO]));
  assert.equal(state?.status, "failed");
  assert.ok((state?.error ?? "").length > 0);
});

test("cuts can be switched off entirely", async () => {
  const cuts = new CutEngine(settings({ cuts: "off" }));
  const status = await cuts.start();
  assert.equal(status.ok, true);
  assert.equal(cuts.enabled, false);
});

test("eviction keeps the cache under its limit, oldest file first", async () => {
  // Start unlimited so the first cut's size can be measured, then tighten the
  // budget to less than two cuts' worth.
  const value = settings({ cacheMaxBytes: 0 });
  const cuts = new CutEngine(value);
  await cuts.start();
  const url = `${base}/sample.mkv`;
  const introKey = cuts.keyFor(url, [INTRO]);
  const recap = { type: "recap" as const, startMs: 0, endMs: 4_000 };
  const recapKey = cuts.keyFor(url, [recap]);

  cuts.schedule(url, [INTRO]);
  const introPath = await cuts.waitFor(introKey, 120_000);
  assert.ok(introPath);
  const oneCut = (await stat(introPath)).size;
  value.cacheMaxBytes = Math.ceil(oneCut * 1.5);

  // Make the first cut unambiguously the older one.
  await utimes(introPath, new Date(0), new Date(0));

  cuts.schedule(url, [recap]);
  const recapPath = await cuts.waitFor(recapKey, 120_000);
  assert.ok(recapPath, `cut failed: ${JSON.stringify(cuts.state(recapKey))}`);

  await assert.rejects(stat(introPath), "the older cut is evicted once the budget is exceeded");
  assert.ok((await stat(recapPath)).size > 0, "the newest cut survives");
  assert.equal(await cuts.ready(introKey), null, "an evicted cut is forgotten, so it can be redone");
});

test("a cut file is served with range support", async () => {
  const cuts = new CutEngine(settings());
  await cuts.start();
  const url = `${base}/sample.mkv`;
  cuts.schedule(url, [INTRO]);
  const cutPath = await cuts.waitFor(cuts.keyFor(url, [INTRO]), 120_000);
  assert.ok(cutPath);

  const whole = await serveFile(new Request("https://addon.test/play"), cutPath, "mkv");
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get("accept-ranges"), "bytes");
  assert.equal(whole.headers.get("content-type"), "video/x-matroska");
  const bytes = new Uint8Array(await whole.arrayBuffer());
  assert.equal(bytes.length, Number(whole.headers.get("content-length")));
  assert.equal(bytes[0], 0x1a, "the file starts with an EBML header");

  const ranged = await serveFile(
    new Request("https://addon.test/play", { headers: { range: "bytes=0-3" } }),
    cutPath,
    "mkv",
  );
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get("content-range"), `bytes 0-3/${bytes.length}`);
  assert.deepEqual([...new Uint8Array(await ranged.arrayBuffer())], [...bytes.subarray(0, 4)]);

  const head = await serveFile(
    new Request("https://addon.test/play", { method: "HEAD" }),
    cutPath,
    "mkv",
  );
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");

  const bad = await serveFile(
    new Request("https://addon.test/play", { headers: { range: "bytes=99999999-" } }),
    cutPath,
    "mkv",
  );
  assert.equal(bad.status, 416);
  assert.equal(bad.headers.get("content-range"), `bytes */${bytes.length}`);
});
