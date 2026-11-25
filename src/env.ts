// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * Configuration, read once from the environment at boot.
 *
 * This is a self-hosted service, so there is no bindings object: everything comes
 * from process.env (Docker `-e`, a `.env` file, or a `.env` passed with
 * `node --env-file=.env`).
 */

import { INTRODB_API_BASE } from "./constants.js";
import { parseCutMode, type CutMode, type Env } from "./types.js";

export type { CutMode } from "./types.js";

export interface Settings extends Env {
  port: number;
  /** Where cut files live. */
  cacheDir: string;
  /** How much disk the cut cache may use before the oldest cut is evicted. */
  cacheMaxBytes: number;
  /** The deployment's default; an install URL may override it. See `CutMode`. */
  cuts: CutMode;
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

/** The deployment's cutting mode, from `CUTS`. Defaults to always cutting. */
function cutMode(): CutMode {
  return parseCutMode(process.env.CUTS) ?? "blocking";
}

export function loadSettings(): Settings {
  return {
    TIDB_API_KEY: process.env.TIDB_API_KEY ?? "",
    ALLOW_PRIVATE_HOSTS: process.env.ALLOW_PRIVATE_HOSTS ?? "",
    port: numberFrom("PORT", 8787),
    cacheDir: process.env.CACHE_DIR ?? "./cache",
    cacheMaxBytes: Math.max(0, numberFrom("CACHE_MAX_GB", 50) * 1024 ** 3),
    cuts: cutMode(),
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
    api: `${INTRODB_API_BASE}/v4/media`,
    apiKeyConfigured: Boolean((settings.TIDB_API_KEY ?? "").trim()),
    cuts: settings.cuts,
    cacheDir: settings.cuts === "off" ? null : settings.cacheDir,
    cacheMaxGb: settings.cuts === "off" ? null : Math.round(settings.cacheMaxBytes / 1024 ** 3),
    cutConcurrency: settings.cuts === "off" ? null : settings.cutConcurrency,
  };
}
