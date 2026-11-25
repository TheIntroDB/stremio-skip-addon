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

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildCues, shiftCues, toVtt, type Cue } from "./cues.js";
import type { Settings } from "./env.js";
import { run } from "./ffmpeg.js";
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

  /** The track an episode should be offered, if one is ready. */
  async trackForEpisode(episodeId: string): Promise<{ key: string; path: string; cues: number } | null> {
    const key = this.byEpisode.get(episodeId);
    if (!key) return null;
    const path0 = await this.track(key);
    if (!path0) return null;
    return { key, path: path0, cues: this.jobs.get(key)?.cues ?? 0 };
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
    void this.pump();
    return job;
  }

  /** The finished track's path, or null while there is not one. */
  async track(key: string): Promise<string | null> {
    const job = this.jobs.get(key);
    if (job && !job.ready) return null;
    const file = path.join(this.dirFor(key), "track.vtt");
    try {
      return (await stat(file)).size > 0 ? file : null;
    } catch {
      return null;
    }
  }

  /** What /health reports. */
  status(): Record<string, unknown> {
    const jobs = [...this.jobs.values()];
    return {
      enabled: this.settings.subtitles,
      language: this.settings.subtitlesLanguage,
      models: this.transcriber.lastError === null,
      modelsError: this.transcriber.lastError,
      tracks: jobs.filter((job) => job.ready).length,
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
        if (await this.hasTrackChunk(vtt)) {
          // Already done by an earlier run of this job; the file is the record.
          job.done += 1;
          job.lastAt = Date.now();
          continue;
        }
        const cues = await this.chunkCues(job, chunk, wav, language);
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
    await this.assemble(job);
  }

  /** One chunk's cues, with one retry: a chunk that fails is skipped, not fatal. */
  private async chunkCues(
    job: Job,
    chunk: ChunkJob,
    wav: string,
    language: string,
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
        return shiftCues(buildCues(words), {
          editedStartSeconds: chunk.editedStartMs / 1000,
          durationSeconds: seconds,
        });
      } catch (error) {
        if (attempt === 0) continue; // the source may have been mid-rotation, or briefly unavailable
        job.error = `a chunk could not be recognised: ${describe(error)}`;
        console.warn(`  warning        subtitles: ${describe(error)}`);
        return null;
      }
    }
    return null;
  }

  /** Join the chunks into the one file a player is given. */
  private async assemble(job: Job): Promise<void> {
    const dir = this.dirFor(job.key);
    const lines: string[] = [
      "WEBVTT",
      "",
      "NOTE TheIntroDB: generated for the cut video, so the times match what is playing",
      "",
    ];
    for (let index = 0; index < job.chunks; index += 1) {
      try {
        const body = await readFile(path.join(dir, `${this.chunkName(index)}.vtt`), "utf8");
        // Drop each chunk's own header and keep its cues.
        const cues = body.replace(/^WEBVTT[^\n]*\n+/, "").trim();
        if (cues) lines.push(cues, "");
      } catch {
        // A missing chunk is a gap in the track, which is what was decided above: better than none.
      }
    }
    const out = `${lines.join("\n")}\n`;
    try {
      await writeFile(path.join(dir, "track.vtt"), out);
      job.ready = out.length > "WEBVTT".length + 40;
    } catch (error) {
      job.error = `cannot write the track: ${describe(error)}`;
    }
  }

  private async hasTrackChunk(file: string): Promise<boolean> {
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
