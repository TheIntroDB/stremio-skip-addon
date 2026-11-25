// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * The subtitle track as a player sees it.
 *
 * The recogniser is stubbed here on purpose: what matters is not whether a model heard a word but
 * whether the *track* is delivered, and that is the part that failed in the field -- a finished
 * file offered through the addon's subtitles menu can never arrive mid-playback, so the track is
 * delivered as a growing HLS subtitle rendition instead (see `src/subtitles.ts`). The audio
 * extraction is real, so the path from source to segments is exercised end to end.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { run } from "../src/ffmpeg.js";
import { handleSubtitleChunk, handleSubtitlePlaylist, SubtitleEngine } from "../src/subtitles.js";
import type { Transcriber } from "../src/transcribe.js";
import type { Settings } from "../src/env.js";

const CARD_MS = 10_000;
const SECONDS = 70;

/** A recogniser that says the same thing in every chunk, instantly. */
const stubTranscriber = (): Transcriber =>
  ({
    lastError: null,
    available: async () => true,
    transcribe: async () => ({
      text: "hello world",
      words: [
        { text: "Hello", start: 1.5, end: 1.9 },
        { text: "world", start: 2.1, end: 2.6 },
      ],
      realtimeFactor: 20,
      engine: "stub",
      language: "en",
    }),
    refine: async (_wav: string, words: unknown) => words,
  }) as unknown as Transcriber;

async function fixture(): Promise<{ cacheDir: string; audio: string; settings: Settings }> {
  const dir = await mkdtemp(path.join(tmpdir(), "tidb-subs-"));
  const audio = path.join(dir, "source.wav");
  const made = await run("ffmpeg", [
    "-nostdin", "-hide_banner", "-v", "error", "-y",
    "-f", "lavfi", "-i", `sine=frequency=220:duration=${SECONDS}`,
    "-ac", "1", "-ar", "16000", audio,
  ], 120_000);
  assert.equal(made.code, 0, `could not make the fixture: ${made.stderr}`);
  return {
    cacheDir: dir,
    audio,
    settings: {
      cacheDir: dir,
      ffmpegPath: "ffmpeg",
      subtitles: true,
      subtitlesLanguage: "en",
      subtitlesTtlHours: 24,
      subtitlesChunkSeconds: 30,
      splash: true,
    } as unknown as Settings,
  };
}

test("the playlist grows chunk by chunk, and only then closes", async () => {
  const { audio, settings } = await fixture();
  const engine = new SubtitleEngine(settings, stubTranscriber());
  const plan = { durationMs: SECONDS * 1000, windows: [], cardMs: CARD_MS };
  assert.ok(engine.ensure("key1", audio, plan, true), "a track is planned");

  // Straight away: the film's own first segment, and a list that may still grow.
  const started = await engine.playlist("key1", CARD_MS);
  assert.ok(started, "the playlist is served before any of it is made");
  assert.ok(started!.body.includes("#EXT-X-PLAYLIST-TYPE:EVENT"), "an event playlist");
  assert.ok(!started!.body.includes("#EXT-X-ENDLIST"), "with no end while the work goes on");
  assert.ok(started!.body.includes("c=card"), "the processing card is covered first");
  assert.equal(started!.complete, false);

  const deadline = Date.now() + 120_000;
  let done = started!;
  while (!done.complete && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    done = (await engine.playlist("key1", CARD_MS))!;
  }
  assert.equal(done.complete, true, "and it finishes");
  assert.ok(done.body.includes("#EXT-X-PLAYLIST-TYPE:VOD"), "as a finished playlist");
  assert.ok(done.body.includes("#EXT-X-ENDLIST"), "that a player may keep");

  // The positions a player reconstructs from the durations have to be the video's timeline:
  // the card first, then every chunk of the source in order.
  const durations = [...done.body.matchAll(/#EXTINF:([\d.]+),/g)].map((m) => Number(m[1]));
  assert.equal(durations.length, 4, "the card and three chunks of thirty, thirty and ten");
  assert.deepEqual(durations, [10, 30, 30, 10]);
  const total = durations.reduce((sum, part) => sum + part, 0);
  assert.equal(total, (CARD_MS + SECONDS * 1000) / 1000, "which is exactly the video's length");
  const uris = [...done.body.matchAll(/^vtt\?f=[^\n]+$/gm)].map((m) => m[0]);
  assert.deepEqual(uris, [
    "vtt?f=key1&c=card",
    "vtt?f=key1&c=0",
    "vtt?f=key1&c=1",
    "vtt?f=key1&c=2",
  ], "and every position points at its own segment, in order");
});

test("a segment holds cues relative to itself, which is what HLS requires", async () => {
  const { audio, settings } = await fixture();
  const engine = new SubtitleEngine(settings, stubTranscriber());
  engine.ensure("key2", audio, { durationMs: SECONDS * 1000, windows: [], cardMs: CARD_MS }, true);
  const deadline = Date.now() + 120_000;
  let text = "";
  while (Date.now() < deadline) {
    const file = await engine.chunkFile("key2", "1");
    if (file) {
      text = await readFile(file, "utf8");
      if (text.length > "WEBVTT".length + 10) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(text.startsWith("WEBVTT"), "a WebVTT segment");
  // The stub says 1.5s in every chunk. Relative to its own segment, that is 1.5s here too --
  // in absolute terms the second chunk would be at 31.5s, and a player would show it a
  // half-minute late or not at all.
  assert.match(text, /00:00:01\.500 --> 00:00:02\.600/, "and its cues start inside itself");
  assert.ok(!text.includes("NOTE"), "each segment carries only its own cues");
});

test("the playlist is never cached, the segments are", async () => {
  const { audio, settings } = await fixture();
  const engine = new SubtitleEngine(settings, stubTranscriber());
  engine.ensure("key3", audio, { durationMs: SECONDS * 1000, windows: [], cardMs: CARD_MS }, true);

  const list = await handleSubtitlePlaylist(
    { settings, subtitles: engine, request: new Request("http://localhost/cfg/subs.m3u8?f=key3") },
    CARD_MS,
  );
  assert.equal(list.status, 200);
  assert.match(list.headers.get("content-type") ?? "", /mpegurl/);
  assert.equal(list.headers.get("cache-control"), "no-cache", "it is read again as chunks arrive");

  const deadline = Date.now() + 120_000;
  let chunk = await handleSubtitleChunk(
    { settings, subtitles: engine, request: new Request("http://localhost/cfg/vtt?f=key3&c=0") },
    "key3",
    "0",
  );
  while (chunk.status !== 200 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    chunk = await handleSubtitleChunk(
      { settings, subtitles: engine, request: new Request("http://localhost/cfg/vtt?f=key3&c=0") },
      "key3",
      "0",
    );
  }
  assert.equal(chunk.status, 200, "a written segment is served");
  assert.match(chunk.headers.get("content-type") ?? "", /text\/vtt/);
  assert.equal(chunk.headers.get("cache-control"), "public, max-age=86400", "and kept for the day");
  const missing = await handleSubtitleChunk(
    { settings, subtitles: engine, request: new Request("http://localhost/cfg/vtt?f=key3&c=99") },
    "key3",
    "99",
  );
  assert.equal(missing.status, 404, "one that is not written yet is a 404, not an empty track");
});

test("nothing is planned without the source's length or an install that asked", async () => {
  const { audio, settings } = await fixture();
  const engine = new SubtitleEngine(settings, stubTranscriber());
  const windows = [{ type: "intro" as const, startMs: 5_000, endMs: 9_000 }];
  // The last window would be open-ended, so every offset after it would be a guess -- and a
  // guessed offset is exactly the misaligned subtitle this exists to avoid.
  assert.equal(
    engine.ensure("k", audio, { durationMs: null, windows, cardMs: CARD_MS }, true),
    null,
  );
  // Not asked for: no job, no model, no CPU.
  assert.equal(
    engine.ensure("k2", audio, { durationMs: 60_000, windows, cardMs: CARD_MS }, false),
    null,
  );
  assert.equal(await engine.playlist("k", CARD_MS), null, "and no playlist for a track nobody wanted");
});

test("a player that asks too early gets a valid playlist, not a 404", async () => {
  // This is what a player does: it reads the rendition once, when it loads the master. A missing
  // playlist at that moment is a track it drops for the rest of the film, however many chunks
  // arrive afterwards -- so the answer is an empty EVENT playlist that says "keep asking".
  const { settings } = await fixture();
  const engine = new SubtitleEngine(settings, stubTranscriber());
  const response = await handleSubtitlePlaylist(
    { settings, subtitles: engine, request: new Request("http://localhost/cfg/subs.m3u8?f=nothing") },
    CARD_MS,
  );
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.ok(body.startsWith("#EXTM3U"), "a playlist");
  assert.ok(body.includes("#EXT-X-PLAYLIST-TYPE:EVENT"), "that may still grow");
  assert.ok(!body.includes("#EXT-X-ENDLIST"), "and has not finished");
  assert.ok(body.includes("#EXT-X-TARGETDURATION"), "with a reload cadence");
  assert.equal(engine.served.playlists, 1, "and it is counted, so /health can see it");
});
