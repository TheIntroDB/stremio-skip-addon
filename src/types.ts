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
 * How a progressive file is treated.
 *
 * `blocking` hold the play request until the cut is ready (bounded by
 *            CUT_WAIT_SECONDS / the config's own choice), so even the first play is cut
 * `on`       cut in the background; the original is served until the cut is ready
 * `off`      never cut a file: playlists are still spliced, but no video is copied
 */
export type CutMode = "on" | "blocking" | "off";

/** What a mode can be set to, from an env var or an install URL, or null. */
export function parseCutMode(value: unknown): CutMode | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().toLowerCase();
  if (raw === "blocking" || raw === "wait" || raw === "always") return "blocking";
  if (raw === "on" || raw === "background" || raw === "true" || raw === "1") return "on";
  if (raw === "off" || raw === "false" || raw === "0" || raw === "never") return "off";
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
  /** Route HLS segments (and keys/init segments) through this service too. */
  proxy?: boolean;
  /** This install's own cutting mode, overriding the deployment's default. */
  cuts?: CutMode;
  /** Overrides the addon name shown in Stremio. */
  name?: string;
}

/** Environment variables this service reads. See `.env.example`. */
export interface Env {
  /** TheIntroDB API key. Required; without it no lookups happen. */
  TIDB_API_KEY?: string;
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
