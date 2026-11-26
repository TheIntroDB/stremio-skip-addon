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

import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Settings } from "../addon/env.js";
import { CORS_HEADERS } from "../addon/http.js";
import type { SkipWindow } from "../addon/types.js";
import { run } from "../streams/ffmpeg.js";
import { buildCues, type Cue, toVtt } from "./cues.js";
import { type ChunkJob, planStretches, type StretchJob } from "./stretches.js";
import type { SpeechModels } from "./transcribe.js";

/** What a title needs transcribed, in the terms the packager already knows it. */
export interface TrackPlan {
  durationMs: number | null;
  windows: readonly SkipWindow[];
  cardMs: number;
}

/**
 * A track's identity: the package it is cut from, and what it was made from.
 *
 * `.a<n>` is an audio stream that was recognised; `.s<n>` is a subtitle track the source already
 * carried, which is preferred when there is one -- it is timed to that release and costs nothing.
 */
export function trackKey(
  packageKey: string,
  audio?: { index: number } | null,
  text?: { index: number } | null,
): string {
  if (text) return `${packageKey}.s${text.index}`;
  return audio ? `${packageKey}.a${audio.index}` : packageKey;
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
  /**
   * Set when the job stopped because nobody was watching it.
   *
   * Distinct from `error`: nothing failed, the player went away. The chunks written so far stay
   * on disk and the playlist still ends at the last of them, so the next playback resumes from
   * there instead of paying for the recognition again.
   */
  idle?: boolean;
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
  /** When this job was last asked for, by either end of the track. */
  lastSeen: number;
  /** The container stream index to recognise, and what language it is, for /health. */
  audio?: { index: number; language: string };
  /** The source's own subtitle track, when the track is a copy of one rather than a recognition. */
  text?: { index: number; language: string };
}

export class SubtitleEngine {
  private readonly jobs = new Map<string, Job>();
  private readonly queue: string[] = [];
  private pumping = false;
  /** Which package an episode was last played from, so its subtitles can be offered with it. */
  private readonly byEpisode = new Map<string, string>();
  /**
   * The track key a package's job was actually started under.
   *
   * The key carries the audio stream (`<package>.a2`), because a track made from a dub is not the
   * track for an install that asked for English. That makes it a derived value, and a derived value
   * computed in two places is one that will disagree: when the play path re-derived it and got a
   * different answer, `tracking()` said no, no master was served, and the player had no subtitle
   * track -- with a job running and its chunks being written. So the engine records the key it used
   * and the play path asks for it.
   */
  private readonly byPackage = new Map<string, string>();
  /** Kills the ffmpeg this engine has running when a drain asks it to (see `drain`). */
  private controller = new AbortController();
  /**
   * Bumped by a drain. A job captures it, so work for a job that no longer exists stops even if
   * the model is halfway through a chunk -- clearing jobs from the map alone would leave the loop
   * writing chunks for a track nobody can ask for any more.
   */
  private epoch = 0;

  constructor(
    private readonly settings: Settings,
    private readonly transcriber: SpeechModels,
    /**
     * When the film was last asked for at all -- a playlist read or a segment fetch.
     *
     * Recognition is minutes of CPU for one episode, and nobody is served by spending it on a
     * playback that has stopped: a viewer who closes the player leaves the job running to the
     * end of the file. A job that is neither asked for here nor by its own playlist for
     * `subtitlesIdleSeconds` stops, keeping the chunks it already wrote. Defaults to "always
     * watched" so a host that wires nothing keeps the old behaviour.
     */
    private readonly watching: () => number = () => Date.now(),
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
  ensure(
    packageKey: string,
    target: string,
    plan: TrackPlan,
    wanted: boolean,
    audio?: { index: number; language: string },
    text?: { index: number; language: string } | null,
  ): TrackStatus | null {
    if (!this.settings.subtitles) return null;
    // Recognition is minutes of CPU per episode and is off unless a deployment asks for it (see
    // `Settings.subtitlesGenerate`). A copy of the source's own track costs almost nothing and is
    // what ships -- so a file with text subtitles still gets a rendition that lines up with the
    // cuts, and a file without one simply has no track.
    if (!text && !this.settings.subtitlesGenerate) return null;
    const key = trackKey(packageKey, audio, text);
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
      stretches: planStretches(
        plan.durationMs,
        plan.windows,
        plan.cardMs,
        this.settings.subtitlesChunkSeconds,
      ),
      chunks: 0,
      done: 0,
      cues: 0,
      realtimeFactor: 0,
      ready: false,
      error: null,
      lastAt: Date.now(),
      lastSeen: Date.now(),
      ...(text ? { text } : audio ? { audio } : {}),
    };
    job.chunks = job.stretches.reduce((total, stretch) => total + stretch.chunks.length, 0);
    if (job.chunks === 0) return null;
    this.jobs.set(key, job);
    this.byPackage.set(packageKey, key);
    this.queue.push(key);
    void this.sweep();
    void this.pump();
    return job;
  }

  /** The language a track is in, so the master can declare it. */
  languageOf(track: string): string | null {
    const job = this.jobs.get(track);
    if (!job) return null;
    if (job.text) return job.text.language || null;
    return this.settings.subtitlesLanguage || null;
  }

  /** Whether a track is being made (or has been made) under this track key. */
  tracking(key: string): boolean {
    return this.jobs.has(key);
  }

  /**
   * The track key a package's job is running under, or null when it has none.
   *
   * This is what the play path must use: the key is derived (package + audio stream) and only the
   * engine knows which one it used, so asking is the only way the master's rendition cannot point
   * at a job that does not exist.
   */
  trackFor(packageKey: string): string | null {
    const known = this.byPackage.get(packageKey);
    if (known && this.jobs.has(known)) return known;
    return this.jobs.has(packageKey) ? packageKey : null;
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
    this.touch(key);
  }

  /** Note that a chunk was asked for: a player is still reading this track. */
  markChunk(key: string): void {
    this.served.chunks += 1;
    this.touch(key);
  }

  /** A request for this track is what keeps its job alive (see `subtitlesIdleSeconds`). */
  private touch(key: string): void {
    const job = this.jobs.get(key);
    if (job) job.lastSeen = Date.now();
  }

  /**
   * Stop everything and forget everything, for `/drain`.
   *
   * The model runs in this process, so a chunk that is already being recognised cannot be
   * interrupted -- but the loop stops before the *next* one, the extraction ffmpeg is killed, and
   * the cache the caller is about to clear is no longer being written to.
   */
  drain(): number {
    const stopped = this.jobs.size + this.queue.length;
    this.controller.abort();
    // Inference cannot be asked to stop -- it is seconds of native work with no cancellation -- so
    // a drain ends it. Without this the button only ever timed out.
    this.transcriber.cancel?.();
    this.controller = new AbortController();
    this.epoch += 1;
    this.jobs.clear();
    this.byPackage.clear();
    this.queue.length = 0;
    this.byEpisode.clear();
    this.served.wanted = 0;
    this.served.masters = 0;
    this.served.playlists = 0;
    this.served.chunks = 0;
    delete this.served.lastKey;
    return stopped;
  }

  /**
   * Forget one package: its jobs, their chunks, and whatever they were writing.
   *
   * This deployment serves one viewer, so a film nobody has asked for in five minutes is dead weight
   * — the cut segments, the card, the subtitle chunks and the ffmpeg that is making them. Dropping the
   * job from the map stops the loop before its next chunk; the chunk directory goes with it.
   */
  async forget(packageKey: string): Promise<number> {
    let dropped = 0;
    for (const [key, job] of [...this.jobs]) {
      if (job.key !== packageKey && !job.key.startsWith(`${packageKey}.`)) continue;
      // `idle` is how a track is told to stop: the loop stops before its next chunk and the
      // extraction ffmpeg is killed, so nothing is still writing into a directory that is going.
      job.idle = true;
      this.jobs.delete(key);
      this.byPackage.delete(packageKey);
      for (const [episode, owner] of [...this.byEpisode]) {
        if (owner === packageKey) this.byEpisode.delete(episode);
      }
      await rm(this.dirFor(job.key), { recursive: true, force: true }).catch(() => undefined);
      dropped += 1;
    }
    return dropped;
  }

  /** Counters for /health: what playbacks asked for, and what was served. */
  readonly served: {
    wanted: number;
    masters: number;
    playlists: number;
    chunks: number;
    lastKey?: string;
    /** The last track key a playback resolved to, and the audio stream behind it. */
    lastTrack?: string;
    lastAudio?: number | null;
  } = { wanted: 0, masters: 0, playlists: 0, chunks: 0 };

  /**
   * Record what a playback resolved the track to.
   *
   * The one field that explains "the player has no subtitle track": if this key is not the key the
   * job was started under, the master was not served at all -- because `tracking` said no.
   */
  noteResolved(track: string, audio: number | null): void {
    this.served.lastTrack = track;
    this.served.lastAudio = audio;
  }

  /** What /health reports. */
  status(): Record<string, unknown> {
    const jobs = [...this.jobs.values()];
    return {
      enabled: this.settings.subtitles,
      // Whether this deployment recognises speech. Off means tracks come from the source only.
      generate: this.settings.subtitlesGenerate,
      language: this.settings.subtitlesLanguage,
      models: this.transcriber.lastError === null,
      modelsError: this.transcriber.lastError,
      tracks: jobs.filter((job) => job.ready).length,
      served: { ...this.served },
      idleSeconds: this.settings.subtitlesIdleSeconds,
      active: this.pumping ? 1 : 0,
      queued: this.queue.length,
      stopped: jobs.filter((job) => job.idle === true).length,
      progress: jobs
        .filter((job) => !job.ready)
        .slice(0, 3)
        .map((job) => ({
          chunks: job.chunks,
          done: job.done,
          cues: job.cues,
          error: job.error,
          idle: job.idle === true,
          // Which audio track this track is being made from: the one thing that explains an
          // empty result when everything else looks right.
          audio: job.audio?.language || null,
          // Which of the source's own subtitle tracks this job is copying, when it is one of those
          // rather than a recognition: /health should say where a track came from.
          text: job.text?.index ?? null,
        })),
    };
  }

  /** Whether this job's viewers have all gone, judged by the film or the track being asked for. */
  private idle(job: Job): boolean {
    const after = this.settings.subtitlesIdleSeconds * 1000;
    if (!Number.isFinite(after) || after <= 0) return false;
    return Date.now() - Math.max(job.lastSeen, this.watching()) > after;
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
   *
   * Public because a TTL only means anything if something remembers to sweep: the server calls
   * this at boot and once an hour.
   */
  async sweep(): Promise<void> {
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
    const epoch = this.epoch;
    const dir = this.dirFor(job.key);
    try {
      await mkdir(dir, { recursive: true });
    } catch (error) {
      job.error = `the cache is not writable: ${describe(error)}`;
      return;
    }
    // A track copied from the source needs no models: one demux pass and some arithmetic, so it
    // neither waits for them nor fails when they are not installed.
    if (job.text) {
      await this.writeSourceChunks(job, dir);
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
        // Draining is not idleness: the whole track is being thrown away.
        if (epoch !== this.epoch) return;
        // Before spending a chunk's worth of CPU: is anyone still watching this? A closed tab and
        // a paused player look the same from here, and both want the same thing -- stop spending
        // the host's cores. What is written stays, and the playlist still ends at the last chunk.
        if (this.idle(job)) {
          job.idle = true;
          console.log(
            `  stopped        subtitles: nobody is watching, ${job.done} of ${job.chunks} chunks kept`,
          );
          return;
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

  /**
   * Write the track from the source's own subtitles.
   *
   * The source is demuxed once (cached beside the chunks, so a later playback costs nothing), and
   * each chunk gets the cues that fall inside it, clipped to the chunk and shifted to its start.
   * That is the same shape the generated track has, so the playlist, the cue files and the player
   * cannot tell the two apart.
   */
  private async writeSourceChunks(job: Job, dir: string): Promise<void> {
    const text = job.text;
    if (!text) return;
    const file = path.join(dir, `source-${text.index}.vtt`);
    if (!(await this.written(file))) {
      const result = await run(
        this.settings.ffmpegPath,
        [
          "-nostdin",
          "-hide_banner",
          "-v",
          "error",
          "-y",
          "-i",
          job.target,
          // The stream index rather than "the first subtitle": a release whose first track is a
          // forced one would otherwise give a track with almost nothing in it.
          "-map",
          `0:${text.index}`,
          "-f",
          "webvtt",
          file,
        ],
        900_000,
        this.controller.signal,
      );
      if (result.code !== 0 || !(await this.written(file))) {
        job.error = `the source's subtitles could not be read: ${result.stderr.trim().slice(-200)}`;
        return;
      }
    }
    let cues: Cue[];
    try {
      cues = parseVtt(await readFile(file, "utf8"));
    } catch (error) {
      job.error = `the source's subtitles could not be read: ${describe(error)}`;
      return;
    }
    if (cues.length === 0) {
      job.error = "the source's subtitle track is empty";
      return;
    }
    const epoch = this.epoch;
    let index = 0;
    for (const stretch of job.stretches) {
      for (const chunk of stretch.chunks) {
        const name = this.chunkName(index);
        const vtt = path.join(dir, `${name}.vtt`);
        index += 1;
        if (epoch !== this.epoch) return;
        if (await this.written(vtt)) {
          job.done += 1;
          continue;
        }
        const from = chunk.sourceStartMs / 1000;
        const to = chunk.sourceEndMs / 1000;
        const inside: Cue[] = [];
        for (const cue of cues) {
          const start = Math.max(cue.start, from);
          const end = Math.min(cue.end, to);
          if (end - start <= 0.001) continue;
          inside.push({ text: cue.text, start: start - from, end: end - from });
        }
        try {
          await writeFile(vtt, toVtt(inside));
        } catch (error) {
          job.error = `cannot write the track: ${describe(error)}`;
          return;
        }
        job.cues += inside.length;
        job.done += 1;
        job.lastAt = Date.now();
      }
    }
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
        // `-map` before the input selection: without it ffmpeg takes its own preferred audio
        // stream, which on a release with a dub is the loudest one and not the one the model can
        // read. The chosen stream is the same for every chunk of a job, so the track is coherent.
        const mapping = job.audio ? ["-map", `0:${job.audio.index}`] : [];
        const extracted = await run(
          this.settings.ffmpegPath,
          [
            "-nostdin",
            "-hide_banner",
            "-v",
            "error",
            "-y",
            // A fast seek before the input reads only from the nearest keyframe onward, so the
            // deleted stretches are skipped rather than downloaded and discarded.
            "-ss",
            (chunk.sourceStartMs / 1000).toFixed(3),
            "-t",
            seconds.toFixed(3),
            "-i",
            job.target,
            ...mapping,
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
          this.controller.signal,
        );
        if (extracted.code !== 0)
          throw new Error(extracted.stderr.trim().slice(-200) || `ffmpeg exited ${extracted.code}`);
        const transcript = await this.transcriber.transcribe(wav, language);
        if (transcript.realtimeFactor > 0) job.realtimeFactor = transcript.realtimeFactor;
        const words = this.transcriber.refine
          ? await this.transcriber.refine(wav, transcript.words, language)
          : transcript.words;
        // Times are relative to this chunk, which is what an HLS subtitle segment must hold:
        // the player places the segment itself, from its position in the playlist.
        return buildCues(words);
      } catch (error) {
        if (attempt === 0) continue; // the source may have been mid-rotation, or briefly unavailable
        // Say which side failed: the audio could not be fetched (the source, a range request, a
        // rotated link), or the model could not read what was fetched (its weights, permissions).
        const audio = await stat(wav)
          .then((info) => info.size)
          .catch(() => 0);
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
      // The film's playlist is an EVENT one while it is being made, and a player joins an EVENT
      // playlist at its live edge; the rendition has to say the same thing or the cues would be
      // read from a different place than the picture.
      "#EXT-X-START:TIME-OFFSET=0",
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
    const name =
      index === "card" ? "chunk-card" : /^\d+$/.test(index) ? this.chunkName(Number(index)) : "";
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
export async function handleSubtitlePlaylist(
  context: TrackRequest,
  cardMs: number,
): Promise<Response> {
  const url = new URL(context.request.url);
  const key = url.searchParams.get("f") ?? "";
  const playlist = context.subtitles ? await context.subtitles.playlist(key, cardMs) : null;
  // Never a 404, and never *empty* either. A player reads this rendition once as it loads and
  // fixes its stream list from what it finds: an EVENT playlist with no segments makes ffmpeg
  // create no subtitle stream at all, and then no amount of chunks arriving later puts one in the
  // menu. Measured against ffmpeg 8: an empty rendition yields video and audio only; the same
  // playlist with one 0.000s segment yields `Subtitle: webvtt` and plays normally.
  //
  // So an answer with nothing to say is a single zero-length placeholder: it costs the timeline
  // nothing (a 0-second segment moves no position), and it makes the track exist. The real one
  // replaces it on the next poll, which is what EVENT means.
  const body =
    playlist?.body ??
    [
      "#EXTM3U",
      "#EXT-X-VERSION:7",
      "#EXT-X-TARGETDURATION:10",
      "#EXT-X-PLAYLIST-TYPE:EVENT",
      "#EXT-X-MEDIA-SEQUENCE:0",
      "#EXTINF:0.000,",
      `subs/placeholder.vtt?f=${encodeURIComponent(key)}`,
      "",
    ].join("\n");
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
  if (context.subtitles) context.subtitles.markChunk(key);
  // The placeholder a rendition is born with (see `handleSubtitlePlaylist`): a valid WebVTT with
  // no cues, so the first poll can carry a segment without inventing a cue.
  if (index === "placeholder") {
    return new Response("WEBVTT\n\n", {
      status: 200,
      headers: {
        "content-type": "text/vtt; charset=utf-8",
        "cache-control": "no-cache",
        ...CORS_HEADERS,
      },
    });
  }
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

/**
 * Read a WebVTT file into cues.
 *
 * Only what ffmpeg writes is supported -- a header, optional identifiers, `start --> end` and one
 * or more lines of text -- because that is all this is ever given. Markup inside the text is
 * stripped: a player shows plain text, and a `<font>` tag is not text.
 */
export function parseVtt(text: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of text.replace(/\r/g, "").split("\n\n")) {
    const lines = block.split("\n").filter((line) => line.trim() !== "");
    if (lines.length === 0) continue;
    const arrow = lines.findIndex((line) => line.includes("-->"));
    if (arrow === -1) continue;
    const [left, right] = lines[arrow]!.split("-->");
    const start = clock((left ?? "").trim());
    const end = clock((right ?? "").trim().split(/\s+/)[0] ?? "");
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const body = lines
      .slice(arrow + 1)
      .join("\n")
      .replace(/<[^>]+>/g, "")
      .trim();
    if (body === "") continue;
    cues.push({ text: body, start, end });
  }
  return cues;
}

/** `00:01:02.345`, `01:02.345` or `2.345` to seconds. */
function clock(stamp: string): number {
  const parts = stamp.replace(",", ".").split(":").map(Number);
  if (parts.length === 0 || parts.some((part) => !Number.isFinite(part))) return Number.NaN;
  if (parts.length === 3) return (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0);
  if (parts.length === 2) return (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
  return parts[0] ?? Number.NaN;
}
