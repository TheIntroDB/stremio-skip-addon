// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * Recognised words into cues, and cues onto the cut video's clock.
 *
 * Subtitles a player can "entitle" are the ones it can trust, so the rules here are deliberately
 * forgiving about the *input* and strict about the *output*: a recogniser and its refinement pass
 * place a word's start independently of its neighbours, so words arrive out of order, slightly
 * before the audio they came from, or with an end at or before their start. A cue that violates
 * that is not a slightly wrong subtitle -- a strict consumer drops the track, or the chunk, or the
 * whole job, which is the failure the Silo Tiny Subtitles plugin hit and fixed: sort, clamp, drop
 * what cannot be spoken, and never let a cue hang into the next one.
 */

/** A word as a recogniser gives it: text with a start and an end, in seconds. */
export interface Word {
  text: string;
  start: number;
  end: number;
}

/** One subtitle, in seconds. */
export interface Cue {
  text: string;
  start: number;
  end: number;
}

/** A cue is shown for at least this long, when the next one allows it. */
export const MIN_CUE_SECONDS = 0.7;
/** ...and split past this, so a cue is readable at a glance. */
export const MAX_CUE_SECONDS = 7;
/** A silence this long ends a cue even mid-sentence. */
export const CUE_BREAK_SECONDS = 0.6;
/** A cue longer than this is split: two lines of ~42 characters in a player's box. */
export const MAX_CUE_CHARS = 84;

/** A word with no letter and no digit in it is a recogniser's punctuation noise. */
const SPOKEN_RE = /[\p{L}\p{N}]/u;

/**
 * The cues a recogniser's words make, every one of them usable.
 *
 * `offsetSeconds` is added to every time, for a chorus of one: a chunk of audio transcribed from
 * the middle of a stretch needs its own position folded in.
 */
export function buildCues(words: readonly Word[], offsetSeconds = 0): Cue[] {
  const clean: Word[] = [];
  for (const word of words) {
    const text = typeof word?.text === "string" ? word.text.trim() : "";
    if (text === "" || !SPOKEN_RE.test(text)) continue;
    if (!Number.isFinite(word.start) || !Number.isFinite(word.end)) continue;
    // A recogniser can place a word a few milliseconds before the first sample it was given, and
    // a cue that starts before zero is dropped by consumers that validate their input.
    const start = Math.max(0, word.start + offsetSeconds);
    const end = word.end + offsetSeconds;
    if (end <= 0) continue;
    clean.push({ text, start, end: Math.max(end, start) });
  }
  clean.sort((a, b) => (a.start !== b.start ? a.start - b.start : a.end - b.end));

  const cues: Cue[] = [];
  for (const word of clean) {
    const current = cues[cues.length - 1];
    const joins =
      current !== undefined &&
      word.start - current.end <= CUE_BREAK_SECONDS &&
      `${current.text} ${word.text}`.length <= MAX_CUE_CHARS &&
      word.end - current.start <= MAX_CUE_SECONDS;
    if (!current || !joins) {
      cues.push({ text: word.text, start: word.start, end: word.end });
      continue;
    }
    current.text = `${current.text} ${word.text}`;
    current.end = Math.max(current.end, word.end);
  }

  const usable: Cue[] = [];
  for (let i = 0; i < cues.length; i += 1) {
    const cue = cues[i]!;
    const next = cues[i + 1];
    // Cover the words, reach the minimum, and stop at the next cue: a short cue followed by a
    // long silence must not hang over that silence -- that is the other half of "trustworthy".
    let end = Math.max(cue.end, cue.start + MIN_CUE_SECONDS);
    if (next) end = Math.min(end, next.start);
    if (end <= cue.start) continue; // a zero-length cue is the kind of thing that gets a track dropped
    usable.push({ text: cue.text.replace(/-->/g, "→"), start: cue.start, end });
  }
  return usable;
}

/**
 * A piece of audio, and where it sits on the presentation's clock.
 *
 * Cue times from a recogniser are relative to the audio file it was given, so the whole mapping is
 * one constant per chunk: the chunk's own position in the cut video. (The chunk's position in the
 * *source* is not needed here -- that is the plan's business, in `stretches.ts`.)
 */
export interface Chunk {
  /** Where this audio starts in the cut video: after the card, and after the earlier stretches. */
  editedStartSeconds: number;
  /** How much audio it holds. */
  durationSeconds: number;
}

/**
 * Move cues from their chunk's clock onto the presentation's, and drop what falls outside.
 *
 * The audio is transcribed in the same order it is packaged, so this is a constant shift per
 * chunk: recognition of the *cut* video and recognition of the source, then a translation. It is
 * the half of the job that makes the subtitles match the edited file.
 */
export function shiftCues(cues: readonly Cue[], chunk: Chunk): Cue[] {
  const out: Cue[] = [];
  for (const cue of cues) {
    // Clamp to the audio that was transcribed, then move the whole chunk onto the presentation.
    const start =
      chunk.editedStartSeconds + Math.min(Math.max(0, cue.start), chunk.durationSeconds);
    const end =
      chunk.editedStartSeconds +
      Math.min(Math.max(0, Math.max(cue.end, cue.start)), chunk.durationSeconds);
    if (end <= start) continue; // falls outside the audio itself: not this track's line
    out.push({ text: cue.text, start: round(start), end: round(end) });
  }
  return out;
}

/** `HH:MM:SS.mmm`, which is what WebVTT wants. */
export function vttClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const secs = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  return (
    [hours, minutes, secs].map((part) => String(part).padStart(2, "0")).join(":") +
    `.${String(millis).padStart(3, "0")}`
  );
}

/** A WebVTT file. `header` is written as a NOTE, which players ignore. */
export function toVtt(cues: readonly Cue[], header?: string): string {
  const lines = ["WEBVTT", ""];
  if (header) lines.push(`NOTE ${header}`, "");
  for (const cue of cues) {
    lines.push(`${vttClock(cue.start)} --> ${vttClock(cue.end)}`, cue.text, "");
  }
  return `${lines.join("\n")}\n`;
}

function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}
