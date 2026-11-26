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

import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Settings } from "../addon/env.js";
import type { SkipWindow } from "../addon/types.js";
import { run } from "./ffmpeg.js";

/** Every piece of the card is this long. */
/**
 * The longest a single card piece is.
 *
 * The card is the film's pre-roll, and its length is however long the viewer actually waited, so it
 * is drawn one piece at a time while the wait goes on and frozen the moment the film can play. Two
 * seconds is one ffmpeg run, so the piece is where the wording ("Processing…", the ticker) is as
 * current as it can be without the drawing becoming the thing that is being waited for.
 */
export const SPLASH_PIECE_MS = 2_000;
/**
 * How much of the film must be packaged before the card is finished.
 *
 * Only used to size a card that has to be drawn in one go (a deployment with `PREROLL_SECONDS` set
 * but no piece drawn yet); a card that accumulated while a viewer waited is as long as the wait.
 */
export function cardSeconds(settings: Settings): number {
  return Math.max(2, Math.round(settings.prerollSeconds)) || 2;
}
/** How long the plain black piece the padding falls back to is. */
export const PAD_SECONDS = 6;
/** `splash00000.ts` — one piece of the card while the film is being cut. */
export const SPLASH_RE = /^splash\d{5}\.ts$/;
/** `done00000.ts` — the card once the film can play: it says what was removed, not "Processing…". */
export const DONE_RE = /^done\d{5}\.ts$/;
/** `pad00000.ts`: a plain piece the padding falls back to when no card can be drawn. */
export const PAD_RE = /^pad\d{5}\.(ts|m4s)$/;

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
  /**
   * What the card is saying: the work in progress, or what it turned out to be.
   *
   * A card that is never replaced is one a viewer seeks back to a week later, and "Processing…"
   * over an episode that was cut days ago is a lie. `done` says what went instead.
   */
  state?: "processing" | "done";
  /** With `state: "done"`: how long the pre-roll was, i.e. where the film starts on the timeline. */
  waitMs?: number;
  /**
   * A line under the windows, when there is something the viewer can act on.
   *
   * Right now that is one thing: this deployment is older than the release, and the person watching is
   * the person who would update it.
   */
  notice?: string | null;
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
 *
 * Two states, because the card is part of the video for good: while the film is being cut it says
 * so, and once it can play it says what happened instead -- the segments that went, and where the
 * film begins on the timeline. A viewer who seeks back to zero finds that, not "Processing…" over
 * an episode that was finished days ago.
 */
export function cardText(card: SplashCard): {
  title: string;
  subtitle: string;
  count: string;
  windows: string;
  notice: string;
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
  // How many segments are being cut at all: the windows below are the segments, so saying
  // "0 segments" over a list of two read as a broken counter rather than as progress.
  const count = card.windows.length;
  // Nothing that counts work a viewer cannot see: "(1/2)" is the packager's two kept stretches, not
  // two intros being removed, and it read as though the same segment were being cut twice.
  const done = card.state === "done";
  return {
    title: done ? "Segments removed" : "Processing…",
    subtitle: done
      ? // The pre-roll the viewer sat through is the film's offset on the timeline, so this is
        // the timecode a player's seek bar is pointing at when the film starts.
        `Video starts at ${clock(card.waitMs ?? 0)}`
      : card.subtitles
        ? "TheIntroDB is cutting the segments from your stream and generating subtitles"
        : "TheIntroDB is currently cutting the segments from your stream",
    count: `${count} ${count === 1 ? "segment" : "segments"}`,
    windows,
    // Nothing at all when the deployment is current: an empty line would be a gap in the card.
    notice: card.notice?.trim() ?? "",
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
  notice: "card.notice.txt",
  footer: "card.footer.txt",
} as const;

/** The ffmpeg arguments that draw one piece of the card. */
/** Amber: the one line on the card that is about this deployment rather than the episode. */
const NOTICE = "0xF5B60A";

export function splashArgs(
  out: string,
  offsetSeconds: number,
  seconds: number,
  dir: string,
  audio = "aac",
  notice: string | null = null,
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
    // The notice sits between the windows and the footer, in the accent rather than the grey of the
    // rest: it is the one line on the card the viewer can act on.
    ...(notice ? [`[v4]${draw(CARD_FILES.notice, FONT_REGULAR, 24, NOTICE, 592)}[v4b]`] : []),
    `[${notice ? "v4b" : "v4"}]${draw(CARD_FILES.footer, FONT_REGULAR, 22, GREY, 640)}[out]`,
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
    audio,
    "-b:a",
    // Silent either way; loud enough that a player does not treat the track as something to drop.
    audio === "aac" ? "48k" : "128k",
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

/** Draw one piece. Returns its name and size, or an error when ffmpeg could not make it. */
export type SplashResult = { ok: true; name: string; bytes: number } | { ok: false; error: string };

/**
 * One card piece: `splash00002.ts` while the film is being cut, `done00000.ts` once it can play.
 *
 * A piece is a fixed slice of the timeline (`offsetMs` in, its own length long), which is what lets
 * the card be built while a viewer waits: the pieces are continuous with each other, and the film
 * is appended after them with a discontinuity. The finished card is one piece as long as all the
 * processing pieces together, so replacing them never moves the film.
 */
export async function generateCardPiece(
  settings: Settings,
  dir: string,
  piece: { name: string; offsetMs: number; seconds: number; audio?: string },
  card: SplashCard,
): Promise<SplashResult> {
  const out = path.join(dir, piece.name);
  const text = cardText(card);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, CARD_FILES.title), `${text.title}\n`);
    await writeFile(path.join(dir, CARD_FILES.subtitle), `${text.subtitle}\n`);
    await writeFile(path.join(dir, CARD_FILES.count), `${text.count}\n`);
    await writeFile(path.join(dir, CARD_FILES.windows), `${text.windows}\n`);
    if (text.notice) await writeFile(path.join(dir, CARD_FILES.notice), `${text.notice}\n`);
    await writeFile(path.join(dir, CARD_FILES.footer), `${text.footer}\n`);
  } catch (error) {
    return { ok: false, error: `cannot write the card's text: ${String(error)}` };
  }
  const result = await run(
    settings.ffmpegPath,
    splashArgs(out, piece.offsetMs / 1000, piece.seconds, dir, piece.audio, text.notice || null),
    60_000,
  );
  if (result.code !== 0) {
    // The reason matters: without it, a deployment with no font or no badge shows nothing
    // and nobody can tell why.
    return { ok: false, error: result.stderr.trim().slice(-400) || `ffmpeg exited ${result.code}` };
  }
  try {
    const info = await stat(out);
    return { ok: true, name: piece.name, bytes: info.size };
  } catch {
    return { ok: false, error: "ffmpeg wrote no piece" };
  }
}

/**
 * A plain black piece with silence, for padding a playlist when no card can be drawn.
 *
 * The padding exists to make the playlist's declared length the episode's, so it must work
 * wherever the card does not: no font, no badge, nothing to read.
 *
 * It is written in the package's own container and with its own video codec, because a placeholder
 * a player cannot demux is worse than the stall it stands in for: a TS (or AVC) segment inside an
 * fMP4 HEVC playlist makes the player fail at the end of its buffer, where a placeholder should
 * just keep it waiting.
 */
export async function generatePadPiece(
  settings: Settings,
  dir: string,
  container: "ts" | "mp4" = "ts",
  codec?: string,
  audio = "aac",
): Promise<{ name: string; init: string | null } | null> {
  const fmp4 = container === "mp4";
  const name = fmp4 ? "pad00000.m4s" : "pad00000.ts";
  const init = fmp4 ? "init-pad.mp4" : null;
  const out = path.join(dir, name);
  try {
    if ((await stat(out)).size > 0) return { name, init };
  } catch {
    // Not made yet.
  }
  // The picture is a black frame, so the encoder only has to produce one that decodes: the same
  // codec as the film, at the same nominal rate, so a player hands the pieces to the decoder it
  // already has running.
  const video = ["-c:v", codec === "hevc" ? "libx265" : "libx264", "-preset", "ultrafast"];
  if (codec === "hevc") video.push("-x265-params", "log-level=error", "-tag:v", "hvc1");
  const shape = [
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
    ...video,
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    audio,
    "-b:a",
    audio === "aac" ? "48k" : "128k",
    "-t",
    String(PAD_SECONDS),
  ];
  const result = await run(
    settings.ffmpegPath,
    fmp4
      ? [
          ...shape,
          // One segment, so the placeholder is one playlist entry and one initialisation section.
          "-f",
          "hls",
          "-hls_time",
          String(PAD_SECONDS),
          "-hls_list_size",
          "0",
          "-hls_segment_type",
          "fmp4",
          "-hls_fmp4_init_filename",
          init!,
          "-hls_segment_filename",
          path.join(dir, "pad%05d.m4s"),
          // The playlist the muxer insists on writing; the package reads its own records, and the
          // segment route refuses a name that is not one of ours.
          path.join(dir, "pad.m3u8"),
        ]
      : [...shape, "-muxdelay", "0", "-muxpreload", "0", "-f", "mpegts", out],
    60_000,
  );
  if (result.code !== 0) return null;
  try {
    return (await stat(out)).size > 0 ? { name, init } : null;
  } catch {
    return null;
  } finally {
    // The muxer's own playlist is only there to be written; the package reads its records and the
    // segment route refuses a name that is not one of ours, so it would just be litter.
    if (fmp4) await rm(path.join(dir, "pad.m3u8"), { force: true });
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
