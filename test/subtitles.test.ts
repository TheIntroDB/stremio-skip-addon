// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * The subtitle track as a player sees it.
 *
 * The recogniser is stubbed here on purpose: what matters is not whether a model heard a word but
 * whether the *track* is delivered, and that is the part that failed in the field -- a finished
 * file offered through the addon's subtitles menu can never arrive mid-playback, so the track is
 * delivered as a growing HLS subtitle rendition instead (see `src/subtitles/subtitles.ts`). The audio
 * extraction is real, so the path from source to segments is exercised end to end.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { encodeConfig } from "../src/addon/config.js";
import type { Settings } from "../src/addon/env.js";
import { handleRequest } from "../src/index.js";
import { run } from "../src/streams/ffmpeg.js";
import { PackageEngine } from "../src/streams/packages.js";
import {
  chooseAudio,
  chooseSourceTrack,
  masterPlaylist,
  parseProbe,
  variantAttributes,
} from "../src/streams/streaminfo.js";
import {
  handleSubtitleChunk,
  handleSubtitlePlaylist,
  SubtitleEngine,
} from "../src/subtitles/subtitles.js";
import type { Transcriber } from "../src/subtitles/transcribe.js";

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
  const made = await run(
    "ffmpeg",
    [
      "-nostdin",
      "-hide_banner",
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=220:duration=${SECONDS}`,
      "-ac",
      "1",
      "-ar",
      "16000",
      audio,
    ],
    120_000,
  );
  assert.equal(made.code, 0, `could not make the fixture: ${made.stderr}`);
  return {
    cacheDir: dir,
    audio,
    settings: {
      cacheDir: dir,
      ffmpegPath: "ffmpeg",
      subtitles: true,
      subtitlesGenerate: true,
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
  assert.ok(
    started!.body.includes("#EXT-X-START:TIME-OFFSET=0"),
    "joined at the head, not at the live edge of an event playlist",
  );
  assert.ok(!started!.body.includes("#EXT-X-ENDLIST"), "with no end while the work goes on");
  assert.ok(started!.body.includes("subs/card.vtt"), "the processing card is covered first");
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
  const uris = [...done.body.matchAll(/^subs\/[^\n]+$/gm)].map((m) => m[0]);
  assert.deepEqual(
    uris,
    ["subs/card.vtt?f=key1", "subs/0.vtt?f=key1", "subs/1.vtt?f=key1", "subs/2.vtt?f=key1"],
    "and every position points at its own segment, in order",
  );
  // Every URI in this playlist has to end in an extension ffmpeg's HLS demuxer accepts for a
  // subtitle segment: it refuses one with no extension at all (`av_match_ext` returns 0), and a
  // refused segment takes the whole rendition playlist down -- which an ffmpeg-8 client reads as
  // a film with no streams at all.
  for (const uri of uris) {
    assert.match(uri, /\.(vtt|webvtt)\?/, `"${uri}" needs a subtitle extension`);
    assert.ok(!uri.includes("&c="), "the name is in the path, not a query parameter");
  }
});

test("a track nobody is watching stops, and keeps what it made", async () => {
  // Recognition is minutes of CPU for one episode. A viewer who closes the player used to leave
  // the job running to the end of the file; with `subtitlesIdleSeconds` it stops, and the chunks
  // already written are the record a later playback resumes from.
  const { audio, settings } = await fixture();
  const slow = stubTranscriber();
  const engine = new SubtitleEngine(
    { ...settings, subtitlesIdleSeconds: 1 } as unknown as Settings,
    {
      ...slow,
      // Long enough that the idle check bites between chunks rather than inside one.
      transcribe: async (wav: string) => {
        await new Promise((resolve) => setTimeout(resolve, 700));
        return slow.transcribe(wav, "en");
      },
    } as unknown as Transcriber,
    // The viewer left a minute ago: no playlist and no segment has been asked for since.
    () => Date.now() - 60_000,
  );
  const plan = { durationMs: SECONDS * 1000, windows: [], cardMs: CARD_MS };
  assert.ok(engine.ensure("key5", audio, plan, true), "a track is planned");

  const deadline = Date.now() + 20_000;
  let status = engine.status() as Record<string, unknown>;
  while (Date.now() < deadline && status.active !== 0) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    status = engine.status() as Record<string, unknown>;
  }

  assert.equal(status.active, 0, "the worker is not left pumping");
  assert.equal(status.stopped, 1, "and it says why it stopped");
  const progress = status.progress as Array<{ done: number; chunks: number; idle: boolean }>;
  assert.equal(progress[0]!.idle, true, "the track is marked idle, not failed");
  assert.ok(progress[0]!.done > 0, `something was recognised (${progress[0]!.done} chunks)`);
  assert.ok(progress[0]!.done < progress[0]!.chunks, "and not the whole file");

  // What it wrote stays readable, and the playlist ends at the last written chunk rather than
  // pointing at one that does not exist.
  const served = (await engine.playlist("key5", CARD_MS))!;
  assert.equal(served.complete, false, "an idle track is not a finished one");
  assert.ok(!served.body.includes("#EXT-X-ENDLIST"), "so it is still an event playlist");
  const entries = served.body.matchAll(/^#EXTINF:/gm);
  assert.equal(
    [...entries].length,
    progress[0]!.done + 1,
    "the card plus exactly the chunks that exist",
  );
});

/**
 * Peak amplitude of a 16-bit PCM wav, which is how two audio tracks are told apart here: one is
 * silence and the other is a tone, so the peak says which stream ffmpeg actually read.
 */
async function peakAmplitude(file: string): Promise<number> {
  const buf = await readFile(file);
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "data") {
      let peak = 0;
      const end = Math.min(buf.length, offset + 8 + size);
      for (let i = offset + 8; i + 1 < end; i += 2) {
        peak = Math.max(peak, Math.abs(buf.readInt16LE(i)));
      }
      return peak;
    }
    offset += 8 + size + (size % 2);
  }
  return 0;
}

/** A file with two audio tracks: silence tagged Spanish, a tone tagged English. */
async function twoAudioFixture(): Promise<{ file: string; cacheDir: string; settings: Settings }> {
  const dir = await mkdtemp(path.join(tmpdir(), "tidb-two-audio-"));
  const file = path.join(dir, "two-audio.mkv");
  const made = await run(
    "ffmpeg",
    [
      "-nostdin",
      "-hide_banner",
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=160x120:rate=5:duration=24",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=48000:cl=mono",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=24",
      "-t",
      "24",
      "-map",
      "0:v",
      "-map",
      "1:a",
      "-map",
      "2:a",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-c:a",
      "aac",
      "-metadata:s:a:0",
      "language=spa",
      "-metadata:s:a:1",
      "language=eng",
      file,
    ],
    120_000,
  );
  assert.equal(made.code, 0, `could not make the fixture: ${made.stderr}`);
  return {
    file,
    cacheDir: dir,
    settings: {
      cacheDir: dir,
      ffmpegPath: "ffmpeg",
      ffprobePath: "ffprobe",
      subtitles: true,
      subtitlesGenerate: true,
      subtitlesLanguage: "en",
      subtitlesTtlHours: 24,
      subtitlesIdleSeconds: 0,
      subtitlesChunkSeconds: 30,
      splash: false,
    } as unknown as Settings,
  };
}

test("the audio track is chosen by language, and English is the fallback", async () => {
  const { file } = await twoAudioFixture();
  const probe = await run(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration,bit_rate:stream=index,codec_type,codec_name,profile,level,width,height" +
        ":stream_tags=language:stream_disposition=default",
      "-of",
      "json",
      file,
    ],
    30_000,
  );
  const info = parseProbe(probe.stdout)!;
  assert.deepEqual(
    info.audio?.map((track) => track.language),
    ["es", "en"],
    "the container's tags normalised to two letters",
  );

  assert.equal(chooseAudio(info.audio, "en")!.language, "en", "what the model is trained on");
  assert.equal(
    chooseAudio(info.audio, "spa")!.language,
    "es",
    "a three-letter request still matches",
  );
  assert.equal(chooseAudio(info.audio, "de")!.language, "en", "missing: English instead");
  // No English in the file at all: the file's own default track, then its first.
  const german = [{ index: 7, language: "de", isDefault: true }];
  assert.equal(chooseAudio(german, "en")!.index, 7, "no English: the file's default track");
  assert.equal(
    chooseAudio([{ index: 9, language: "fr", isDefault: false }], "en")!.index,
    9,
    "no English and no default: its first track",
  );
  assert.equal(chooseAudio(undefined, "en"), null, "an unreadable probe leaves it to ffmpeg");
});

test("a 4K HEVC source is described as HEVC, not left for the player to guess", () => {
  // A master with no `CODECS` lets a player assume AVC. hls.js builds an AVC MediaSource, feeds it
  // HEVC, and the viewer gets a black picture with the audio playing -- which is exactly what a
  // 4K HEVC source produced before this said what it is.
  const info = parseProbe(
    JSON.stringify({
      format: { duration: "1500.0", bit_rate: "5359114" },
      streams: [
        {
          index: 0,
          codec_type: "video",
          codec_name: "hevc",
          profile: "Main 10",
          level: 153,
          width: 3840,
          height: 2160,
        },
        { index: 1, codec_type: "audio", codec_name: "eac3" },
      ],
    }),
  )!;
  assert.equal(info.codecs, "hvc1.2.4.L153.B0,ec-3");
  assert.ok(
    variantAttributes(info, true).includes('CODECS="hvc1.2.4.L153.B0,ec-3"'),
    "and the variant carries it",
  );

  // A profile that cannot be named is left undeclared rather than guessed at.
  const unnamed = parseProbe(
    JSON.stringify({
      format: { duration: "10.0" },
      streams: [
        { index: 0, codec_type: "video", codec_name: "hevc", profile: "Main 4:4:4", level: 120 },
      ],
    }),
  )!;
  assert.equal(unnamed.codecs, "", "no spelling rather than a wrong one");
  // The name is still there for the packaging decision: a HEVC package written as TS is a black
  // picture in every browser, whether or not the codec string could be spelled.
  assert.equal(unnamed.video, "hevc");
});

test("a source's own text subtitles are found, and image ones are not", () => {
  const info = parseProbe(
    JSON.stringify({
      format: { duration: "60.0" },
      streams: [
        {
          index: 0,
          codec_type: "video",
          codec_name: "h264",
          profile: "High",
          level: 40,
          width: 1920,
          height: 1080,
        },
        { index: 1, codec_type: "audio", codec_name: "aac" },
        { index: 2, codec_type: "subtitle", codec_name: "subrip", tags: { language: "eng" } },
        {
          index: 3,
          codec_type: "subtitle",
          codec_name: "hdmv_pgs_subtitle",
          tags: { language: "eng" },
        },
        { index: 4, codec_type: "subtitle", codec_name: "ass", tags: { language: "spa" } },
      ],
    }),
  )!;
  // A picture track needs OCR, so it is not something this can copy: only text is listed.
  assert.deepEqual(
    info.subtitles!.map((track) => track.index),
    [2, 4],
    "text tracks only",
  );
  const tracks = info.subtitles!;
  assert.equal(chooseSourceTrack(tracks, "es")!.index, 4, "the language the install asked for");
  assert.equal(chooseSourceTrack(tracks, "de")!.index, 2, "then English");
  assert.equal(
    chooseSourceTrack([{ index: 4, language: "es", codec: "ass" }], "de")!.index,
    4,
    "and any of them is better than none",
  );
  assert.equal(chooseSourceTrack(undefined, "en"), null, "nothing to choose from");
});

test("generation is off unless the deployment asks for it", async () => {
  // Recognition is minutes of CPU per episode, so the shipped service does not do it at all: a
  // file with no text track gets no track, and nothing is planned, loaded or spawned. What ships
  // is the source's own subtitles, which cost a demux and some arithmetic and are not gated.
  const { settings } = await fixture();
  const quiet = new SubtitleEngine({ ...settings, subtitlesGenerate: false }, stubTranscriber());
  const plan = { durationMs: 60_000, windows: [], cardMs: 0 };

  assert.equal(
    quiet.ensure("pkg", "http://source/film.mkv", plan, true, { index: 1, language: "en" }),
    null,
    "no track is planned for a file that has no text subtitles",
  );
  assert.equal(quiet.trackFor("pkg"), null, "and nothing is offered to a player");
  assert.equal(quiet.status().generate, false, "which /health says");

  // The file's own track is still taken: that is the whole point of shipping this.
  assert.ok(
    quiet.ensure("pkg", "http://source/film.mkv", plan, true, undefined, {
      index: 2,
      language: "en",
    }),
    "a text track is planned even with generation off",
  );
});

test("a source's subtitles are cut and shifted onto the film", async () => {
  // Every cue has to land where the picture is: the ones inside a dropped window go, and the ones
  // after it move back by what was removed. This is the same timeline the generated track uses,
  // so a player cannot tell where the cues came from.
  const { settings } = await fixture();
  const engine = new SubtitleEngine(settings, stubTranscriber());
  const plan = {
    durationMs: 60_000,
    windows: [{ type: "intro" as const, startMs: 10_000, endMs: 20_000 }],
    cardMs: 0,
  };
  const dir = path.join(settings.cacheDir, "subs", "pkg.s2");
  await mkdir(dir, { recursive: true });
  // What ffmpeg leaves behind after demuxing the source's own track.
  await writeFile(
    path.join(dir, "source-2.vtt"),
    [
      "WEBVTT",
      "",
      "00:00:02.000 --> 00:00:05.000",
      "before the intro",
      "",
      "00:00:14.000 --> 00:00:16.000",
      "inside the intro",
      "",
      "00:00:22.000 --> 00:00:25.000",
      "after the intro",
      "",
    ].join("\n"),
  );

  assert.ok(
    engine.ensure("pkg", "http://source/film.mkv", plan, true, undefined, {
      index: 2,
      language: "eng",
    }),
    "a track is planned",
  );
  const track = engine.trackFor("pkg")!;
  assert.equal(track, "pkg.s2", "keyed by the source track it copied, not by an audio stream");
  assert.equal(engine.languageOf(track), "eng", "and knows what language it is");

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const progress = (engine.status() as { progress: Array<{ done: number; chunks: number }> })
      .progress;
    if (progress[0] && progress[0].chunks === 0) break;
    if (progress[0] && progress[0].done >= progress[0].chunks && progress[0].chunks > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  // 0-10s kept, 20-60s kept, 30-second chunks: 10s, 30s, 10s.
  const list = (await engine.playlist(track, 0))!;
  assert.ok(list.body.includes("#EXTINF:10.000,"), "the first kept stretch");
  assert.ok(list.body.includes("#EXTINF:30.000,"), "the long one");
  assert.equal(list.complete, true, "and it closes, since nothing is being recognised");

  const chunk = async (index: number): Promise<string> => {
    const name = `chunk-${String(index).padStart(5, "0")}.vtt`;
    return readFile(path.join(dir, name), "utf8").catch(() => "");
  };
  const first = await chunk(0);
  assert.ok(first.includes("before the intro"), "a cue from the head of the film");
  assert.ok(first.includes("00:00:02.000 --> 00:00:05.000"), "at the time it always had");
  assert.ok(!first.includes("inside the intro"), "the dropped window takes its cues with it");
  const second = await chunk(1);
  assert.ok(second.includes("after the intro"), "a cue from after the cut");
  assert.ok(
    second.includes("00:00:02.000 --> 00:00:05.000"),
    "moved back by the ten seconds removed",
  );
  assert.ok(!second.includes("inside the intro"), "and nothing from the window");
});

test("the recogniser is fed the chosen stream, not ffmpeg's own preference", async () => {
  const { file, settings } = await twoAudioFixture();
  const info = parseProbe(
    (
      await run(
        "ffprobe",
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration,bit_rate:stream=index,codec_type,codec_name,profile,level,width,height" +
            ":stream_tags=language:stream_disposition=default",
          "-of",
          "json",
          file,
        ],
        30_000,
      )
    ).stdout,
  )!;
  const englishTrack = chooseAudio(info.audio, "en")!;
  const spanishTrack = chooseAudio(info.audio, "spa")!;
  assert.notEqual(englishTrack.index, spanishTrack.index, "two different streams to tell apart");

  const peaks = new Map<string, number>();
  const recording = (label: string) =>
    ({
      lastError: null,
      available: async () => true,
      transcribe: async (wav: string) => {
        peaks.set(label, await peakAmplitude(wav));
        return { text: "", words: [], realtimeFactor: 1, engine: "stub", language: "en" };
      },
      refine: async (_wav: string, words: unknown) => words,
    }) as unknown as Transcriber;

  const plan = { durationMs: 24_000, windows: [], cardMs: 0 };
  const english = new SubtitleEngine(settings, recording("en"));
  english.ensure("k-en", file, plan, true, englishTrack);
  const spanish = new SubtitleEngine(settings, recording("es"));
  spanish.ensure("k-es", file, plan, true, spanishTrack);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && (peaks.size < 2 || english.working() || spanish.working())) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.ok((peaks.get("en") ?? 0) > 1000, `the English track was read (peak ${peaks.get("en")})`);
  assert.equal(peaks.get("es"), 0, "and the Spanish one is the silence it actually is");
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
    { settings, subtitles: engine, request: new Request("http://localhost/cfg/subs/0.vtt?f=key3") },
    "key3",
    "0",
  );
  while (chunk.status !== 200 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    chunk = await handleSubtitleChunk(
      {
        settings,
        subtitles: engine,
        request: new Request("http://localhost/cfg/subs/0.vtt?f=key3"),
      },
      "key3",
      "0",
    );
  }
  assert.equal(chunk.status, 200, "a written segment is served");
  assert.match(chunk.headers.get("content-type") ?? "", /text\/vtt/);
  assert.equal(chunk.headers.get("cache-control"), "public, max-age=86400", "and kept for the day");
  const missing = await handleSubtitleChunk(
    {
      settings,
      subtitles: engine,
      request: new Request("http://localhost/cfg/subs/99.vtt?f=key3"),
    },
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
  assert.equal(
    await engine.playlist("k", CARD_MS),
    null,
    "and no playlist for a track nobody wanted",
  );
});

test("a player that asks too early gets a valid playlist, not a 404", async () => {
  // This is what a player does: it reads the rendition once, when it loads the master. A missing
  // playlist at that moment is a track it drops for the rest of the film, however many chunks
  // arrive afterwards -- so the answer is an empty EVENT playlist that says "keep asking".
  const { settings } = await fixture();
  const engine = new SubtitleEngine(settings, stubTranscriber());
  const response = await handleSubtitlePlaylist(
    {
      settings,
      subtitles: engine,
      request: new Request("http://localhost/cfg/subs.m3u8?f=nothing"),
    },
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

test("a rendition with nothing in it yet still carries a segment", async () => {
  // A player fixes its subtitle stream list when it loads the rendition, and an *empty* EVENT
  // playlist makes ffmpeg create no subtitle stream at all -- measured: video and audio only. So
  // the answer before the first chunk exists is one zero-length placeholder, which moves no
  // position on the timeline.
  const { settings } = await fixture();
  const engine = new SubtitleEngine(settings, stubTranscriber());
  const empty = await handleSubtitlePlaylist(
    {
      settings,
      subtitles: engine,
      request: new Request("http://localhost/cfg/subs.m3u8?f=nothing"),
    },
    0,
  );
  const body = await empty.text();
  assert.equal(empty.status, 200, "never a 404");
  assert.match(body, /#EXTINF:0\.000,/, "and one segment, of no length");
  assert.match(body, /subs\/placeholder\.vtt\?f=nothing/, "pointing at the placeholder");

  const placeholder = await handleSubtitleChunk(
    {
      settings,
      subtitles: engine,
      request: new Request("http://localhost/cfg/subs/placeholder.vtt?f=nothing"),
    },
    "nothing",
    "placeholder",
  );
  assert.equal(placeholder.status, 200, "which is served");
  assert.equal((await placeholder.text()).trim(), "WEBVTT", "as a subtitle segment with no cues");
});

test("the rendition and its chunks are reachable through the router", async () => {
  // Every other test here calls the handlers directly, and that is exactly how the route
  // pattern in src/index.ts went a release without listing `subs.m3u8`/`vtt`: a real deployment
  // answered 404 to both while this suite was green, so no client anywhere could get the track.
  // A player asks the *router*, so this drives the real entry point and fails on that 404.
  const { audio, settings } = await fixture();
  const engine = new SubtitleEngine(settings, stubTranscriber());
  engine.ensure("key4", audio, { durationMs: SECONDS * 1000, windows: [], cardMs: CARD_MS }, true);
  const encoded = encodeConfig({
    src: ["http://origin.example/manifest.json"],
    types: ["intro"],
    subtitles: true,
  });
  const routerSettings = {
    ...settings,
    splash: true,
    prerollSeconds: CARD_MS / 1000,
  } as unknown as Settings;
  const packages = new PackageEngine(routerSettings);

  const list = await handleRequest(
    new Request(`https://worker.example/${encoded}/subs.m3u8?f=key4`),
    routerSettings,
    packages,
    engine,
  );
  assert.equal(list.status, 200, "the rendition playlist is routed, not a 404");
  assert.match(list.headers.get("content-type") ?? "", /mpegurl/);
  const body = await list.text();
  assert.match(body, /^#EXTM3U/, "and it is a playlist");

  // And the length the video's own playlist declared travels in the URI: a rendition asked for a
  // playback with a two-second card has to open with a two-second card segment, or every cue in it
  // sits one card late.
  const withCard = await handleRequest(
    new Request(`https://worker.example/${encoded}/subs.m3u8?f=key4&c=2.000`),
    routerSettings,
    packages,
    engine,
  );
  assert.equal(withCard.status, 200, "the card-carrying rendition is routed too");
  assert.match(
    await withCard.text(),
    /#EXTINF:2\.000,\nsubs\/card\.vtt/,
    "and it opens on the card",
  );

  // Whatever it lists has to be reachable: the rendition's entries are the one promise a player
  // relies on, and a track with nothing in it yet lists its placeholder.
  const uri = /\n([^#\n][^\n]*)\n/.exec(`${body}\n`)?.[1] ?? "";
  assert.ok(uri.startsWith("subs/"), `the rendition lists a chunk (${uri || "none"})`);
  const chunk = await handleRequest(
    new Request(`https://worker.example/${encoded}/${uri}`),
    routerSettings,
    packages,
    engine,
  );
  assert.equal(chunk.status, 200, "and a chunk of it is routed too");
  assert.match(chunk.headers.get("content-type") ?? "", /text\/vtt/);
  assert.match(await chunk.text(), /^WEBVTT/, "which is WebVTT, not the not-found page");
  assert.equal(engine.served.chunks, 1, "and it is counted, so /health can see it");
});

test("the master's rendition line is one a strict parser accepts", async () => {
  // `LANGUAGE=en` is a quoted-string attribute, and unquoted it makes the whole `#EXT-X-MEDIA`
  // line unparseable -- a real bug that is fixed here. It is *not* why IINA (mpv) showed no
  // subtitle track: mpv's demuxer refuses a subtitle rendition outright below ffmpeg 8, and no
  // attribute can fix that (see the note on `masterPlaylist` in src/streams/streaminfo.ts).
  const master = masterPlaylist({
    mediaUri: "/cfg/play?u=x&m=1",
    subtitleUri: "subs.m3u8?f=key",
    language: "en",
    name: "TheIntroDB",
    info: {
      durationMs: 60_000,
      bitrate: 5_300_000,
      width: 1920,
      height: 1080,
      codecs: "avc1.640028,mp4a.40.2",
    },
  });
  const media = master.split("\n").find((line) => line.startsWith("#EXT-X-MEDIA"))!;
  assert.ok(media.includes("TYPE=SUBTITLES"), "a subtitle rendition");
  assert.ok(media.includes('GROUP-ID="subs"'), "in the group the variant claims");
  assert.ok(media.includes('LANGUAGE="en"'), "with its language quoted, as HLS requires");
  assert.ok(media.includes('URI="subs.m3u8?f=key"'), "and a URI to read");
  assert.ok(!media.includes("FORCED"), "and not marked forced: these are the whole track");
  // A playlist that is still growing is an EVENT one, and a player joins an EVENT playlist at its
  // live edge -- which, with the episode's length declared up front, is the end of it. This is the
  // one tag that says where playback starts, and in the master it covers the audio and subtitle
  // controllers as well.
  assert.ok(
    master.split("\n").includes("#EXT-X-START:TIME-OFFSET=0"),
    "and it says playback starts at the head",
  );
  const variant = master.split("\n").find((line) => line.startsWith("#EXT-X-STREAM-INF"))!;
  assert.ok(variant.includes('SUBTITLES="subs"'), "the variant claims the group");
  assert.ok(variant.includes("RESOLUTION=1920x1080"), "and says what it is");
  assert.ok(variant.includes('CODECS="avc1.640028,mp4a.40.2"'), "including its codecs");
  assert.ok(variant.includes("CLOSED-CAPTIONS=NONE"), "and says there are no closed captions");
  assert.ok(master.includes("RESOLUTION=") && !master.includes("RESOLUTION=x"), "never half-built");
});
