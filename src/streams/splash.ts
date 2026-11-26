// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * The processing card.
 *
 * While a file is being packaged there is nothing of the episode to play yet. A player
 * handed nothing shows a spinner, a black screen or "failed to start"; a player handed
 * *this* shows what is happening: the badge, "Processing…", how many segments have been
 * cut, and which windows are being removed.
 *
 * It is generated one two-second piece at a time, on demand, so each piece can carry the
 * numbers as they were when it was drawn -- the card moves while the work happens. The
 * pieces are generated with an explicit timestamp offset, so they form one continuous
 * timeline even though each is a separate ffmpeg run (synthetic input has no seek, so the
 * offset lands exactly; a piece starts at 0.000, the next at 2.000, and so on).
 */

import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Settings } from "../addon/env.js";
import type { SkipWindow } from "../addon/types.js";
import { run } from "./ffmpeg.js";

/** Every piece of the card is this long. */
/**
 * How long the card is.
 *
 * Exactly the pre-roll buffer, and drawn as a single piece, which makes two things true that
 * matter: the player spends the same 10 seconds on the card however fast the source is (so the
 * episode always starts at the same point in the playlist), and the subtitle track generated for
 * the cut video can be shifted by that fixed amount and stay aligned. Pieces used to be two
 * seconds each and drawn for as long as the episode could not play, which made the episode's
 * start time depend on how the race went.
 */
export function cardSeconds(settings: Settings): number {
  return Math.max(2, Math.round(settings.prerollSeconds)) || 2;
}
/** The stated length of a card piece when its real one cannot be read back. */
export const SPLASH_PIECE_MS = 2_000;
/** How long the plain black piece the padding falls back to is. */
export const PAD_SECONDS = 6;
/** `splash00000.ts`, kept beside the package's own segments. */
export const SPLASH_RE = /^splash\d{5}\.ts$/;
/** `pad00000.ts`: a plain piece the padding falls back to when no card can be drawn. */
export const PAD_RE = /^pad\d{5}\.ts$/;

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 5;
const GREY = "0x93a09a";
const BACKDROP = "0x0b0d0c";
const FONT_REGULAR = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
const FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

/** The org's own badge, vendored so drawing a card never needs the network. */
export const BADGE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "assets",
  "badge.png",
);

export interface SplashCard {
  /**
   * Segments of the episode written so far, at the moment this piece is drawn. It drives the
   * ticker; the *count* on the card is how many segments there are to cut in total, because
   * that is the number the card's own list of windows shows and the two must not disagree.
   */
  segments: number;
  /** The windows being removed, so the card can name them. */
  windows: readonly SkipWindow[];
  /** Which stretch ffmpeg is writing, 1-based, and how many there are. */
  pass: number;
  passes: number;
  /** Whether a subtitle track is being generated, so the card can say so. */
  subtitles?: boolean;
}

const TYPE_LABEL: Record<string, string> = {
  intro: "Intro",
  recap: "Recap",
  credits: "Credits",
  preview: "Preview",
};

/** `3:50` from milliseconds. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const head = hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}` : String(minutes);
  return `${head}:${String(seconds).padStart(2, "0")}`;
}

/**
 * What the card says.
 *
 * Separated from the drawing so the wording can be asserted without reading pixels.
 */
export function cardText(card: SplashCard): {
  title: string;
  subtitle: string;
  count: string;
  windows: string;
  footer: string;
} {
  const windows = card.windows
    .map(
      (window) =>
        `${TYPE_LABEL[window.type] ?? window.type} ${clock(window.startMs)}-${
          window.endMs === null ? "end" : clock(window.endMs)
        }`,
    )
    .join("  ·  ");
  // A ticker that advances with the work: each piece is drawn a couple of seconds after the
  // last, so this is what makes the card move rather than sit still.
  const dots = "·".repeat(card.segments % 9);
  // How many segments are being cut at all: the windows below are the segments, so saying
  // "0 segments" over a list of two read as a broken counter rather than as progress.
  const count = card.windows.length;
  const where = card.passes > 1 ? `   (${card.pass}/${card.passes})` : "";
  return {
    title: "Processing…",
    subtitle: card.subtitles
      ? "TheIntroDB is cutting the segments from your stream and generating subtitles"
      : "TheIntroDB is currently cutting the segments from your stream",
    count: `${count} ${count === 1 ? "segment" : "segments"}`,
    windows: windows ? `${windows}${where}   ${dots}`.trimEnd() : dots,
    footer: "Go to theintrodb.org to submit or report incorrect segments",
  };
}

/**
 * The card's four lines are handed to ffmpeg as *files*, not as `text=` arguments.
 *
 * A colon cannot be passed through a filter graph at all: `\:` does not survive the graph
 * parser and quoting the value does not either (both were tested against the ffmpeg in
 * this image). A text file has no escaping to get wrong, and since each piece is drawn by
 * its own ffmpeg run there is nothing to reload.
 */
export const CARD_FILES = {
  title: "card.title.txt",
  subtitle: "card.subtitle.txt",
  count: "card.count.txt",
  windows: "card.windows.txt",
  footer: "card.footer.txt",
} as const;

/** The ffmpeg arguments that draw one piece of the card. */
export function splashArgs(
  out: string,
  offsetSeconds: number,
  seconds: number,
  dir: string,
): string[] {
  const draw = (file: string, font: string, size: number, color: string, y: number): string =>
    `drawtext=fontfile=${font}:textfile=${path.join(dir, file)}:fontsize=${size}:fontcolor=${color}:x=(w-text_w)/2:y=${y}`;

  const graph = [
    `[2:v]scale=200:-1,format=rgba[badge]`,
    `[0:v][badge]overlay=x=(W-w)/2:y=120[v0]`,
    `[v0]${draw(CARD_FILES.title, FONT_BOLD, 66, "white", 360)}[v1]`,
    `[v1]${draw(CARD_FILES.subtitle, FONT_REGULAR, 28, "white", 452)}[v2]`,
    `[v2]${draw(CARD_FILES.count, FONT_REGULAR, 26, GREY, 524)}[v3]`,
    `[v3]${draw(CARD_FILES.windows, FONT_REGULAR, 26, GREY, 566)}[v4]`,
    `[v4]${draw(CARD_FILES.footer, FONT_REGULAR, 22, GREY, 628)}[out]`,
  ].join(";");

  return [
    "-nostdin",
    "-hide_banner",
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=${BACKDROP}:s=${WIDTH}x${HEIGHT}:r=${FPS}`,
    // A silent track, so the card has the same stream layout as the episode that follows it.
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=48000:cl=stereo",
    "-loop",
    "1",
    "-i",
    BADGE_PATH,
    "-filter_complex",
    graph,
    "-map",
    "[out]",
    "-map",
    "1:a",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-g",
    String(FPS * 2),
    "-c:a",
    "aac",
    "-b:a",
    "48k",
    // The offset is what makes the pieces one timeline, and the delay makes a piece start
    // at exactly its offset rather than a second and a half later.
    "-muxdelay",
    "0",
    "-muxpreload",
    "0",
    "-output_ts_offset",
    offsetSeconds.toFixed(3),
    "-t",
    String(seconds),
    "-f",
    "mpegts",
    out,
  ];
}

/** Draw one piece. Returns its name and size, or null when ffmpeg could not make it. */
export type SplashResult = { ok: true; name: string; bytes: number } | { ok: false; error: string };

export async function generateSplashPiece(
  settings: Settings,
  dir: string,
  index: number,
  card: SplashCard,
): Promise<SplashResult> {
  const seconds = cardSeconds(settings);
  const name = `splash${String(index).padStart(5, "0")}.ts`;
  const out = path.join(dir, name);
  const text = cardText(card);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, CARD_FILES.title), `${text.title}\n`);
    await writeFile(path.join(dir, CARD_FILES.subtitle), `${text.subtitle}\n`);
    await writeFile(path.join(dir, CARD_FILES.count), `${text.count}\n`);
    await writeFile(path.join(dir, CARD_FILES.windows), `${text.windows}\n`);
    await writeFile(path.join(dir, CARD_FILES.footer), `${text.footer}\n`);
  } catch (error) {
    return { ok: false, error: `cannot write the card's text: ${String(error)}` };
  }
  const result = await run(
    settings.ffmpegPath,
    splashArgs(out, index * seconds, cardSeconds(settings), dir),
    60_000,
  );
  if (result.code !== 0) {
    // The reason matters: without it, a deployment with no font or no badge shows nothing
    // and nobody can tell why.
    return { ok: false, error: result.stderr.trim().slice(-400) || `ffmpeg exited ${result.code}` };
  }
  try {
    const info = await stat(out);
    return { ok: true, name, bytes: info.size };
  } catch {
    return { ok: false, error: "ffmpeg wrote no piece" };
  }
}

/**
 * A plain black two seconds with silence, for padding a playlist when no card can be drawn.
 *
 * The padding exists to make the playlist's declared length the episode's, so it must work
 * wherever the card does not: no font, no badge, nothing to read.
 */
export async function generatePadPiece(
  settings: Settings,
  dir: string,
): Promise<{ name: string } | null> {
  const name = "pad00000.ts";
  const out = path.join(dir, name);
  try {
    if ((await stat(out)).size > 0) return { name };
  } catch {
    // Not made yet.
  }
  const result = await run(
    settings.ffmpegPath,
    [
      "-nostdin",
      "-hide_banner",
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=${BACKDROP}:s=${WIDTH}x${HEIGHT}:r=${FPS}`,
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=48000:cl=stereo",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "48k",
      "-muxdelay",
      "0",
      "-muxpreload",
      "0",
      "-t",
      String(PAD_SECONDS),
      "-f",
      "mpegts",
      out,
    ],
    60_000,
  );
  if (result.code !== 0) return null;
  try {
    return (await stat(out)).size > 0 ? { name } : null;
  } catch {
    return null;
  }
}

/** Whether the card can be drawn at all: ffmpeg, a font and the badge. */
export async function splashAvailable(
  settings: Settings,
): Promise<{ ok: boolean; detail: string }> {
  for (const [what, file] of [
    ["font", FONT_REGULAR],
    ["bold font", FONT_BOLD],
    ["badge", BADGE_PATH],
  ] as const) {
    try {
      await stat(file);
    } catch {
      return { ok: false, detail: `the processing card needs a readable ${what}: ${file}` };
    }
  }
  const probe = await run(settings.ffmpegPath, ["-hide_banner", "-h", "filter=drawtext"], 10_000);
  if (probe.code !== 0 || !/drawtext/.test(probe.stdout + probe.stderr)) {
    return {
      ok: false,
      detail: "this ffmpeg has no drawtext filter, so the processing card cannot be drawn",
    };
  }
  return { ok: true, detail: `card -> ${BADGE_PATH}` };
}
