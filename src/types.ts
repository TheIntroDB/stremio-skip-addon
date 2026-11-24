// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * Shared types for the addon.
 *
 * The addon is deliberately narrow: it is a Stremio `stream` addon that relays
 * streams from whichever source addon the user configured, and rewrites the
 * HLS playlists of those streams using timings from TheIntroDB.
 */

/** The four segment kinds TheIntroDB serves. */
export const SEGMENT_TYPES = ["intro", "recap", "credits", "preview"] as const;

export type SegmentType = (typeof SEGMENT_TYPES)[number];

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
  /** Optional per-config TheIntroDB API key. The Worker secret is preferred. */
  key?: string;
  /** Route HLS segments (and keys/init segments) through this Worker too. */
  proxy?: boolean;
  /** Overrides the addon name shown in Stremio. */
  name?: string;
}

/** Bindings and vars this Worker reads. See `wrangler.jsonc`. */
export interface Env {
  /** Public, read-only TheIntroDB API. Defaults to `https://api.theintrodb.org`. */
  INTRODB_API_BASE?: string;
  /** Public site, used for links in the config page. */
  SITE_URL?: string;
  /** Deployment-wide TheIntroDB API key. */
  TIDB_API_KEY?: string;
  /**
   * Development escape hatch: allow fetching private/loopback hosts.
   * Leave unset in production, it turns the playlist relay into an SSRF hole.
   */
  ALLOW_PRIVATE_HOSTS?: string;
  /** Development/test override: use an in-process cache instead of the edge cache. */
  CACHE_MODE?: string;
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
