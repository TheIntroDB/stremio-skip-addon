// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * Configuration, read once from the environment at boot.
 *
 * This is a self-hosted service, so there is no bindings object: everything comes
 * from process.env (Docker `-e`, a `.env` file, or a `.env` passed with
 * `node --env-file=.env`).
 */

import { INTRODB_API_VERSION } from "./constants.js";
import { type Env, MAX_MARGIN_SECONDS } from "./types.js";

/**
 * How much of each window's edge is left alone by default, in seconds.
 *
 * A cut can only land on a keyframe, and TheIntroDB's timings describe *a* release of the
 * title rather than necessarily the one being watched — so the first and last seconds of
 * an intro are exactly where dialogue goes missing. Skipping slightly less than the
 * reported window is the safe direction, and this is the amount.
 */
const DEFAULT_MARGIN_SECONDS = 2;

/**
 * How much audio goes to the recogniser in one go, and therefore how long each subtitle segment is.
 *
 * 30 seconds is one window of the recogniser, so it is the default *and* the floor: a chunk is a
 * subtitle segment, so a shorter one does make the first cues arrive sooner, but it cannot be
 * recognised any faster than the window it is given to. The ceiling is a typo guard, not a
 * recommendation -- the segment length is what a player waits for before it shows anything.
 */
export const DEFAULT_SUBTITLES_CHUNK_SECONDS = 30;
/** The floor *is* the default, so the clamp can never lift the default off its documented value. */
const MIN_SUBTITLES_CHUNK_SECONDS = DEFAULT_SUBTITLES_CHUNK_SECONDS;
const MAX_SUBTITLES_CHUNK_SECONDS = 900;

export type { CutMode } from "./types.js";

export interface Settings extends Env {
  port: number;
  /** Where cut files live. */
  cacheDir: string;
  /** How much disk the cut cache may use before the oldest cut is evicted. */
  cacheMaxBytes: number;
  /** The deployment's default margin on each cut; an install URL may override it. */
  skipMarginSeconds: number;
  /**
   * Whether a cold playback is shown the processing card (see `splash.ts`) instead of
   * being held until the first segment of the episode is written.
   */
  splash: boolean;
  /**
   * Whether this deployment recognises speech to make subtitles for the cut video.
   *
   * Off by default, and off in the shipped service: recognition is minutes of CPU per episode,
   * which on a small host is a battery of other problems (a playback that waits, pages that
   * stall, a host that thrashes). The source's own text subtitles are still used -- those are a
   * demux pass and a little arithmetic (see `subtitles.ts`) -- so a release that has them still
   * gets a track that lines up with the cuts. `SUBTITLES_GENERATE=on` turns recognition back on
   * for a host that can afford it.
   */
  subtitlesGenerate: boolean;
  /**
   * Whether the player fetches everything from here.
   *
   * On by default: a debrid link is minted for the address that asked for it, so the stream
   * list, the playlists, the segments and the files all have to come from the same address.
   * Off is for a source the player can reach directly (a public HLS stream).
   */
  proxy: boolean;
  /**
   * Whether this deployment offers subtitle tracks at all.
   *
   * A track is cut to the picture, so what this gates is the rendition: with it off the player is
   * never offered one. The source's own text subtitles are what is served from it now -- see
   * `subtitlesGenerate` for the recognition that this switch used to imply.
   */
  subtitles: boolean;
  /** The language to recognise and refine. Alignment falls back to the recogniser's own timings. */
  subtitlesLanguage: string;
  /**
   * How much audio is transcribed in one go, and therefore how long each subtitle segment is.
   *
   * Small on purpose: a player can only show the subtitles in segments it has, so this is how
   * soon after playback the first ones appear and how finely progress advances. 30s is also one
   * window of the recogniser, so there is nothing to be gained by going larger.
   */
  subtitlesChunkSeconds: number;
  /**
   * How long a generated track is kept, in hours.
   *
   * A track is small -- a WebVTT file of a 45-minute episode is under 100 KB, and that is all that
   * is kept once the audio it was made from is deleted -- so there is no reason to make a player
   * pay for the recognition twice in a day. Regenerating is minutes of CPU; keeping it is nothing.
   */
  subtitlesTtlHours: number;
  /**
   * How long a track keeps being made after nobody has asked for the film.
   *
   * Recognition is minutes of CPU per episode, and a viewer who closes the player leaves a job
   * running to the end of a file nobody is watching. When neither the film nor the track has been
   * fetched for this long the job stops, keeping the chunks it has; a later playback resumes.
   * 0 disables the stop, which is only useful when measuring how long a track takes.
   */
  subtitlesIdleSeconds: number;
  /**
   * Which audio track of a source to recognise, by language code.
   *
   * The recogniser is trained on English, so a dub fed to it as English is noise -- a file with a
   * second audio track produced an empty track. An install may ask for another language; when it
   * is not in the file, English is used, and when there is no English either the file's own
   * default track is. This is the deployment's default for installs that ask for nothing.
   */
  subtitlesAudioLanguage: string;
  /**
   * A secret `/drain` requires, when set.
   *
   * `/drain` is a write on a service that is otherwise read-only, and this deployment may be
   * reachable from anywhere. Empty means the header alone gates it -- enough for a private host,
   * not enough for a public one, so a public deployment should set this.
   */
  drainSecret: string;
  /**
   * How much of the episode must be ready before playback starts on it.
   *
   * Starting on a few seconds is what made Stremio decide an episode had ended, mark it
   * watched and jump to the next one; the card is played until this much real video exists.
   */
  prerollSeconds: number;
  cutWaitSeconds: number;
  cutConcurrency: number;
  /**
   * How many of a title's sources get a cut prepared in the background when its
   * stream list is fetched. Stremio's default pick is the first entry, so cutting
   * one or two is what makes the first playback land on a ready cut — and 0 turns
   * that off entirely for a deployment that does not want to spend the bandwidth.
   */
  precutSources: number;
  ffmpegPath: string;
  ffprobePath: string;
}

function numberFrom(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export function loadSettings(): Settings {
  return {
    TIDB_API_KEY: process.env.TIDB_API_KEY ?? "",
    ALLOW_PRIVATE_HOSTS: process.env.ALLOW_PRIVATE_HOSTS ?? "",
    port: numberFrom("PORT", 8787),
    cacheDir: process.env.CACHE_DIR ?? "./cache",
    cacheMaxBytes: Math.max(0, numberFrom("CACHE_MAX_GB", 50) * 1024 ** 3),
    subtitles: !/^(off|false|0|no)$/i.test((process.env.SUBTITLES ?? "").trim()),
    subtitlesLanguage: (process.env.SUBTITLES_LANGUAGE ?? "en").trim(),
    subtitlesChunkSeconds: Math.min(
      MAX_SUBTITLES_CHUNK_SECONDS,
      Math.max(
        MIN_SUBTITLES_CHUNK_SECONDS,
        Math.round(numberFrom("SUBTITLES_CHUNK_SECONDS", DEFAULT_SUBTITLES_CHUNK_SECONDS)),
      ),
    ),
    subtitlesTtlHours: Math.min(
      720,
      Math.max(1, Math.round(numberFrom("SUBTITLES_TTL_HOURS", 24))),
    ),
    subtitlesIdleSeconds: Math.min(
      3600,
      Math.max(0, Math.round(numberFrom("SUBTITLES_IDLE_SECONDS", 120))),
    ),
    subtitlesAudioLanguage: (process.env.SUBTITLES_AUDIO_LANGUAGE ?? "en").trim().toLowerCase(),
    drainSecret: (process.env.DRAIN_SECRET ?? "").trim(),
    // Off only when it is explicitly turned off: the sources people actually use are debrid.
    proxy: !/^(off|false|0|no)$/i.test((process.env.PROXY ?? "").trim()),
    prerollSeconds: Math.min(60, Math.max(0, Math.round(numberFrom("PREROLL_SECONDS", 10)))),
    splash: !/^(off|false|0|no)$/i.test((process.env.SPLASH ?? "").trim()),
    // Opt-in, unlike `splash`: this is the expensive one.
    subtitlesGenerate: /^(on|true|1|yes)$/i.test((process.env.SUBTITLES_GENERATE ?? "").trim()),
    skipMarginSeconds: Math.min(
      MAX_MARGIN_SECONDS,
      Math.max(0, Math.round(numberFrom("SKIP_MARGIN_SECONDS", DEFAULT_MARGIN_SECONDS))),
    ),
    cutWaitSeconds: Math.max(0, numberFrom("CUT_WAIT_SECONDS", 120)),
    cutConcurrency: Math.max(1, Math.floor(numberFrom("CUT_CONCURRENCY", 2))),
    precutSources: Math.min(5, Math.max(0, Math.floor(numberFrom("PRECUT_SOURCES", 2)))),
    ffmpegPath: process.env.FFMPEG_PATH ?? "ffmpeg",
    ffprobePath: process.env.FFPROBE_PATH ?? "ffprobe",
  };
}

/** The subset of settings that is safe to print. */
export function describeSettings(settings: Settings): Record<string, unknown> {
  return {
    api: `https://api.theintrodb.org/${INTRODB_API_VERSION}/media`,
    apiKeyConfigured: Boolean((settings.TIDB_API_KEY ?? "").trim()),
    skipMarginSeconds: settings.skipMarginSeconds,
    proxy: settings.proxy,
    subtitles: settings.subtitles,
    subtitlesLanguage: settings.subtitlesLanguage,
    subtitlesTtlHours: settings.subtitlesTtlHours,
    subtitlesIdleSeconds: settings.subtitlesIdleSeconds,
    subtitlesAudioLanguage: settings.subtitlesAudioLanguage,
    splash: settings.splash,
    prerollSeconds: settings.prerollSeconds,
    cacheDir: settings.cacheDir,
    cacheMaxGb: Math.round(settings.cacheMaxBytes / 1024 ** 3),
    cutConcurrency: settings.cutConcurrency,
  };
}
