// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * What has to be transcribed, and where each piece of it lands in the cut video.
 *
 * The packaging deletes whole windows, so the cut video is the source with stretches removed --
 * which means a word's position in the cut video is its position in the source minus everything
 * deleted before it, plus the processing card the player watches first. That is the whole mapping,
 * and it is computed here rather than while transcribing so it can be tested without a model.
 */

import { keptRanges } from "./ffmpeg.js";
import type { SkipWindow } from "./types.js";

/** How much audio is transcribed in one go. */
export const CHUNK_SECONDS = 300;

/** One stretch of audio to transcribe, and where it starts on the presentation's clock. */
export interface ChunkJob {
  sourceStartMs: number;
  sourceEndMs: number;
  /** Where this chunk begins in the cut video: after the card, and after the earlier stretches. */
  editedStartMs: number;
}

export interface StretchJob {
  /** Which stretch of the presentation this is, oldest first. */
  index: number;
  sourceStartMs: number;
  sourceEndMs: number;
  editedStartMs: number;
  chunks: ChunkJob[];
}

/**
 * The stretches of a source that survive the windows, chunked, each with its presentation offset.
 *
 * `cardMs` is the processing card the player sees before the film; it comes first in the playlist,
 * so every time here is measured from the start of the presentation, card included. A source whose
 * length is not known cannot be planned: without it the last window would be open-ended and a
 * subtitle would be shifted by a guess.
 */
export function planStretches(
  durationMs: number | null,
  windows: readonly SkipWindow[],
  cardMs: number,
  chunkSeconds = CHUNK_SECONDS,
): StretchJob[] {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs <= 0) return [];
  const chunkMs = Math.max(1, Math.round(chunkSeconds * 1000));
  const stretches: StretchJob[] = [];
  let edited = Math.max(0, Math.round(cardMs));

  for (const range of keptRanges(windows, durationMs)) {
    const chunks: ChunkJob[] = [];
    let cursor = range.startMs;
    while (cursor < range.endMs) {
      const end = Math.min(cursor + chunkMs, range.endMs);
      chunks.push({ sourceStartMs: cursor, sourceEndMs: end, editedStartMs: edited });
      edited += end - cursor;
      cursor = end;
    }
    if (chunks.length === 0) continue;
    stretches.push({
      index: stretches.length,
      sourceStartMs: range.startMs,
      sourceEndMs: range.endMs,
      editedStartMs: chunks[0]!.editedStartMs,
      chunks,
    });
  }
  return stretches;
}

/** The presentation's length: the card, then every kept stretch. */
export function presentationMs(durationMs: number | null, windows: readonly SkipWindow[], cardMs: number): number | null {
  const stretches = planStretches(durationMs, windows, cardMs);
  if (stretches.length === 0) return null;
  const last = stretches[stretches.length - 1]!;
  const lastChunk = last.chunks[last.chunks.length - 1]!;
  return lastChunk.editedStartMs + (lastChunk.sourceEndMs - lastChunk.sourceStartMs);
}
