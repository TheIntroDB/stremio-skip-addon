// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * HLS playlist surgery.
 *
 * Stremio players have no in-player "skip" hook for addons, so the only way an
 * addon can remove a segment is to physically remove it from the stream. For HLS
 * that is a manifest operation: drop the media segments whose time range overlaps
 * a skip window, put `#EXT-X-DISCONTINUITY` where the timeline jumps, and leave
 * every other tag alone.
 *
 * What this module does NOT do: re-encode, or touch progressive files. A `.mkv`
 * or `.mp4` cannot be cut without a transcoder, so the caller redirects those to
 * the origin. Accuracy is therefore bounded by the segment length (2-10s for
 * typical VOD playlists): a cut lands on a segment boundary, never inside one.
 */

import type { SkipWindow } from "../addon/types.js";

export interface HlsSegment {
  /** Every tag that belongs to this segment, in file order, including `#EXTINF`. */
  tags: string[];
  /** The segment URI as it appeared in the playlist (possibly relative). */
  uri: string;
  durationMs: number;
  startMs: number;
  endMs: number;
}

export interface MediaPlaylist {
  /** Everything before the first `#EXTINF`, emitted unconditionally. */
  header: string[];
  segments: HlsSegment[];
  /** Tags after the last segment URI, e.g. `#EXT-X-ENDLIST`. */
  trailer: string[];
  durationMs: number;
}

/** How a rewritten playlist should refer back to media. */
export interface UriRewriters {
  /** For URIs that are themselves playlists (variants, renditions). */
  playlistUri: (absoluteUri: string) => string;
  /** For URIs that are media resources (segments, keys, init segments). */
  resourceUri: (absoluteUri: string) => string;
}

export interface SpliceResult {
  text: string;
  droppedSegments: number;
  droppedMs: number;
  durationMs: number;
  /** True when `text` differs from the input. */
  changed: boolean;
  /** True when the windows would have removed every segment; nothing was cut. */
  degenerate: boolean;
  /** The windows that were in range for this file. Windows past its end are dropped. */
  windows: SkipWindow[];
}

const EXTINF_RE = /^#EXTINF:\s*([0-9]+(?:\.[0-9]+)?)/;
const BYTERANGE_RE = /^#EXT-X-BYTERANGE:\s*(\d+)(?:@(\d+))?\s*$/;

const PLAYLIST_URI_TAGS = [
  "#EXT-X-MEDIA:",
  "#EXT-X-I-FRAME-STREAM-INF:",
  "#EXT-X-RENDITION-REPORT:",
];
const RESOURCE_URI_TAGS = [
  "#EXT-X-KEY:",
  "#EXT-X-SESSION-KEY:",
  "#EXT-X-MAP:",
  "#EXT-X-PART:",
  "#EXT-X-PRELOAD-HINT:",
  "#EXT-X-SESSION-DATA:",
];

export function isPlaylist(text: string): boolean {
  return text.trimStart().startsWith("#EXTM3U");
}

export function isMasterPlaylist(text: string): boolean {
  return /^#EXT-X-STREAM-INF:/m.test(text);
}

export function isMediaPlaylist(text: string): boolean {
  return /^#EXTINF:/m.test(text);
}

/** Split a media playlist into header, segments and trailer. Null when it is not one. */
export function parseMediaPlaylist(text: string): MediaPlaylist | null {
  if (!isPlaylist(text)) return null;

  const header: string[] = [];
  const segments: HlsSegment[] = [];
  const trailer: string[] = [];
  let pendingTags: string[] = [];
  let pendingDurationMs: number | null = null;
  let headerClosed = false;
  let cursorMs = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;

    if (line.startsWith("#")) {
      const extinf = EXTINF_RE.exec(line);
      if (extinf) {
        if (!headerClosed) {
          // Everything before the first segment is playlist-level: it must
          // survive even when the segment that follows it is dropped.
          headerClosed = true;
          header.push(...pendingTags);
          pendingTags = [];
        }
        pendingDurationMs = Math.round(Number(extinf[1]) * 1000);
      }
      pendingTags.push(line);
      continue;
    }

    if (pendingDurationMs === null) {
      // A bare URI with no #EXTINF. Inside the header that is a stray variant
      // line; after it, the playlist is malformed -- keep it out of the timeline.
      if (!headerClosed) header.push(...pendingTags, line);
      pendingTags = [];
      continue;
    }

    const durationMs = pendingDurationMs;
    segments.push({
      tags: pendingTags,
      uri: line,
      durationMs,
      startMs: cursorMs,
      endMs: cursorMs + durationMs,
    });
    cursorMs += durationMs;
    pendingTags = [];
    pendingDurationMs = null;
  }

  if (segments.length === 0) return null;
  trailer.push(...pendingTags);

  return { header, segments, trailer, durationMs: cursorMs };
}

/**
 * Remove the segments overlapping `windows`.
 *
 * Windows that start at or past the end of the playlist are ignored: they belong
 * to a different release cluster of the same episode, and applying them would cut
 * the wrong part of the file.
 */
export function spliceMediaPlaylist(
  text: string,
  options: {
    baseUrl: string;
    windows: readonly SkipWindow[];
    rewriters: UriRewriters;
    /** Rebuild the playlist even when nothing is dropped (proxy mode needs it). */
    forceRewrite?: boolean;
  },
): SpliceResult | null {
  const playlist = parseMediaPlaylist(text);
  if (!playlist) return null;

  const durationMs = playlist.durationMs;
  const usable = options.windows
    .map((window) => ({
      type: window.type,
      startMs: Math.max(0, window.startMs),
      // A null end runs to the end of THIS file; keep the null in the report so
      // the cut is still described as "credits 57:12-end".
      endMs: window.endMs,
      effectiveEndMs: window.endMs === null ? durationMs : window.endMs,
    }))
    .filter((window) => window.startMs < durationMs && window.effectiveEndMs > window.startMs);

  const overlapping = (segment: HlsSegment): boolean =>
    usable.some(
      (window) => segment.startMs < window.effectiveEndMs && segment.endMs > window.startMs,
    );
  // Resolve byte ranges first: an implicit offset means "starts where the previous
  // range ended", which is only true of the ORIGINAL sequence, so dropping a
  // segment silently shifts every implicit offset after it. The cursor has to walk
  // dropped segments too.
  let byteCursor = 0;
  const ranges = playlist.segments.map((segment) => {
    const tag = segment.tags.find((candidate) => candidate.startsWith("#EXT-X-BYTERANGE:"));
    if (!tag) return null;
    const match = BYTERANGE_RE.exec(tag);
    if (!match) return null;
    const length = Number(match[1]);
    const offset = match[2] === undefined ? byteCursor : Number(match[2]);
    byteCursor = offset + length;
    return { length, offset };
  });

  const output: string[] = playlist.header.map((line) =>
    rewriteTagUris(line, options.baseUrl, options.rewriters.resourceUri),
  );
  let stickyMap = playlist.header.find((tag) => tag.startsWith("#EXT-X-MAP:")) ?? null;
  let initEmitted = stickyMap !== null;
  let keptBefore = false;
  let resuming = false;
  let kept = 0;
  let droppedSegments = 0;
  let droppedMs = 0;

  for (let index = 0; index < playlist.segments.length; index++) {
    const segment = playlist.segments[index]!;

    // Note the init segment even when the segment carrying it is dropped: the
    // segments after the jump still need it, and it belongs before the media.
    const declaredMap = segment.tags.find((tag) => tag.startsWith("#EXT-X-MAP:"));
    if (declaredMap) stickyMap = declaredMap;

    if (overlapping(segment)) {
      droppedSegments++;
      droppedMs += segment.durationMs;
      if (keptBefore) resuming = true;
      continue;
    }

    if (resuming) {
      output.push("#EXT-X-DISCONTINUITY");
      initEmitted = false;
      resuming = false;
    }

    // An init segment must precede the media it applies to. When the segment that
    // declared it was dropped, re-declare it here, before the first segment that
    // survives -- and before its #EXTINF, which is where a player expects it.
    const declaresMap = segment.tags.some((tag) => tag.startsWith("#EXT-X-MAP:"));
    if (!initEmitted && stickyMap && !declaresMap) {
      output.push(rewriteTagUris(stickyMap, options.baseUrl, options.rewriters.resourceUri));
      initEmitted = true;
    }

    const range = ranges[index];
    for (const tag of segment.tags) {
      if (tag.startsWith("#EXT-X-DISCONTINUITY")) {
        // A boundary from the source: anything after it needs its own init segment.
        output.push(tag);
        initEmitted = false;
        continue;
      }
      if (tag.startsWith("#EXT-X-MAP:")) {
        stickyMap = tag;
        output.push(rewriteTagUris(tag, options.baseUrl, options.rewriters.resourceUri));
        initEmitted = true;
        continue;
      }
      if (tag.startsWith("#EXT-X-BYTERANGE:")) {
        if (range) output.push(`#EXT-X-BYTERANGE:${range.length}@${range.offset}`);
        continue;
      }
      output.push(rewriteTagUris(tag, options.baseUrl, options.rewriters.resourceUri));
    }

    output.push(options.rewriters.resourceUri(absoluteUri(segment.uri, options.baseUrl)));
    kept++;
    keptBefore = true;
  }

  output.push(...playlist.trailer);

  const degenerate = kept === 0;
  if (degenerate) {
    return {
      text,
      droppedSegments: 0,
      droppedMs: 0,
      durationMs,
      changed: false,
      degenerate: true,
      windows: [],
    };
  }

  const changed = droppedSegments > 0 || options.forceRewrite === true;
  return {
    text: changed ? `${output.join("\n")}\n` : text,
    droppedSegments,
    droppedMs,
    durationMs,
    changed,
    degenerate: false,
    windows: usable.map((window) => ({
      type: window.type,
      startMs: window.startMs,
      endMs: window.endMs,
    })),
  };
}

/** Point every variant and rendition of a master playlist at a rewritten playlist. */
export function rewriteMasterPlaylist(
  text: string,
  baseUrl: string,
  rewriters: UriRewriters,
): string {
  const output: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;
    if (line.startsWith("#")) {
      const isPlaylistTag = PLAYLIST_URI_TAGS.some((prefix) => line.startsWith(prefix));
      const isResourceTag = RESOURCE_URI_TAGS.some((prefix) => line.startsWith(prefix));
      if (isPlaylistTag) output.push(rewriteTagUris(line, baseUrl, rewriters.playlistUri));
      else if (isResourceTag) output.push(rewriteTagUris(line, baseUrl, rewriters.resourceUri));
      else output.push(line);
      continue;
    }
    // A bare URI line in a master playlist is a variant playlist.
    output.push(rewriters.playlistUri(absoluteUri(line, baseUrl)));
  }
  return `${output.join("\n")}\n`;
}

/** Rewrite every `URI="..."` attribute of a tag through `rewrite`. */
export function rewriteTagUris(
  tag: string,
  baseUrl: string,
  rewrite: (absoluteUri: string) => string,
): string {
  return tag.replace(/URI="([^"]*)"/g, (_match, uri: string) => {
    return `URI="${rewrite(absoluteUri(uri, baseUrl))}"`;
  });
}

/** Resolve a playlist-relative URI against the playlist URL. */
export function absoluteUri(uri: string, baseUrl: string): string {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(uri)) return uri;
  try {
    return new URL(uri, baseUrl).toString();
  } catch {
    try {
      return new URL(baseUrl).toString();
    } catch {
      return uri;
    }
  }
}
