// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * Shared types for the addon.
 *
 * The addon is deliberately narrow: it is a Stremio `stream` addon that relays
 * streams from whichever source addon the user configured, then removes segments
 * from those streams using timings from TheIntroDB -- by splicing HLS playlists,
 * or by remuxing a progressive file.
 */

/** The four segment kinds TheIntroDB serves. */
export const SEGMENT_TYPES = ["intro", "recap", "credits", "preview"] as const;

export type SegmentType = (typeof SEGMENT_TYPES)[number];

/**
 * What an install is willing to have cut.
 *
 * `mkv` is the default and means everything: HLS playlists are spliced, and a file with no
 * playlist (a debrid `.mkv`) is packaged -- always with the processing card in front, because a
 * player handed a playlist that grows under it is what makes it think the episode has ended.
 * `hls` leaves `.mkv`/`.mp4` files alone entirely and only splices playlists.
 *
 * This is an install's own choice, carried in its link (see `AddonConfig.cuts`); there is no
 * deployment-wide setting for it.
 */
export type CutMode = "mkv" | "hls";

/** What an install that says nothing about it gets: cut everything. */
export const DEFAULT_CUT_MODE: CutMode = "mkv";

/** The largest margin the page offers, in seconds. */
export const MAX_MARGIN_SECONDS = 30;

/**
 * A margin in seconds: whole seconds between 0 and MAX_MARGIN_SECONDS, or null when the
 * value is not one the service offers.
 */
export function parseMarginSeconds(value: unknown): number | null {
  const raw = typeof value === "number" ? value : typeof value === "string" ? value.trim() : "";
  if (raw === "") return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  const whole = Math.round(parsed);
  if (whole < 0 || whole > MAX_MARGIN_SECONDS) return null;
  return whole;
}

/** What a mode can be set to, from an env var or an install URL, or null. */
export function parseCutMode(value: unknown): CutMode | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().toLowerCase();
  // `blocking`/`on` both used to mean "cut mkvs" (the old modes differed only in whether the
  // first play waited); `off` never touched a file, which is what `hls` is.
  if (raw === "mkv" || raw === "blocking" || raw === "on" || raw === "wait" || raw === "always" ||
      raw === "background" || raw === "true" || raw === "1") return "mkv";
  if (raw === "hls" || raw === "playlists" || raw === "off" || raw === "false" || raw === "0" ||
      raw === "never") return "hls";
  return null;
}

/** Which segment kinds a deployment cuts by default. */
export const DEFAULT_SEGMENT_TYPES: readonly SegmentType[] = ["intro", "recap", "credits"];

/**
 * One time range to remove from a stream, in the media timeline.
 *
 * `endMs === null` means the segment runs to the end of the file (TheIntroDB
 * serves a null `end_ms` for credits and previews that are not closed).
 */
export interface SkipWindow {
  type: SegmentType;
  startMs: number;
  endMs: number | null;
}

/** Everything a user chooses once, carried in the addon URL. */
export interface AddonConfig {
  /** Base URL(s) of the source stream addon(s), tried in order. */
  src: string[];
  /** Segment kinds to cut. Never guessed: whatever the config says, no more. */
  types: SegmentType[];
  /** Optional per-config TheIntroDB API key. The deployment's own key is preferred. */
  key?: string;
  /**
   * This install's cutting mode: whether files with no playlist of their own are packaged too.
   * Absent means `DEFAULT_CUT_MODE` -- everything cut.
   */
  cuts?: CutMode;
  /** This install's own margin on each cut, in seconds, overriding the deployment's. */
  margin?: number;
  /** Overrides the addon name shown in Stremio. */
  name?: string;
  /** This install's own request to generate subtitles for the cut video. */
  subtitles?: boolean;
}

/** Environment variables this service reads. See `.env.example`. */
export interface Env {
  /**
   * TheIntroDB API key for the whole deployment. Optional: a key can also be pasted on the
   * configuration page, where it rides in that install's link. One of the two is needed for
   * lookups -- anonymous lookups are limited per IP.
   */
  TIDB_API_KEY?: string;
  /** How much of each window's edges to leave alone, in seconds. */
  skipMarginSeconds?: number;
  /**
   * Development escape hatch: allow fetching private/loopback hosts, so a source
   * addon on the same machine can be used. Leave unset in production.
   */
  ALLOW_PRIVATE_HOSTS?: string;
}

/** One stream as returned by the source addon (the fields we care about). */
export interface UpstreamStream {
  url?: string;
  ytId?: string;
  infoHash?: string;
  fileIdx?: number;
  name?: string;
  title?: string;
  description?: string;
  behaviorHints?: Record<string, unknown>;
  [key: string]: unknown;
}

/** The shape TheIntroDB answers with on `GET /v4/media`. */
export interface IntroDbMediaResponse {
  tvdb_id?: number | null;
  type?: string | null;
  season?: number | null;
  episode?: number | null;
  group_duration_ms?: number | null;
  intro?: IntroDbSegment[] | null;
  recap?: IntroDbSegment[] | null;
  credits?: IntroDbSegment[] | null;
  preview?: IntroDbSegment[] | null;
}

/** One segment as TheIntroDB serves it. Either bound may be null. */
export interface IntroDbSegment {
  start_ms?: number | null;
  end_ms?: number | null;
}
