// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * Generating a subtitle track for the cut video, in the background, chunk by chunk.
 *
 * Cutting removes whole stretches, which is why a track recorded against the original timeline
 * drifts. So the audio of each *kept* stretch is recognised -- the same stretches the packager
 * writes, extracted with a fast seek so the deleted parts are never read -- and each cue is moved
 * by the offset that stretch has in the cut video (see `stretches.ts` and `cues.ts`).
 *
 * Three rules, all learned from the Silo Tiny Subtitles plugin, which does this for a living:
 *
 * - **One bad chunk never fails the job.** A chunk that cannot be recognised is logged, retried
 *   once, and skipped: a track missing a minute is worth having, a job that dies at minute thirty
 *   is not.
 * - **The models stay loaded.** Loading is the expensive part and unloading mid-job turns one job
 *   into a failure; see `transcribe.ts`.
 * - **Progress is written as it goes**, one file per chunk, so a restart resumes where it stopped
 *   instead of starting a 45-minute episode again.
 */

import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildCues, shiftCues, toVtt, type Cue } from "./cues.js";
import type { Settings } from "./env.js";
import { run } from "./ffmpeg.js";
import { CORS_HEADERS } from "./http.js";
import { planStretches, type ChunkJob, type StretchJob } from "./stretches.js";
import type { Transcriber } from "./transcribe.js";
import type { SkipWindow } from "./types.js";

/** What a title needs transcribed, in the terms the packager already knows it. */
export interface TrackPlan {
  durationMs: number | null;
  windows: readonly SkipWindow[];
  cardMs: number;
}

export interface TrackStatus {
  /** Chunks finished, and how many there are in total. */
  chunks: number;
  done: number;
  /** Cues written so far. */
  cues: number;
  /** Speech seconds per wall-clock second, from the last chunk. */
  realtimeFactor: number;
  /** Set when the track is complete and can be served. */
  ready: boolean;
  /** Why there will be no track, when there will not be one. */
  error: string | null;
  /** The most recent failure, so /health can name it while the job carries on. */
  lastError?: string;
}

interface Job extends TrackStatus {
  key: string;
  /** The source's URL. Kept in memory only: it is a bearer token. */
  target: string;
  plan: TrackPlan;
  stretches: StretchJob[];
  lastAt: number;
}

export class SubtitleEngine {
  private readonly jobs = new Map<string, Job>();
  private readonly queue: string[] = [];
  private pumping = false;
  /** Which package an episode was last played from, so its subtitles can be offered with it. */
  private readonly byEpisode = new Map<string, string>();

  constructor(
    private readonly settings: Settings,
    private readonly transcriber: Transcriber,
  ) {}

  /** Whether this install asked for subtitles at all. */
  enabled(config: { subtitles?: boolean }): boolean {
    return this.settings.subtitles && config.subtitles === true;
  }

  /** Note which package an episode's playback came from. */
  note(episodeId: string, key: string): void {
    if (episodeId) this.byEpisode.set(episodeId, key);
  }

  /**
   * Start the track for a package, if one is wanted and the configuration allows it.
   *
   * Idempotent: the playback that starts the packaging calls this, and so does every later play.
   */
  ensure(key: string, target: string, plan: TrackPlan, wanted: boolean): TrackStatus | null {
    if (!this.settings.subtitles) return null;
    const existing = this.jobs.get(key);
    if (existing) {
      existing.lastAt = Date.now();
      return existing;
    }
    if (!wanted) return null;
    if (plan.durationMs === null) {
      // Without the source's length the last window is open-ended and every offset after it would
      // be a guess. A guessed offset is exactly the misaligned subtitle this exists to avoid.
      return null;
    }
    const job: Job = {
      key,
      target,
      plan,
      stretches: planStretches(plan.durationMs, plan.windows, plan.cardMs, this.settings.subtitlesChunkSeconds),
      chunks: 0,
      done: 0,
      cues: 0,
      realtimeFactor: 0,
      ready: false,
      error: null,
      lastAt: Date.now(),
    };
    job.chunks = job.stretches.reduce((total, stretch) => total + stretch.chunks.length, 0);
    if (job.chunks === 0) return null;
    this.jobs.set(key, job);
    this.queue.push(key);
    void this.sweep();
    void this.pump();
    return job;
  }

  /** Whether a track is being made (or has been made) for this key. */
  tracking(key: string): boolean {
    return this.jobs.has(key);
  }

  /** Whether a track exists for this key at all (used by /health and the tests). */
  async has(key: string): Promise<boolean> {
    const job = this.jobs.get(key);
    if (!job) return false;
    return this.written(path.join(this.dirFor(job.key), `${this.chunkName(0)}.vtt`));
  }

  /** Note that a playlist was asked for, so /health can show a player reaching it. */
  markPlaylist(key: string): void {
    this.served.playlists += 1;
    this.served.lastKey = key;
  }

  /** Counters for /health: what playbacks asked for, and what was served. */
  readonly served: { wanted: number; masters: number; playlists: number; chunks: number; lastKey?: string } =
    { wanted: 0, masters: 0, playlists: 0, chunks: 0 };

  /** What /health reports. */
  status(): Record<string, unknown> {
    const jobs = [...this.jobs.values()];
    return {
      enabled: this.settings.subtitles,
      language: this.settings.subtitlesLanguage,
      models: this.transcriber.lastError === null,
      modelsError: this.transcriber.lastError,
      tracks: jobs.filter((job) => job.ready).length,
      served: { ...this.served },
      active: this.pumping ? 1 : 0,
      queued: this.queue.length,
      progress: jobs
        .filter((job) => !job.ready)
        .slice(0, 3)
        .map((job) => ({ chunks: job.chunks, done: job.done, cues: job.cues, error: job.error })),
    };
  }

  /** The card's line while a track is being made; null when there is nothing to say. */
  working(): boolean {
    return this.pumping || this.queue.length > 0;
  }

  private dirFor(key: string): string {
    return path.join(this.settings.cacheDir, "subs", key);
  }

  /**
   * Forget tracks nobody has asked for in the TTL.
   *
   * Cheap by design: a track is a WebVTT file per chunk and nothing else -- the audio it was made
   * from is deleted as the chunk is finished -- so a day's worth is a few megabytes. A running job
   * is never swept, and neither is a track a player has asked for recently.
   */
  private async sweep(): Promise<void> {
    const root = path.join(this.settings.cacheDir, "subs");
    const cutoff = Date.now() - this.settings.subtitlesTtlHours * 3_600_000;
    let names: string[] = [];
    try {
      names = await readdir(root);
    } catch {
      return;
    }
    for (const name of names) {
      const key = name;
      const job = this.jobs.get(key);
      if (job) {
        if (!job.ready || job.lastAt > cutoff) continue;
          this.jobs.delete(key);
      }
      const dir = path.join(root, name);
      try {
        const info = await stat(dir);
        if (info.mtimeMs > cutoff) continue;
        await rm(dir, { recursive: true, force: true });
      } catch {
        // Gone already, or not ours to remove.
      }
    }
  }

  private chunkName(index: number): string {
    return `chunk-${String(index).padStart(5, "0")}`;
  }

  /** Run queued tracks, one at a time: recognition is CPU-bound and the packaging needs the CPU too. */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        const key = this.queue.shift();
        if (!key) break;
        const job = this.jobs.get(key);
        if (!job || job.ready) continue;
        await this.run(job);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async run(job: Job): Promise<void> {
    const dir = this.dirFor(job.key);
    try {
      await mkdir(dir, { recursive: true });
    } catch (error) {
      job.error = `the cache is not writable: ${describe(error)}`;
      return;
    }
    if (!(await this.transcriber.available())) {
      job.error = this.transcriber.lastError ?? "the speech models are not installed";
      return;
    }

    const language = this.settings.subtitlesLanguage;
    let index = 0;
    for (const stretch of job.stretches) {
      for (const chunk of stretch.chunks) {
        const name = this.chunkName(index);
        const wav = path.join(dir, `${name}.wav`);
        const vtt = path.join(dir, `${name}.vtt`);
        index += 1;
        if (await this.written(vtt)) {
          // Already done by an earlier run of this job; the file is the record.
          job.done += 1;
          job.lastAt = Date.now();
          continue;
        }
        const cues = await this.chunkCues(chunk, wav, language, job);
        if (cues) {
          try {
            await writeFile(vtt, toVtt(cues));
            job.cues += cues.length;
          } catch (error) {
            job.error = `cannot write the track: ${describe(error)}`;
            return;
          }
        }
        await rm(wav, { force: true });
        job.done += 1;
        job.lastAt = Date.now();
      }
    }

    if (job.done < job.chunks) {
      const missed = job.chunks - job.done;
      job.error = job.error ?? `${missed} of ${job.chunks} chunks could not be recognised`;
    }
    // Ready means every chunk is on disk: the playlist can be closed and a player may keep it.
    // A track with a hole in it is not ready -- the playlist stops at the hole (see `playlist`).
    job.ready = job.chunks > 0 && job.done >= job.chunks;
  }

  /** One chunk's cues, with one retry: a chunk that fails is skipped, not fatal. */
  private async chunkCues(
    chunk: ChunkJob,
    wav: string,
    language: string,
    job: Job,
  ): Promise<Cue[] | null> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const seconds = (chunk.sourceEndMs - chunk.sourceStartMs) / 1000;
        const extracted = await run(
          this.settings.ffmpegPath,
          [
            "-nostdin", "-hide_banner", "-v", "error", "-y",
            // A fast seek before the input reads only from the nearest keyframe onward, so the
            // deleted stretches are skipped rather than downloaded and discarded.
            "-ss", (chunk.sourceStartMs / 1000).toFixed(3),
            "-t", seconds.toFixed(3),
            "-i", job.target,
            "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
            wav,
          ],
          300_000,
        );
        if (extracted.code !== 0) throw new Error(extracted.stderr.trim().slice(-200) || `ffmpeg exited ${extracted.code}`);
        const transcript = await this.transcriber.transcribe(wav, language);
        if (transcript.realtimeFactor > 0) job.realtimeFactor = transcript.realtimeFactor;
        const words = await this.transcriber.refine(wav, transcript.words, language);
        // Times are relative to this chunk, which is what an HLS subtitle segment must hold:
        // the player places the segment itself, from its position in the playlist.
        return buildCues(words);
      } catch (error) {
        if (attempt === 0) continue; // the source may have been mid-rotation, or briefly unavailable
        // Say which side failed: the audio could not be fetched (the source, a range request, a
        // rotated link), or the model could not read what was fetched (its weights, permissions).
        const audio = await stat(wav).then((info) => info.size).catch(() => 0);
        job.error = `chunk at ${(chunk.sourceStartMs / 1000).toFixed(0)}s: ${describe(error)} (${audio} bytes of audio)`;
        job.lastError = job.error;
        console.warn(`  warning        subtitles: ${describe(error)}`);
        return null;
      }
    }
    return null;
  }

  /**
   * The subtitle playlist a player reads, which grows as the chunks are made.
   *
   * This is the mechanism that makes subtitles appear at all: a player loads it with the video
   * and re-reads it as playback goes (that is what `#EXT-X-PLAYLIST-TYPE:EVENT` means), so
   * segments that are written *during* playback get shown -- where a single subtitle *file*
   * fetched once can never arrive late enough to be noticed.
   *
   * Segment positions come from the `#EXTINF` durations, and each chunk's cues are relative to
   * it, so the accumulated durations have to match the video's timeline exactly. They do: a
   * chunk covers the same stretch of source the packager copies, in the same order, and the
   * processing card is the first entry because it is the first thing in the video.
   *
   * The list stops at the first chunk that is not written yet, so a player is never given a
   * position that is one chunk out: a hole in the track is a hole, not a shift.
   */
  async playlist(key: string, cardMs: number): Promise<{ body: string; complete: boolean } | null> {
    const job = this.jobs.get(key);
    if (!job || job.stretches.length === 0) return null;
    const dir = this.dirFor(job.key);
    const entries: Array<{ uri: string; seconds: number }> = [];

    const card = Math.max(0, Math.round(cardMs / 1000));
    if (card > 0) {
      // The card is the start of the video, so the track needs a segment covering it -- empty of
      // cues, which is exactly what a subtitle segment with nothing to say looks like.
      try {
        await mkdir(dir, { recursive: true });
        // A track a player can see something in from the first frame: the card is on screen
        // while the first seconds are cut and recognised, and a rendition with no cue in it at
        // all is one a player may not register (or may drop) before the film has begun.
        await writeFile(
          path.join(dir, "chunk-card.vtt"),
          `WEBVTT\n\n00:00:00.000 --> 00:00:${String(card).padStart(2, "0")}.000\n` +
            "TheIntroDB is preparing the subtitles for this title\n",
        );
        // The URI has to end in an extension ffmpeg's HLS demuxer allows for subtitle
        // segments (it defaults to a list including `vtt`/`webvtt` and *rejects* a URI that
        // has no extension at all -- `av_match_ext` returns 0, and the refusal then takes the
        // whole rendition playlist down with it, which is a film that does not load).
        entries.push({ uri: `subs/card.vtt?f=${encodeURIComponent(key)}`, seconds: card });
      } catch {
        // Without it every cue would be a card's length early. Better no track than a wrong one.
        return null;
      }
    }

    let index = 0;
    let longest = card;
    for (const stretch of job.stretches) {
      for (const chunk of stretch.chunks) {
        const name = this.chunkName(index);
        if (!(await this.written(path.join(dir, `${name}.vtt`)))) break;
        const seconds = (chunk.sourceEndMs - chunk.sourceStartMs) / 1000;
        longest = Math.max(longest, seconds);
        entries.push({ uri: `subs/${index}.vtt?f=${encodeURIComponent(key)}`, seconds });
        index += 1;
      }
    }
    if (entries.length === 0) return null;

    const lines = [
      "#EXTM3U",
      "#EXT-X-VERSION:7",
      `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(longest))}`,
      `#EXT-X-PLAYLIST-TYPE:${job.ready ? "VOD" : "EVENT"}`,
      "#EXT-X-MEDIA-SEQUENCE:0",
    ];
    for (const entry of entries) {
      lines.push(`#EXTINF:${entry.seconds.toFixed(3)},`, entry.uri);
    }
    if (job.ready) lines.push("#EXT-X-ENDLIST");
    return { body: `${lines.join("\n")}\n`, complete: job.ready };
  }

  /** A chunk of the track, as a player fetches it. */
  async chunkFile(key: string, index: string): Promise<string | null> {
    const job = this.jobs.get(key);
    const name = index === "card" ? "chunk-card" : /^\d+$/.test(index) ? this.chunkName(Number(index)) : "";
    if (name === "" || (!job && index !== "card")) return null;
    const file = path.join(this.dirFor(key), `${name}.vtt`);
    return (await this.written(file)) ? file : null;
  }

  /** Whether a file exists and has something in it. */
  private async written(file: string): Promise<boolean> {
    try {
      return (await stat(file)).size > 0;
    } catch {
      return false;
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message || error.name : String(error);
}

/** What a route handler needs to answer for a track. */
export interface TrackRequest {
  settings: Settings;
  subtitles: SubtitleEngine | null;
  request: Request;
}

/**
 * The subtitle playlist.
 *
 * Never cached: it is read again and again while a track is being made, and a cached answer is a
 * player that never sees the chunks that arrived after it first asked.
 */
export async function handleSubtitlePlaylist(context: TrackRequest, cardMs: number): Promise<Response> {
  const url = new URL(context.request.url);
  const key = url.searchParams.get("f") ?? "";
  const playlist = context.subtitles ? await context.subtitles.playlist(key, cardMs) : null;
  // Never a 404, even before the first chunk exists: a player reads the rendition as soon as it
  // loads the master, and a missing playlist at that moment means a track it drops for good.
  // An empty EVENT playlist is legal and says "nothing yet, keep asking".
  const body =
    playlist?.body ??
    "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:10\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-MEDIA-SEQUENCE:0\n";
  if (key) context.subtitles?.markPlaylist(key);
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/vnd.apple.mpegurl",
      "cache-control": "no-cache",
      ...CORS_HEADERS,
    },
  });
}

/**
 * One chunk of the track.
 *
 * Immutable once written, so it is cached for as long as the deployment keeps tracks -- the same
 * day as the playlist's TTL, and the same day the `no-cache` playlist may point at it again.
 */
export async function handleSubtitleChunk(
  context: TrackRequest,
  key: string,
  index: string,
): Promise<Response> {
  if (context.subtitles) context.subtitles.served.chunks += 1;
  const file = context.subtitles ? await context.subtitles.chunkFile(key, index) : null;
  if (!file) return new Response("", { status: 404 });
  let body: string;
  try {
    body = await readFile(file, "utf8");
  } catch {
    return new Response("", { status: 404 });
  }
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/vtt; charset=utf-8",
      "cache-control": `public, max-age=${context.settings.subtitlesTtlHours * 3600}`,
      ...CORS_HEADERS,
    },
  });
}
