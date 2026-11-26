// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * How long recognition takes, and what it hears.
 *
 * The one number a deployment cares about is the realtime factor: speech seconds per wall-clock
 * second. Below 1 and a track is ready while the episode is still playing; well above it and the
 * track is a background job you pick up on the next play. Nothing can be inferred from a machine's
 * spec sheet, so this measures it.
 *
 * The two engines are installed by hand here rather than declared in package.json -- the same way
 * the Dockerfile installs them -- because CI should not carry ~490 MB it never loads:
 *
 *   ONNXRUNTIME_NODE_INSTALL=skip npm install --no-save \
 *     @desert-ant-labs/voz@4.2.3 @desert-ant-labs/align@4.2.3 onnxruntime-node@1.31.1
 *   node --import tsx scripts/measure-transcribe.ts some-speech.wav [language]
 *   npm ci   # afterwards: --no-save leaves them, and they are 505 MB
 *
 * Do **not** add `--omit=dev` here: it prunes this repo's own dev dependencies (typescript and
 * tsx among them) out of node_modules, and then nothing in the project can be run. The Dockerfile
 * uses it because an image has no dev dependencies to lose.
 *
 * The first run also downloads the weights (in this deployment: 368 MiB for Voz) into
 * `DAL_CACHE_ROOT`, so the second run is the one that measures the model rather than the network.
 */

import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Settings } from "../src/addon/env.js";
import { run } from "../src/streams/ffmpeg.js";
import { buildCues, toVtt } from "../src/subtitles/cues.js";
import { Transcriber } from "../src/subtitles/transcribe.js";

const file = process.argv[2];
if (!file) {
  console.error("usage: tsx scripts/measure-transcribe.ts <audio> [language]");
  process.exit(2);
}
const language = process.argv[3] ?? "en";
const cacheDir = await mkdtemp(path.join(tmpdir(), "tidb-measure-"));
// The models' weights go wherever DAL_CACHE_ROOT points; a throwaway directory keeps a
// measurement from filling a real cache.
process.env.DAL_CACHE_ROOT ??= path.join(cacheDir, "models");
const settings = { cacheDir, ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" } as unknown as Settings;
const transcriber = new Transcriber(settings);

const loadedAt = Date.now();
if (!(await transcriber.warm())) {
  console.error(`the models are not usable: ${transcriber.lastError}`);
  process.exit(1);
}
console.log(`models loaded in ${((Date.now() - loadedAt) / 1000).toFixed(1)}s`);

// Exactly what the addon does to a chunk: 16 kHz mono PCM, from the source.
const wav = path.join(cacheDir, "chunk.wav");
const extracted = await run(
  settings.ffmpegPath,
  [
    "-nostdin",
    "-hide_banner",
    "-v",
    "error",
    "-y",
    "-i",
    file,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    wav,
  ],
  300_000,
);
if (extracted.code !== 0) {
  console.error(`could not extract the audio: ${extracted.stderr.trim().slice(-300)}`);
  process.exit(1);
}
const bytes = (await stat(wav)).size;
const audioSeconds = bytes / (16_000 * 2);

const transcribedAt = Date.now();
const transcript = await transcriber.transcribe(wav, language);
const transcribeSeconds = (Date.now() - transcribedAt) / 1000;

const refinedAt = Date.now();
const words = await transcriber.refine(wav, transcript.words, language);
const refineSeconds = (Date.now() - refinedAt) / 1000;

const cues = buildCues(words);
const total = transcribeSeconds + refineSeconds;
console.log(
  JSON.stringify(
    {
      audioSeconds: Number(audioSeconds.toFixed(1)),
      transcribeSeconds: Number(transcribeSeconds.toFixed(1)),
      refineSeconds: Number(refineSeconds.toFixed(1)),
      realtimeFactor: Number((audioSeconds / total).toFixed(2)),
      // What the addon would report for a 45-minute episode at this rate.
      minutesForA45MinuteEpisode: Number(((45 * 60) / (audioSeconds / total) / 60).toFixed(1)),
      engineRealtimeFactor: Number(transcript.realtimeFactor.toFixed(2)),
      words: words.length,
      cues: cues.length,
      firstCues: cues
        .slice(0, 3)
        .map((cue) => `${cue.start.toFixed(1)}-${cue.end.toFixed(1)} ${cue.text}`),
    },
    null,
    2,
  ),
);
if (cues.length > 0) console.log(toVtt(cues.slice(0, 5)));
