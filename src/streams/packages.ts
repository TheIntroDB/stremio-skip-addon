// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * Skipping inside a file that has no playlist of its own.
 *
 * A debrid `.mkv` cannot be "cut" without either copying all of it first (which is
 * what a player times out on) or re-encoding it. So it is not cut at all: it is
 * *packaged* as HLS, one stretch at a time, and the playlist is the thing that skips.
 *
 * For every stretch that survives the windows, ffmpeg stream-copies it into MPEG-TS
 * segments (`-f segment`, no re-encode) and reports each finished segment in a CSV.
 * This service writes the playlist from those CSVs, so it can list exactly the
 * segments that are complete — the property that makes playback start after the first
 * segment rather than after the whole file:
 *
 *   1. the player asks to play
 *   2. a playlist is served as soon as one segment is on disk — typically a couple of
 *      seconds, whatever the file's size
 *   3. the playlist grows as ffmpeg writes (an EVENT playlist, so the player polls)
 *   4. it ends with #EXT-X-ENDLIST when the last stretch is done, and is then an
 *      ordinary seekable VOD playlist
 *
 * The dropped stretches are simply never generated: the playlist jumps from one
 * stretch to the next with #EXT-X-DISCONTINUITY between them. Nothing is fetched
 * twice — the segments the player pulls *are* the cache.
 *
 * The source URL is deliberately not written to the cache: a debrid link is a bearer
 * token, and the plan on disk only needs the stretches.
 */

import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Settings } from "../addon/env.js";
import type { SkipWindow } from "../addon/types.js";
import { delay, errorText, inputOptions, type KeptRange, keptRanges, run } from "./ffmpeg.js";
import {
  DONE_RE,
  generateCardPiece,
  generatePadPiece,
  PAD_RE,
  PAD_SECONDS,
  SPLASH_PIECE_MS,
  SPLASH_RE,
  splashAvailable,
} from "./splash.js";
import { chooseAudio, parseProbe, placeholderAudio, type StreamInfo } from "./streaminfo.js";

export type PackageStatus = "queued" | "generating" | "ready" | "failed";

export interface PackageState {
  key: string;
  status: PackageStatus;
  /** Where this package's segments and playlist live. */
  dir: string;
  /** How many stretches ffmpeg has been asked to generate. */
  passes: number;
  /** Segments complete so far. */
  segments: number;
  bytes: number;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

/** What a player needs in order to start, and how far along it is. */
/**
 * What container a package's segments are in.
 *
 * It is not a free choice: hls.js, and therefore every browser-based player, refuses to demux
 * HEVC from an MPEG-TS segment at all ("Unsupported HEVC in M2TS found"), so an HEVC source is
 * written as fragmented MP4, which those players pass through to a platform that can decode it.
 * Everything else stays TS, which is what every player already reads.
 */
/**
 * Which audio stream to keep, as ffmpeg stream selectors.
 *
 * A release with dubs marks one of them as its default track, and ffmpeg's own selection then
 * keeps that one -- so an install that asked for English gets the dub. This is the same choice the
 * install makes on the configuration page (`config.audioLang`), applied to what the package
 * carries rather than only to what used to be transcribed.
 *
 * No probe means no answer: the arguments are then omitted and ffmpeg decides, which is what
 * happened before this existed.
 */
export function audioMap(info: StreamInfo | null, language: string): string[] {
  if (!info) return [];
  const chosen = chooseAudio(info.audio, language, "en");
  // Video by name and the sound by its *container* index: `0:a:N` counts audio streams, so a file
  // with one audio track (index 1, after the picture) answered `0:a:1` -- the second sound, which
  // does not exist -- and ffmpeg refused the whole output. The index the probe reports is the
  // stream's own, which `-map 0:N` selects exactly.
  if (chosen) return ["-map", "0:v:0", "-map", `0:${chosen.index}`];
  // A probe that listed the audio and found none is a silent release: asking for `0:a:0` there is
  // the same refusal, so the picture is all that is mapped. (No list at all means the probe is
  // older than the list, where ffmpeg's own choice is still the right one.)
  return Array.isArray(info.audio) && info.audio.length === 0
    ? ["-map", "0:v:0"]
    : ["-map", "0:v:0", "-map", "0:a:0"];
}

export interface PackageFormat {
  container: "ts" | "mp4";
  /** The `#EXT-X-MAP` file of each pass, empty for TS. */
  inits: string[];
}

export interface ManifestView {
  body: string;
  complete: boolean;
  /** Segments of the episode itself that the playlist lists. */
  segments: number;
  /** Pieces of the processing card in the playlist, before the episode. */
  card: number;
  /** Placeholder entries standing in for the not-yet-packaged remainder. */
  padding: number;
  /** The length the playlist declares for the episode, when it is known. */
  expectedMs: number | null;
  /**
   * How much of the episode itself is packaged, in milliseconds.
   *
   * Distinct from `durationMs`, which is the whole presentation -- the card and the placeholder
   * included. This is the number that says whether playback can start on the film.
   */
  bufferedMs: number;
  /**
   * The card in front of the film, in milliseconds: where the film starts on the timeline.
   *
   * Zero when this playlist has no card (an fMP4 package, or one that never waited), which is also
   * what the subtitle rendition has to be told, or every cue sits one card late.
   */
  cardMs: number;
  durationMs: number;
}

interface Plan {
  key: string;
  windows: SkipWindow[];
  ranges: KeptRange[];
  createdAt: number;
}

const PACKAGE_ROOT = "hls";
/** Where the processing card's pieces are recorded, in the order they were drawn. */
const SPLASH_LIST = "splash.list";
/** The source's own length, probed once, so the playlist can declare the whole episode. */
const DURATION = "duration.json";
/**
 * What one placeholder entry of the not-yet-packaged remainder stands for.
 *
 * A player's reload cadence comes from #EXT-X-TARGETDURATION, so the padding cannot be one
 * enormous entry -- a two-hour target would mean the player waited two hours before noticing
 * the episode had arrived. One segment's worth keeps it behaving like any other playlist.
 */
const PAD_ENTRY_MS = PAD_SECONDS * 1000;
/**
 * How far past the packaged film the placeholder reaches.
 *
 * This is the whole reason a player can sit on "Processing…" over an episode that is right there:
 * an `#EXT-X-PLAYLIST-TYPE:EVENT` playlist is joined at its **live edge**, three target durations
 * before the end (`liveSyncDurationCount` in hls.js, the same rule in AVFoundation), whether or not
 * the player honours `#EXT-X-START`. A tail that declares the *whole episode* therefore puts the
 * live edge inside the placeholder for the entire packaging -- measured on a 20-minute episode:
 * 45 of its 284 entries were placeholder, they sat exactly at the end, and the player opened there
 * and stayed. When the film finished the playlist shrank to its real length, the player's position
 * fell at the very end of the episode, and the only way out was to close it and start again.
 *
 * So the tail is a short cushion instead: under three target durations, which keeps the live edge
 * inside the film that has already been packaged. The tail then moves forward as the film arrives,
 * and the position a player is already at is replaced by real segments under it.
 */
const PAD_HORIZON_MS = 12_000;
/**
 * The most card a playback is given, in two-second pieces.
 *
 * The card is the film's pre-roll, so a slow first view would otherwise bake a minute of "Processing…"
 * into every later viewing of that episode. Past this the wait is covered by the card in the tail of
 * the playlist -- which is the card too, while the film is being cut -- and the pre-roll stays a
 * length somebody can sit through.
 */
const CARD_MAX_PIECES = 15;
/**
 * How long a package may sit untouched before it is thrown away.
 *
 * This is one viewer's addon, not a cache for a crowd: a film nobody has asked for in five minutes is
 * dead weight -- the cut segments, the card, the placeholder, the subtitle chunks and the ffmpeg that
 * is still writing them. Everything for that key goes on the next sweep.
 */
const IDLE_MS = 5 * 60_000;
/** How often the idle sweep runs. Unref'd: it never keeps the process (or a test) alive. */
const SWEEP_MS = 30_000;
const PLAN = "plan.json";
const DONE = "done";
const PASS = "pass-";
/** `perpass.m3u8` is the playlist an fMP4 pass writes, and also its segment record. */
const PERPASS = "perpass.m3u8";
/** The one piece that replaces the processing pieces once the film can play. */
const DONE_NAME = "done00000.ts";
/** How often a waiting play re-reads the CSVs while the first segment is written. */
const POLL_MS = 250;
/** How often a new piece of the processing card is drawn while a package is being made. */
/** How long a card stays part of a key's playlist after the last request for it. */
const SPLASH_SESSION_MS = 15 * 60_000;
/** Target segment length. Longer only happens when keyframes are further apart. */
const SEGMENT_SECONDS = 4;
const KEY_RE = /^[0-9a-f]{8,40}$/;
/** How long a package stays off the eviction list after it was last served. */
const RECENT_MS = 3 * 60 * 60_000;
const FORMAT = "format.json";
const SEGMENT_RE = /^seg\d{5}\.(ts|m4s)$/;
/** The `#EXT-X-MAP` initialisation section of an fMP4 package, or of its placeholder. */
const INIT_RE = /^init-(?:\d+|pad)\.mp4$/;

export class PackageEngine {
  private readonly states = new Map<string, PackageState>();
  /** When each package was last served, so eviction leaves alone what is being watched. */
  private readonly used = new Map<string, number>();
  /**
   * Keys whose playlist is carrying the processing card, and how far it has got.
   *
   * The card is part of that *playlist*, so it stays listed once it has been drawn: a
   * player that started on the card must be able to finish it. A play request that arrives
   * when the package is already complete never starts one, which is why the card does not
   * appear before every episode.
   */
  private readonly cards = new Map<string, { pieces: number; lastAt: number; frozen: boolean }>();
  /** null until the boot probe says whether a card can be drawn here. */
  private cardOk: boolean | null = null;
  /** The last reason a card could not be drawn, for /health. */
  private cardError: string | null = null;
  /**
   * The codec string of the package last served.
   *
   * A container/codec a player cannot demux is invisible in the playlist -- the picture is simply
   * black while the audio plays -- so /health says what the segments actually hold.
   */
  private lastCodecs = "";
  private readonly running = new Map<string, Promise<PackageState>>();
  /**
   * Which stretch each package's ffmpeg is writing right now, and so which one has no CSV yet.
   *
   * An fMP4 pass only has its segment record in the playlist ffmpeg is still appending to, so the
   * reader has to know that the pass it is looking at is the one in flight rather than one that
   * has not started.
   */
  private readonly inFlight = new Map<string, number>();
  /**
   * The finished card being drawn for a key, so a burst of polls draws it once.
   *
   * It is a redraw of the pieces that are already there, at the same total length: replacing
   * "Processing…" with what was actually removed, after the fact.
   */
  private readonly finishings = new Map<string, Promise<void>>();
  /** Per-package ffmpeg control, so one film that nobody is watching can be stopped on its own. */
  private readonly aborts = new Map<string, AbortController>();
  /**
   * Called when a package is thrown away after five idle minutes, so whatever else holds state for it
   * -- the subtitle engine and its chunks -- can forget it too.
   */
  onIdle?: (key: string) => void;
  private reaper?: ReturnType<typeof setInterval>;
  /**
   * A line for the card when this deployment is older than the release.
   *
   * Answered from the version check's cache, so drawing a piece never waits on GitHub; a check that
   * has not answered yet simply means no notice.
   */
  notice?: () => string | null;
  private readonly tasks: Array<() => void> = [];
  private active = 0;
  private available: boolean | null = null;
  /**
   * When a film was last asked for: a playlist read or a segment fetch.
   *
   * The subtitle engine reads this to stop recognising a track nobody is watching. Set here
   * because this is the only thing that knows the video is still moving -- a paused player and a
   * closed one both stop asking.
   */
  lastActivity = Date.now();
  /**
   * Kills whatever ffmpeg this engine has running when a drain asks it to (see `drain`).
   *
   * Replaced rather than reused on every drain, because an aborted signal stays aborted and the
   * next playback has to be able to run normally.
   */
  private controller = new AbortController();

  constructor(private readonly settings: Settings) {}

  /** Abort signal for the ffmpeg jobs this engine starts. */
  private get signal(): AbortSignal {
    return this.controller.signal;
  }

  /**
   * Stop everything this engine is doing and forget what it knows.
   *
   * Used by `/drain`: the caller clears the cache immediately afterwards, so nothing may still be
   * writing into it. Queued work is dropped, in-flight ffmpeg is killed (its `finally` settles the
   * bookkeeping), and the in-memory map is emptied so the next play packages from scratch.
   */
  drain(): number {
    const stopped = this.states.size + this.running.size + this.tasks.length;
    this.controller.abort();
    this.controller = new AbortController();
    this.states.clear();
    this.used.clear();
    this.cards.clear();
    this.running.clear();
    this.inFlight.clear();
    this.finishings.clear();
    this.tasks.length = 0;
    return stopped;
  }

  /**
   * Delete every package nobody has asked for in `IDLE_MS`, and stop what is still working on it.
   *
   * `used` is written by every playlist read and every segment fetch, so this is "no player has shown
   * any interest" rather than "the job finished a while ago" -- a package still being written is being
   * asked for, and a package from a previous process is left to the size limit.
   */
  private sweepIdle(): void {
    const cutoff = Date.now() - IDLE_MS;
    for (const [key, at] of [...this.used]) {
      if (at > cutoff) continue;
      void this.discard(key);
    }
  }

  /** Throw one package away: stop its ffmpeg, delete its segments, and tell the rest of the world. */
  async discard(key: string): Promise<void> {
    this.aborts.get(key)?.abort();
    this.aborts.delete(key);
    this.states.delete(key);
    this.used.delete(key);
    this.cards.delete(key);
    this.inFlight.delete(key);
    this.finishings.delete(key);
    try {
      await rm(this.dirFor(key), { recursive: true, force: true });
    } catch {
      // A deletion that races a write is tried again on the next sweep, and the size limit is behind
      // this either way.
    }
    this.onIdle?.(key);
  }

  /** Note that a player asked for the film (see `lastActivity`). */
  noteActivity(): void {
    this.lastActivity = Date.now();
  }

  /** Check that ffmpeg exists and the cache directory is usable. */
  async start(): Promise<{ ok: boolean; detail: string }> {
    // One viewer: a package nobody has asked for in five minutes is deleted, workers and all.
    if (!this.reaper) this.reaper = setInterval(() => this.sweepIdle(), SWEEP_MS).unref();
    // Always probed: whether a file is packaged is the install's choice, so any install this
    // deployment serves may need this engine, and a broken ffmpeg has to be visible at boot
    // rather than discovered by the first person who plays a `.mkv`.
    try {
      await mkdir(this.root(), { recursive: true });
    } catch (error) {
      this.available = false;
      return { ok: false, detail: `cache dir unusable: ${errorText(error)}` };
    }
    // A process killed mid-generation leaves a package with no end marker, and a
    // package from an older version of this service leaves `.parts-*` behind.
    // At boot nothing is using the cache, so this is the moment to clear them.
    try {
      for (const name of await readdir(this.settings.cacheDir)) {
        if (!name.startsWith(".parts-")) continue;
        await rm(path.join(this.settings.cacheDir, name), { recursive: true, force: true });
      }
      for (const name of await readdir(this.root())) {
        const dir = path.join(this.root(), name);
        try {
          await stat(path.join(dir, DONE));
        } catch {
          await rm(dir, { recursive: true, force: true });
        }
      }
    } catch {
      // Not fatal: the worst case is a stale package that the next play replaces.
    }
    // A directory can exist and still not be writable (a volume owned by root, a
    // read-only mount). Generating would then fail on the first write, long after
    // boot, so it is checked here where /health can report it.
    const writable = path.join(this.settings.cacheDir, ".write-probe");
    try {
      await writeFile(writable, "ok");
      await rm(writable, { force: true });
    } catch (error) {
      this.available = false;
      return {
        ok: false,
        detail: `cache dir is not writable: ${this.settings.cacheDir} (${errorText(error)})`,
      };
    }

    const probe = await run(this.settings.ffmpegPath, ["-version"], 10_000, this.signal);
    this.available = probe.code === 0;
    if (!this.available) {
      return {
        ok: false,
        detail: `${this.settings.ffmpegPath} not runnable: ${probe.stderr.trim().slice(0, 200)}`,
      };
    }

    // The processing card needs a font and the badge as well as ffmpeg; a deployment
    // without them still works, it just shows nothing while a file is being packaged.
    if (this.settings.splash) {
      const card = await splashAvailable(this.settings);
      this.cardOk = card.ok;
      if (!card.ok) console.warn(`  warning        ${card.detail}`);
    } else {
      this.cardOk = false;
    }
    return {
      ok: true,
      detail: `${(probe.stdout.split("\n")[0] ?? "ffmpeg").trim()} -> ${this.settings.cacheDir}`,
    };
  }

  get enabled(): boolean {
    // What an install asked for is decided per request (see `handleProgressive`); this is only
    // "can this host package a file at all".
    return this.available !== false;
  }

  /**
   * Stable identity for one source + one set of windows.
   *
   * `streamIdentity` (from the stream list) wins when it is known: a debrid URL
   * carries a token that is re-minted on every request, so keying on it would miss
   * the package that was already made. The URL path is the fallback for a stream
   * that arrived without one.
   */
  keyFor(
    sourceUrl: string,
    windows: readonly SkipWindow[],
    streamIdentity?: string | null,
    audioLanguage?: string,
  ): string {
    let identity = sourceUrl;
    if (streamIdentity) {
      identity = `stream:${streamIdentity}`;
    } else {
      try {
        const url = new URL(sourceUrl);
        // Query strings are usually rotating debrid tokens: key on the path only.
        identity = `${url.origin}${url.pathname}`;
      } catch {
        // Keep the raw string when it is not a URL.
      }
    }
    const shape = windows
      .map((window) => `${window.type}:${window.startMs}:${window.endMs ?? "end"}`)
      .join(",");
    // The audio the package keeps is part of what the package is: an install that asked for English
    // must not be handed the package made for one that asked for Spanish. A deployment with no
    // preference keeps the keys it had.
    const preference = (audioLanguage ?? "").trim().toLowerCase();
    const audio = preference ? `|a:${preference}` : "";
    return createHash("sha1").update(`${identity}|${shape}${audio}`).digest("hex").slice(0, 20);
  }

  /** Queue generation unless it is already queued, running or done. */
  schedule(
    sourceUrl: string,
    windows: readonly SkipWindow[],
    streamIdentity?: string | null,
    durationMs?: number | null,
    audioLanguage?: string,
  ): PackageState {
    const key = this.keyFor(sourceUrl, windows, streamIdentity, audioLanguage);
    const existing = this.states.get(key);
    if (existing && existing.status !== "failed") return existing;

    const state: PackageState = {
      key,
      status: "queued",
      dir: this.dirFor(key),
      passes: 0,
      segments: 0,
      bytes: 0,
    };
    this.states.set(key, state);
    const task = this.enqueue(() =>
      this.perform(state, sourceUrl, windows, durationMs ?? null, audioLanguage),
    );
    this.running.set(key, task);
    void task.finally(() => this.running.delete(key));
    return state;
  }

  state(key: string): PackageState | null {
    return this.states.get(key) ?? null;
  }

  /**
   * Whether this key's film is fully packaged.
   *
   * Used to decide, once per playback, whether the processing card belongs at the front of it at
   * all -- a finished package needs no pre-roll.
   */
  async isComplete(key: string): Promise<boolean> {
    const plan = await this.readPlan(key);
    if (!plan) return false;
    if ((await this.realStretches(plan, key)).length === 0) return false;
    return this.isDone(key);
  }

  /**
   * A package left behind by a previous process, or by a pre-cut, and its status.
   * `null` when this key has never been generated.
   */
  async existing(key: string): Promise<PackageState | null> {
    const inMemory = this.states.get(key);
    if (inMemory) return inMemory;
    const plan = await this.readPlan(key);
    if (!plan) return null;
    const segments = await this.countSegments(plan);
    return {
      key,
      status: segments === 0 ? "queued" : (await this.isDone(key)) ? "ready" : "generating",
      dir: this.dirFor(key),
      passes: plan.ranges.length,
      segments,
      bytes: await this.dirBytes(this.dirFor(key)),
    };
  }

  /**
   * The episode's own segments, grouped by the stretch they came from, with durations.
   *
   * A stretch boundary is a jump in the clock and the playlist declares it, so the
   * grouping has to survive this far.
   */
  private async realStretches(
    plan: Plan,
    key: string,
  ): Promise<Array<{ segments: Array<{ name: string; ms: number }>; init: string | null }>> {
    const format = await this.formatFor(key);
    const stretches: Array<{ segments: Array<{ name: string; ms: number }>; init: string | null }> =
      [];
    for (let i = 0; i < plan.ranges.length; i++) {
      const range = plan.ranges[i];
      if (!range) continue;
      const rows = await this.passRows(key, i);
      const wanted = range.endMs - range.startMs;
      // ffmpeg stops at the keyframe after the requested end, so the last segment of a
      // stretch can hold a little of the dropped window. Whole segments that start past
      // the end are dropped; the remainder is left to the GOP.
      const kept = rows
        .filter((row) => row.startMs < wanted)
        .map((row) => ({ name: row.name, ms: Math.max(0, row.endMs - row.startMs) }));
      if (kept.length > 0) {
        const init = format.container === "mp4" ? (format.inits[i] ?? null) : null;
        stretches.push({ segments: kept, init });
      }
    }
    return stretches;
  }

  /**
   * The segments of one stretch, as far as they have been written.
   *
   * A TS pass keeps its own `-segment_list`, so its segments are known the moment each one closes.
   * An fMP4 pass cannot: the HLS muxer has no segment list, so its CSV used to be written from the
   * playlist only once the pass had *exited* -- which meant an HEVC episode reported nothing at all
   * until a whole stretch (the intro's position, a minute or more of video) had been copied, and a
   * play request was held for exactly that long. The muxer appends an entry as it closes each
   * segment, so that playlist is readable while the pass runs; what is not trusted while it runs is
   * its last entry, because that one may still be being written -- a player handed a half-written
   * segment has a stream that stops.
   */
  private async passRows(
    key: string,
    index: number,
  ): Promise<Array<{ name: string; startMs: number; endMs: number }>> {
    const written = await this.readCsv(path.join(this.dirFor(key), `${PASS}${index}.csv`));
    if (written.length > 0) return written;
    if (this.inFlight.get(key) !== index) return [];
    const live = await this.rowsFromPlaylist(path.join(this.dirFor(key), PERPASS));
    return live.length > 1 ? live.slice(0, -1) : [];
  }

  /**
   * The playlist for this key, or null when there is nothing to play at all.
   *
   * Everything comes off disk, so a package made by an earlier process plays too. Only
   * segments that ffmpeg has reported as closed are listed: a player asking for a segment
   * that is still being written would fail, and the CSV is the signal that says which ones
   * are whole. When this key is showing the processing card, its pieces come first.
   */
  async manifest(key: string): Promise<ManifestView | null> {
    const plan = await this.readPlan(key);
    if (!plan) return null;
    this.used.set(key, Date.now());
    const card = await this.readSplashList(key);
    const stretches = await this.realStretches(plan, key);
    this.lastCodecs = (await this.sourceInfo(key))?.codecs ?? this.lastCodecs;
    if (card.length === 0 && stretches.length === 0) return null;
    // A job that stopped will not write another segment, and a playlist that keeps offering the
    // card over it is the "Processing…" screen that never ends. A null here makes the caller hand
    // the player the source untouched, which is something to watch instead of nothing.
    if (card.length > 0 && stretches.length === 0 && this.states.get(key)?.status === "failed") {
      return null;
    }

    // The card is the film's pre-roll, and it stays one. Its length is the wait the first playback
    // actually had, so the film's position on the timeline is fixed from then on -- a viewer can
    // seek back to zero and find it, and a resume lands where the film's own clock says it should.
    // Once the film can play the pieces are replaced, in place, by one card of the same total length
    // that says what happened instead of "Processing…".
    const segments = stretches.reduce((total, stretch) => total + stretch.segments.length, 0);
    const realMs = stretches.reduce(
      (total, stretch) => total + stretch.segments.reduce((sum, entry) => sum + entry.ms, 0),
      0,
    );
    const doneAt = segments > 0 ? await this.doneAt(key) : null;
    const complete = doneAt !== null;
    const cardMs = card.reduce((total, entry) => total + entry.ms, 0);
    // An fMP4 package has no card: the card is a TS piece, and mixing containers inside one
    // playlist is exactly the kind of thing players disagree about.
    const fmp4 = stretches.some((stretch) => stretch.init !== null);
    // Playback starts when the pre-roll is there. Until then the film is not listed at all -- the
    // card is, and its cushion -- so a player cannot reach a film that has only a segment or two
    // behind it and stall there waiting for the rest.
    const playable = complete || realMs >= Math.max(1, this.settings.prerollSeconds * 1000);
    let shown = fmp4 || card.length === 0 ? [] : card;
    if (shown.length > 0 && playable) {
      this.replaceCard(key, card, plan);
      // Listed only once it exists: the processing pieces and the finished card are the same length,
      // so swapping them moves nothing, and a card that is still being drawn must not be a 404.
      if (await this.doneCardReady(key)) shown = [{ name: DONE_NAME, ms: cardMs }];
    }

    const items: Array<{ uri: string; ms: number } | { map: string } | "disc"> = [];
    const add = (group: Array<{ name: string; ms: number }>, init: string | null = null): void => {
      if (group.length === 0) return;
      // Between stretches -- and between the card and the episode -- the clock restarts,
      // which is what the tag declares.
      if (items.length > 0) items.push("disc");
      // An fMP4 stretch begins with its initialisation section, which a player needs before it
      // can read a single sample.
      if (init) items.push({ map: `seg?f=${encodeURIComponent(key)}/${init}` });
      for (const entry of group) {
        items.push({ uri: `seg?f=${encodeURIComponent(key)}/${entry.name}`, ms: entry.ms });
      }
    };
    add(shown);
    if (playable) for (const stretch of stretches) add(stretch.segments, stretch.init);

    // A short cushion of placeholder past the film while it is still being packaged -- never the
    // rest of the episode (see `PAD_HORIZON_MS`).
    const padding = complete
      ? { entries: [], init: null }
      : await this.paddingEntries(plan, key, realMs);
    if (padding.entries.length > 0) {
      // The placeholder is its own stream (its own initialisation section, when it has one), so it
      // starts at a discontinuity the way a stretch does.
      if (items.length > 0) items.push("disc");
      if (padding.init) items.push({ map: `seg?f=${encodeURIComponent(key)}/${padding.init}` });
      for (const entry of padding.entries) items.push(entry);
    }
    return this.playlistView(items, {
      complete,
      segments,
      card: shown.length,
      padding: padding.entries.length,
      expectedMs: await this.episodeMs(plan),
      bufferedMs: realMs,
      cardMs: shown.length > 0 ? cardMs : 0,
    });
  }

  /**
   * A playlist for a request from the *file* path: the card, drawn up to date, or the
   * episode once it can play.
   *
   * This is what a cold play gets instead of waiting. It is also what starts a card: a card
   * only ever exists for a key whose package this path asked for, so a playlist source never
   * gets one.
   */
  async splashView(
    key: string,
    windows: readonly SkipWindow[] = [],
    subtitles = false,
  ): Promise<ManifestView | null> {
    if (!this.settings.splash || this.cardOk === false) return null;
    // A job that has already stopped will not fill the playlist behind the card: drawing one for
    // it is the "Processing…" screen that never ends.
    if (this.states.get(key)?.status === "failed") return null;
    // The plan is written by the job that just started, so it may not be on disk yet: the
    // caller passes the windows it is about to cut, and the plan only adds detail. Without
    // either, nothing is being packaged for this key and there is no card to show.
    if (!(await this.readPlan(key)) && windows.length === 0) return null;
    // `lastAt` starts at the moment the card is created, and the first piece is drawn at
    // once (see `drawCardPiece`): a card whose pieces were zero and whose clock was epoch was
    // swept away by the idle check before it could draw anything.
    this.cards.set(key, this.cards.get(key) ?? { pieces: 0, lastAt: Date.now(), frozen: false });
    await this.drawCardPiece(key, windows, subtitles);
    return this.manifest(key);
  }

  /**
   * Leave a drawn card alone; only a key that has none is given one.
   *
   * A card's length is part of the playlist's timeline, so it is drawn once and never grows.
   */
  async advanceCard(key: string): Promise<ManifestView | null> {
    if (!this.cards.has(key)) return null;
    await this.drawCardPiece(key, []);
    return this.manifest(key);
  }

  /**
   * Draw the card, once, exactly as long as the pre-roll buffer.
   *
   * One piece rather than one per poll, and a fixed length rather than "until the episode can
   * play": the player spends the same ten seconds on the card however fast the source is, so the
   * episode always starts at the same point in the playlist. That constant is what lets the
   * subtitle track generated for the cut video be shifted by the card's length and stay aligned
   * -- with pieces drawn as the race went, the episode's start time varied by several seconds.
   */
  private async drawCardPiece(
    key: string,
    windows: readonly SkipWindow[],
    subtitles = false,
  ): Promise<void> {
    if (this.cardOk === false) return;
    const state = this.cards.get(key);
    if (!state) return;
    if ((await this.formatFor(key)).container === "mp4") return;
    if (state.frozen) return;
    if (state.pieces >= CARD_MAX_PIECES) return;
    this.used.set(key, Date.now());
    this.sweepCards();

    // One piece per poll, so the card grows with the wait: the prefix a player sees is exactly as
    // long as it took for the film to be ready, which is what keeps its playhead where the film's
    // own clock says it should be. A short, bounded piece rather than one since the wait is not
    // known in advance -- and it is the drawing, not the copy, that has to stay out of the way.
    const plan = await this.readPlan(key);
    if (!plan) return;
    const shown = plan.windows?.length ? plan.windows : windows;
    const passes = plan.ranges.length || 1;
    const stretches = await this.realStretches(plan, key);
    const written = stretches.reduce((total, stretch) => total + stretch.segments.length, 0);
    const piece = await generateCardPiece(
      this.settings,
      this.dirFor(key),
      {
        name: `splash${String(state.pieces).padStart(5, "0")}.ts`,
        offsetMs: state.pieces * SPLASH_PIECE_MS,
        seconds: SPLASH_PIECE_MS / 1000,
        audio: await this.placeholderAudioFor(key),
      },
      {
        segments: written,
        windows: shown,
        pass: Math.min(passes, stretches.length + 1),
        passes,
        subtitles,
        notice: this.notice?.() ?? null,
      },
    );
    if (piece.ok) {
      await this.appendSplashList(key, piece.name, SPLASH_PIECE_MS);
      state.pieces += 1;
      state.lastAt = Date.now();
      this.cardError = null;
      return;
    }
    // Cannot draw it here: stop trying, let the caller do what it used to, and keep the
    // reason where /health can report it.
    state.frozen = true;
    this.cardError = piece.error;
    console.warn(`  warning        the processing card cannot be drawn: ${piece.error}`);
  }

  /**
   * Replace the processing pieces with one card of the same length that says what went.
   *
   * Drawn in the background: the playlist this answer contains is still the processing pieces, which
   * are the same total length, so nothing moves -- the next poll has the finished card, and a viewer
   * who seeks back to zero (now or a week later) finds it. `waitMs` is the length of the pieces, and
   * that is exactly the pre-roll the first playback sat through, so the card can say where the film
   * begins.
   */
  private replaceCard(key: string, pieces: Array<{ ms: number }>, plan: Plan): void {
    // Frozen before anything is awaited: a poll that arrives while the audio codec is being read must
    // not draw another processing piece into a card that is finished.
    const state = this.cards.get(key);
    if (state) state.frozen = true;
    if (this.finishings.has(key)) return;
    const totalMs = pieces.reduce((sum, piece) => sum + piece.ms, 0);
    if (totalMs <= 0) return;
    const task = (async () => {
      const piece = await generateCardPiece(
        this.settings,
        this.dirFor(key),
        {
          name: DONE_NAME,
          offsetMs: 0,
          seconds: totalMs / 1000,
          audio: await this.placeholderAudioFor(key),
        },
        {
          segments: 0,
          windows: plan.windows ?? [],
          pass: 1,
          passes: plan.ranges.length || 1,
          state: "done",
          waitMs: totalMs,
          // The done card is drawn later than the processing pieces, so it may carry a fresher answer.
          notice: this.notice?.() ?? null,
        },
      );
      if (piece.ok) return;
      this.cardError = piece.error;
      console.warn(`  warning        the finished card cannot be drawn: ${piece.error}`);
    })()
      .catch(() => undefined)
      .finally(() => this.finishings.delete(key));
    this.finishings.set(key, task);
  }

  /**
   * The audio codec a placeholder has to carry for this package (see `placeholderAudio`).
   *
   * A card or cushion with silent AAC in front of an E-AC-3 film is a player that builds its audio
   * buffer for AAC and then refuses the film's sound: the picture plays and there is no audio.
   */
  private async placeholderAudioFor(key: string): Promise<string> {
    const info = await this.sourceInfo(key);
    return placeholderAudio(chooseAudio(info?.audio, "", "en"));
  }

  /** Whether this key's finished card is on disk yet (see `replaceCard`). */
  private async doneCardReady(key: string): Promise<boolean> {
    try {
      return (await stat(path.join(this.dirFor(key), DONE_NAME))).size > 0;
    } catch {
      return false;
    }
  }

  /** Stop the card for a key that is finished, and forget cards nobody is watching. */
  private sweepCards(): void {
    const idle = Date.now() - SPLASH_SESSION_MS;
    for (const [key, state] of this.cards) {
      if (state.lastAt < idle) this.cards.delete(key);
    }
  }

  /** The playlist itself: headers, the entries, and an end marker when it is finished. */
  private playlistView(
    items: Array<{ uri: string; ms: number } | { map: string } | "disc">,
    facts: {
      complete: boolean;
      segments: number;
      card: number;
      padding: number;
      expectedMs: number | null;
      bufferedMs: number;
      cardMs: number;
    },
  ): ManifestView {
    const lines: string[] = [];
    let durationMs = 0;
    let longestMs = 0;
    for (const item of items) {
      if (item === "disc") {
        lines.push("#EXT-X-DISCONTINUITY");
        continue;
      }
      if ("map" in item) {
        lines.push(`#EXT-X-MAP:URI="${item.map}"`);
        continue;
      }
      lines.push(`#EXTINF:${(item.ms / 1000).toFixed(3)},`);
      lines.push(item.uri);
      durationMs += item.ms;
      longestMs = Math.max(longestMs, item.ms);
    }
    const head = [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(longestMs / 1000))}`,
      "#EXT-X-MEDIA-SEQUENCE:0",
      "#EXT-X-DISCONTINUITY-SEQUENCE:0",
      // EVENT while it grows: the player keeps re-reading the playlist, which is how it
      // learns about the segments written after it started.
      // An incomplete playlist is an EVENT one, which players treat as live and join at the end
      // of -- twenty minutes in, when the rest of the episode is still padding. This is where
      // playback starts instead.
      "#EXT-X-START:TIME-OFFSET=0",
      `#EXT-X-PLAYLIST-TYPE:${facts.complete ? "VOD" : "EVENT"}`,
    ];
    const tail = facts.complete ? ["#EXT-X-ENDLIST"] : [];
    return {
      body: `${[...head, ...lines, ...tail].join("\n")}\n`,
      complete: facts.complete,
      segments: facts.segments,
      card: facts.card,
      padding: facts.padding,
      expectedMs: facts.expectedMs,
      bufferedMs: facts.bufferedMs,
      cardMs: facts.cardMs,
      durationMs: Math.round(durationMs),
    };
  }

  /**
   * The episode's own length: the source minus the windows being cut.
   *
   * Null when the source's length was never probed, in which case nothing can be padded and the
   * playlist grows as it did before. It is the cap on the placeholder's tail, not the length the
   * playlist declares (see `PAD_HORIZON_MS`).
   */
  private async episodeMs(plan: Plan): Promise<number | null> {
    const duration = await this.readDuration(plan.key);
    if (duration === null) return null;
    const ranges = keptRanges(plan.windows ?? [], duration);
    return ranges.reduce(
      (total, range) => total + (Math.min(range.endMs, duration) - range.startMs),
      0,
    );
  }

  /**
   * Placeholder entries standing in for the part of the episode that has not been packaged.
   *
   * They point at pieces of the card (or a plain black piece when no card can be drawn), so a
   * player that reaches them sees "Processing…" rather than a stall, and the declared length is
   * the episode's from the first response.
   */
  private async paddingEntries(
    plan: Plan,
    key: string,
    realMs: number,
  ): Promise<{ entries: Array<{ uri: string; ms: number }>; init: string | null }> {
    const expected = await this.episodeMs(plan);
    if (expected === null) return { entries: [], init: null };
    const remaining = expected - realMs;
    if (remaining <= PAD_ENTRY_MS / 2) return { entries: [], init: null };
    const media = await this.paddingMedia(key);
    if (media.pieces.length === 0) return { entries: [], init: null };
    // A cushion past the write head, not the rest of the episode (see `PAD_HORIZON_MS`): what the
    // player reloads into has to be near where it is, and the end of the playlist is where a live
    // player starts. The pieces are tiled at their own lengths, so a two-second card piece is
    // declared as two seconds rather than stretched to the black piece's six.
    const span = Math.min(remaining, PAD_HORIZON_MS);
    const entries: Array<{ uri: string; ms: number }> = [];
    let filled = 0;
    for (let i = 0; filled < span - 1; i += 1) {
      const piece = media.pieces[i % media.pieces.length]!;
      const ms = Math.min(piece.ms, span - filled);
      if (ms <= 0) break;
      entries.push({ uri: `seg?f=${encodeURIComponent(key)}/${piece.name}`, ms });
      filled += ms;
    }
    return { entries, init: media.init };
  }

  /**
   * What the placeholder points at: the card itself while the film is still being cut, and a plain
   * black piece once it can play.
   *
   * While a viewer is waiting, the tail is where a player that has run out of packaged film ends up
   * -- so it says what is happening rather than showing them nothing. The *finished* card is never
   * here: it says where the film starts, which is meaningless at the live edge of a growing
   * playlist. Both are in the package's own container and codec, because a TS piece (or an AVC one)
   * inside an fMP4 HEVC playlist is a demux error, so the player stops exactly where the placeholder
   * was supposed to keep it waiting.
   */
  private async paddingMedia(
    key: string,
  ): Promise<{ init: string | null; pieces: Array<{ name: string; ms: number }> }> {
    const format = await this.formatFor(key);
    if (format.container === "ts") {
      const card = await this.readSplashList(key);
      const state = this.cards.get(key);
      if (card.length > 0 && state && !state.frozen) {
        return { init: null, pieces: card.slice(-3) };
      }
    }
    const info = await this.sourceInfo(key);
    const fallback = await generatePadPiece(
      this.settings,
      this.dirFor(key),
      format.container,
      info?.video,
      placeholderAudio(chooseAudio(info?.audio, "", "en")),
    );
    return fallback
      ? { init: fallback.init, pieces: [{ name: fallback.name, ms: PAD_SECONDS * 1000 }] }
      : { init: null, pieces: [] };
  }

  /** The pieces of the card drawn for this key, oldest first. */
  private async readSplashList(key: string): Promise<Array<{ name: string; ms: number }>> {
    try {
      const text = await readFile(path.join(this.dirFor(key), SPLASH_LIST), "utf8");
      const entries: Array<{ name: string; ms: number }> = [];
      for (const line of text.split("\n")) {
        const [name, ms] = line.trim().split(" ");
        if (!name || !SPLASH_RE.test(name)) continue;
        const duration = Number(ms);
        entries.push({ name, ms: Number.isFinite(duration) ? duration : SPLASH_PIECE_MS });
      }
      return entries;
    } catch {
      return [];
    }
  }

  private async appendSplashList(key: string, name: string, ms: number): Promise<void> {
    await appendFile(path.join(this.dirFor(key), SPLASH_LIST), `${name} ${ms}\n`);
  }

  /**
   * Wait for `prerollMs` of the episode, up to `timeoutMs`.
   *
   * This is what makes a playback start on the film rather than on the card: the moment enough of
   * it is on disk to play, the player is handed it from its first frame. The wait is bounded by the
   * caller because the card is the fallback -- a source that cannot produce this much quickly is
   * exactly the one the card exists for.
   */
  async waitForPreroll(
    key: string,
    prerollMs: number,
    timeoutMs: number,
  ): Promise<ManifestView | null> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      const view = await this.manifest(key);
      // One segment of the film, at least: a card-only playlist is exactly what this is waiting to
      // replace, however small the pre-roll is.
      if (view && view.bufferedMs >= Math.max(1, prerollMs)) return view;
      if (this.states.get(key)?.status === "failed") return null;
      if (Date.now() >= deadline) return null;
      if (!this.running.has(key) && !(await this.existing(key))) return null;
      await delay(POLL_MS);
    }
  }

  /**
   * Wait for the first usable segment, up to `timeoutMs`.
   *
   * This is the whole answer to "players give up while it downloads": the wait is
   * one segment long, not one file long.
   */
  async waitForFirstSegment(key: string, timeoutMs: number): Promise<ManifestView | null> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      const view = await this.manifest(key);
      // A playlist with none of the film in it is not the answer. Since the pre-roll gate the card is
      // served until `PREROLL_SECONDS` of the cut film exists, and this is asked for the first thing a
      // player may *play* -- returning the card here hands the caller the very playlist that says
      // "not yet", and a caller that treats it as film would serve an empty episode.
      if (view && view.segments > 0) return view;
      if (this.states.get(key)?.status === "failed") return null;
      if (Date.now() >= deadline) return null;
      // Nothing scheduled and nothing on disk: no point in waiting.
      if (!this.running.has(key) && !(await this.existing(key))) return null;
      await delay(POLL_MS);
    }
  }

  /**
   * How long the card is in this key's playlist, in milliseconds.
   *
   * The card is the stem of the presentation -- the episode starts after it -- and its length is the
   * wait the first playback actually had: each piece is two seconds of the card, drawn while the
   * film was being readied, so the sum is how long that took (rounded up to a piece). Fixed once the
   * film can play, which is what makes the film's position on the timeline stable -- and it is the
   * offset a subtitle rendition has to carry.
   */
  async cardMs(key: string): Promise<number> {
    const pieces = await this.readSplashList(key);
    if (pieces.length === 0) return 0;
    return pieces.reduce(
      (total, piece) => total + (Number.isFinite(piece.ms) ? piece.ms : SPLASH_PIECE_MS),
      0,
    );
  }

  /**
   * Learn and remember the source's own length.
   *
   * The playlist has to declare the whole episode from its first response, or a player that
   * reaches the end of what has been packaged decides the episode is over -- Stremio marks it
   * watched and jumps to the next one. One `ffprobe` per key, paid by the playback that starts
   * the packaging rather than by every poll.
   */
  async rememberDuration(key: string, target: string): Promise<number | null> {
    const cached = await this.sourceInfo(key);
    // A package probed before the audio tracks were recorded is probed again, not trusted: without
    // that list the recogniser falls back to ffmpeg's own stream choice (which is what made a
    // dubbed file produce an empty track), and the subtitle key it derives would not match the job
    // that was made with one. The probe is one ffprobe, paid once, and only for old entries.
    // A package probed before the source's own subtitle tracks were recorded is probed again:
    // otherwise a cached title never offers them, and the viewer gets a generated track (or none)
    // for a release that had a perfectly good one all along.
    if (cached && Array.isArray(cached.audio) && Array.isArray(cached.subtitles)) {
      return cached.durationMs;
    }
    if (!KEY_RE.test(key)) return cached?.durationMs ?? null;
    const probe = await run(
      this.settings.ffprobePath,
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration,bit_rate:stream=index,codec_type,codec_name,profile,level,width,height" +
          ":stream_tags=language:stream_disposition=default",
        "-of",
        "json",
        target,
      ],
      30_000,
      this.signal,
    );
    const info = probe.code === 0 ? parseProbe(probe.stdout) : null;
    if (!info) return null;
    const ms = info.durationMs;
    try {
      await mkdir(this.dirFor(key), { recursive: true });
      await writeFile(path.join(this.dirFor(key), DURATION), JSON.stringify(info));
    } catch {
      // Not fatal: without it the playlist cannot pad, and the caller still gets to play.
    }
    return ms;
  }

  private async readDuration(key: string): Promise<number | null> {
    const info = await this.sourceInfo(key);
    return info ? info.durationMs : null;
  }

  /** What the probe learned about this source: its length, and what a master needs to say. */
  async sourceInfo(key: string): Promise<StreamInfo | null> {
    try {
      const parsed = JSON.parse(await readFile(path.join(this.dirFor(key), DURATION), "utf8")) as
        | StreamInfo
        | { ms?: number };
      const legacy = parsed as { ms?: number };
      if (typeof legacy.ms === "number" && legacy.ms > 0 && !("durationMs" in parsed)) {
        // A package probed before the stream was recorded: the length is enough to play.
        return { durationMs: legacy.ms, bitrate: 0, width: 0, height: 0, codecs: "" };
      }
      const info = parsed as StreamInfo;
      return typeof info.durationMs === "number" && info.durationMs > 0 ? info : null;
    } catch {
      return null;
    }
  }

  /** A path inside this key's package, or null when the name is not one of ours. */
  segmentPath(key: string, name: string): string | null {
    if (
      !KEY_RE.test(key) ||
      !(
        SEGMENT_RE.test(name) ||
        SPLASH_RE.test(name) ||
        DONE_RE.test(name) ||
        PAD_RE.test(name) ||
        INIT_RE.test(name)
      )
    ) {
      return null;
    }
    this.used.set(key, Date.now());
    return path.join(this.dirFor(key), name);
  }

  stats(): Record<string, unknown> {
    const byStatus: Record<string, number> = {};
    let segments = 0;
    let bytes = 0;
    let lastError: { key: string; error: string } | null = null;
    for (const state of this.states.values()) {
      byStatus[state.status] = (byStatus[state.status] ?? 0) + 1;
      segments += state.segments;
      bytes += state.bytes;
      if (state.error) lastError = { key: state.key, error: state.error.slice(0, 300) };
    }
    return {
      proxy: this.settings.proxy,
      skipMarginSeconds: this.settings.skipMarginSeconds,
      available: this.available,
      cacheDir: this.settings.cacheDir,
      cacheMaxGb: Math.round(this.settings.cacheMaxBytes / 1024 ** 3),
      cutConcurrency: this.settings.cutConcurrency,
      active: this.active,
      queued: this.tasks.length,
      packages: byStatus,
      segments,
      cardPieces: [...this.cards.values()].reduce((total, state) => total + state.pieces, 0),
      splash: this.settings.splash && this.cardOk !== false,
      splashError: this.cardError,
      // What the segments hold, e.g. `hvc1.2.4.L153.B0,ec-3`. A player that cannot demux this
      // shows a black picture with the audio playing, and nothing else in the playlist says so.
      codecs: this.lastCodecs,
      bytes,
      // Only the newest one: this is what an operator needs to see, and /health
      // stays small.
      lastError,
    };
  }

  private root(): string {
    return path.join(this.settings.cacheDir, PACKAGE_ROOT);
  }

  private dirFor(key: string): string {
    return path.join(this.root(), key);
  }

  private async isDone(key: string): Promise<boolean> {
    return (await this.doneAt(key)) !== null;
  }

  /** When this key's film was finished, or null if it is still being made. */
  private async doneAt(key: string): Promise<number | null> {
    try {
      return (await stat(path.join(this.dirFor(key), DONE))).mtimeMs;
    } catch {
      return null;
    }
  }

  private async readPlan(key: string): Promise<Plan | null> {
    if (!KEY_RE.test(key)) return null;
    try {
      const parsed = JSON.parse(await readFile(path.join(this.dirFor(key), PLAN), "utf8")) as Plan;
      if (!Array.isArray(parsed.ranges) || parsed.ranges.length === 0) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * One finished segment per line, as ffmpeg's segment muxer reports them:
   * `name,start,end`, seconds relative to the start of that stretch. A line that is
   * still being flushed is ignored rather than guessed at.
   */
  /**
   * Decide, once, what container this key's segments go in, and record it.
   *
   * HEVC in MPEG-TS is unreadable to hls.js -- the whole browser world -- while fMP4 hands the
   * samples to a platform that can decode them. Everything else keeps TS, which is what every
   * player already reads and what this service has been producing all along.
   */
  /** Whether this key's segments are fMP4, and what starts each pass. */
  async formatFor(key: string): Promise<PackageFormat> {
    try {
      const parsed = JSON.parse(
        await readFile(path.join(this.dirFor(key), FORMAT), "utf8"),
      ) as PackageFormat;
      if (parsed.container === "mp4" && Array.isArray(parsed.inits)) return parsed;
      return { container: "ts", inits: [] };
    } catch {
      // Not recorded yet: decide now, from what the probe already knows. This is asked before the
      // processing card is drawn as well as before packaging, and the two must agree -- a card
      // written into an fMP4 playlist is one container inside another.
      const info = await this.sourceInfo(key);
      // The codec string is the better signal but it is not always spellable (an unfamiliar HEVC
      // profile leaves it empty), and a HEVC package written as TS is a black picture in every
      // browser. The name ffprobe reported is the fallback.
      const hevc = info?.video === "hevc" || (info?.codecs ?? "").startsWith("hvc1");
      if (!hevc) return { container: "ts", inits: [] };
      const plan = await this.readPlan(key);
      const chosen: PackageFormat = {
        container: "mp4",
        inits: (plan?.ranges ?? []).map((_, index) => `init-${index}.mp4`),
      };
      await mkdir(this.dirFor(key), { recursive: true }).catch(() => undefined);
      await writeFile(path.join(this.dirFor(key), FORMAT), JSON.stringify(chosen)).catch(
        () => undefined,
      );
      return chosen;
    }
  }

  /**
   * The segments a pass's HLS playlist lists, in milliseconds from the start of that stretch.
   *
   * Used for both jobs this playlist has: the record written once a pass has exited, and the live
   * reading of a pass that is still running (see `passRows`).
   */
  private async rowsFromPlaylist(
    file: string,
  ): Promise<Array<{ name: string; startMs: number; endMs: number }>> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      return [];
    }
    const lines = text.split("\n").map((line) => line.trim());
    const rows: Array<{ name: string; startMs: number; endMs: number }> = [];
    let at = 0;
    for (let i = 0; i < lines.length; i++) {
      const span = /^#EXTINF:([0-9.]+),/.exec(lines[i] ?? "");
      if (!span) continue;
      const name = lines[i + 1];
      if (!name || name.startsWith("#") || !SEGMENT_RE.test(name)) continue;
      const seconds = Number(span[1]);
      if (!Number.isFinite(seconds)) continue;
      rows.push({ name, startMs: at * 1000, endMs: (at + seconds) * 1000 });
      at += seconds;
    }
    return rows;
  }

  /** Write the segment list the fMP4 pass did not, from the playlist ffmpeg left behind. */
  private async writeCsvFromPlaylist(playlist: string, csv: string): Promise<void> {
    const rows = await this.rowsFromPlaylist(playlist);
    if (rows.length === 0) return;
    const lines = rows.map(
      (row) => `${row.name},${(row.startMs / 1000).toFixed(6)},${(row.endMs / 1000).toFixed(6)}`,
    );
    await writeFile(csv, `${lines.join("\n")}\n`);
  }

  private async readCsv(
    file: string,
  ): Promise<Array<{ name: string; startMs: number; endMs: number }>> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      return [];
    }
    const rows: Array<{ name: string; startMs: number; endMs: number }> = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const [name, start, end] = line.trim().split(",");
      if (!name || !SEGMENT_RE.test(name)) continue;
      const startMs = Number(start) * 1000;
      const endMs = Number(end) * 1000;
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
      rows.push({ name, startMs, endMs });
    }
    return rows;
  }

  private async countSegments(plan: Plan): Promise<number> {
    let count = 0;
    for (let i = 0; i < plan.ranges.length; i++) {
      count += (await this.readCsv(path.join(this.dirFor(plan.key), `${PASS}${i}.csv`))).length;
    }
    return count;
  }

  private async dirBytes(dir: string): Promise<number> {
    let total = 0;
    try {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) total += await this.dirBytes(full);
        else if (entry.isFile()) total += (await stat(full)).size;
      }
    } catch {
      // A package being replaced: report what we have.
    }
    return total;
  }

  private async perform(
    state: PackageState,
    sourceUrl: string,
    windows: readonly SkipWindow[],
    durationMs: number | null,
    audioLanguage?: string,
  ): Promise<PackageState> {
    const ranges = keptRanges(windows, durationMs);
    // One controller per package, on top of the engine's: a drain stops everything, and an idle sweep
    // stops one film without touching the others.
    const local = new AbortController();
    this.aborts.set(state.key, local);
    const signal = AbortSignal.any([this.signal, local.signal]);
    state.status = "generating";
    state.startedAt = Date.now();
    state.passes = ranges.length;
    try {
      await mkdir(state.dir, { recursive: true });
      const plan: Plan = { key: state.key, windows: [...windows], ranges, createdAt: Date.now() };
      await writeFile(path.join(state.dir, PLAN), JSON.stringify(plan));
    } catch (error) {
      state.status = "failed";
      state.error = `cannot write the package: ${errorText(error)}`;
      return state;
    }

    // HEVC cannot be demuxed out of MPEG-TS by hls.js -- which is every browser player -- so an
    // HEVC source is written as fMP4 instead. The decision is recorded beside the segments,
    // because a package made by an earlier process has to be read back the same way.
    const format = await this.formatFor(state.key);
    let recorded = 0;
    for (let i = 0; i < ranges.length; i++) {
      const range = ranges[i];
      if (!range) continue;
      const wanted = range.endMs - range.startMs;
      if (wanted < 500) continue;
      const csv = path.join(state.dir, `${PASS}${i}.csv`);
      const init = format.inits[i] ?? "";
      // The reader needs to know which stretch is the one ffmpeg is writing: that is the one whose
      // segments are only in the playlist so far (see `passRows`).
      this.inFlight.set(state.key, i);
      const result = await run(
        this.settings.ffmpegPath,
        format.container === "mp4"
          ? [
              "-nostdin",
              "-hide_banner",
              "-v",
              "error",
              "-y",
              ...inputOptions(),
              "-ss",
              seconds(range.startMs),
              "-i",
              sourceUrl,
              "-t",
              seconds(wanted),
              ...audioMap(await this.sourceInfo(state.key), audioLanguage ?? ""),
              // Only the picture and the sound. A source with an embedded WebVTT track is common,
              // and copying it makes the HLS muxer refuse the whole output ("Exactly one WebVTT
              // stream is needed"), which is a package that never gets made at all.
              "-sn",
              "-dn",
              "-c",
              "copy",
              // `hvc1` is the sample entry Apple's spec asks for and the one browsers accept.
              "-tag:v",
              "hvc1",
              "-avoid_negative_ts",
              "make_zero",
              "-f",
              "hls",
              "-hls_time",
              String(SEGMENT_SECONDS),
              "-hls_list_size",
              "0",
              "-hls_segment_type",
              "fmp4",
              "-hls_fmp4_init_filename",
              init,
              "-hls_segment_filename",
              path.join(state.dir, "seg%05d.m4s"),
              "-start_number",
              String(recorded),
              path.join(state.dir, "perpass.m3u8"),
            ]
          : [
              "-nostdin",
              "-hide_banner",
              "-v",
              "error",
              "-y",
              ...inputOptions(),
              "-ss",
              seconds(range.startMs),
              "-i",
              sourceUrl,
              "-t",
              seconds(wanted),
              ...audioMap(await this.sourceInfo(state.key), audioLanguage ?? ""),
              // See above: the segments carry the picture and the sound, nothing else.
              "-sn",
              "-dn",
              "-c",
              "copy",
              "-f",
              "segment",
              "-segment_time",
              String(SEGMENT_SECONDS),
              "-segment_format",
              "mpegts",
              // The timestamps must *run* across the segments of a stretch. Resetting
              // them per segment (`-reset_timestamps 1`) stamps every segment with the
              // same clock, so a player sees a ten-second item that restarts at every
              // segment: the bar loops, the duration is one segment long, and audio and
              // video — reset on different frame boundaries — drift apart.
              "-muxdelay",
              "0",
              "-muxpreload",
              "0",
              // Keep the first frame of a stretch at zero rather than negative: ffmpeg
              // starts a copy at the keyframe *before* the requested point.
              "-avoid_negative_ts",
              "make_zero",
              "-segment_list",
              csv,
              "-segment_list_type",
              "csv",
              "-segment_start_number",
              String(recorded),
              path.join(state.dir, "seg%05d.ts"),
            ],
        this.timeoutFor(wanted),
        signal,
      );
      // The fMP4 arm has no segment list of its own: the playlist ffmpeg wrote is the record, so
      // the same CSV is written from it and everything downstream reads one shape.
      if (format.container === "mp4" && result.code === 0) {
        await this.writeCsvFromPlaylist(path.join(state.dir, PERPASS), csv).catch(() => undefined);
      }
      this.inFlight.delete(state.key);
      const rows = await this.readCsv(csv);
      recorded += rows.length;
      state.segments = recorded;
      state.bytes = await this.dirBytes(state.dir);
      if (result.code !== 0) {
        // A stretch can fail on its own (a codec MPEG-TS cannot carry, a range past
        // the end of the file). Keep what the others produced and report this one.
        state.error = `${seconds(range.startMs)}s-${seconds(range.endMs)}s: ${result.stderr.trim().slice(-300)}`;
      }
    }

    if (recorded === 0) {
      state.status = "failed";
      state.error ??= "ffmpeg produced no usable segments";
      return state;
    }
    this.aborts.delete(state.key);
    // The end marker is what turns an EVENT playlist into a seekable one.
    await writeFile(path.join(state.dir, DONE), "").catch(() => undefined);
    state.status = "ready";
    state.finishedAt = Date.now();
    // The card has served its purpose: no more pieces, and the playlist it is already in
    // keeps the ones it has.
    const card = this.cards.get(state.key);
    if (card) card.frozen = true;
    await this.evict().catch(() => undefined);
    return state;
  }

  /** ffmpeg may only touch the keyframe after the requested end, so leave slack. */
  private timeoutFor(durationMs: number): number {
    return Math.min(Math.max(120_000, durationMs * 2 + 60_000), 30 * 60_000);
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.active += 1;
        work()
          .then(resolve, reject)
          .finally(() => {
            this.active -= 1;
            const next = this.tasks.shift();
            if (next) next();
          });
      };
      if (this.active < this.settings.cutConcurrency) start();
      else this.tasks.push(start);
    });
  }

  /** Delete the oldest packages until the cache fits its budget again. */
  private async evict(): Promise<void> {
    let entries: Array<{ name: string; size: number; used: number }>;
    try {
      entries = [];
      let total = 0;
      for (const entry of await readdir(this.root(), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(this.root(), entry.name);
        const size = await this.dirBytes(dir);
        total += size;
        let used = 0;
        try {
          used = (await stat(path.join(dir, PLAN))).mtimeMs;
        } catch {
          used = (await stat(dir)).mtimeMs;
        }
        entries.push({ name: entry.name, size, used });
      }
      if (total <= this.settings.cacheMaxBytes) return;
      entries.sort((a, b) => a.used - b.used);
      const quiet = Date.now() - Math.max(RECENT_MS, 60_000);
      for (const entry of entries) {
        if (total <= this.settings.cacheMaxBytes) return;
        // Never delete a package that is being written right now, and not one that was
        // served a moment ago either: a player mid-episode asks for its segments one at
        // a time, and deleting them under it is a playback failure.
        if (this.running.has(entry.name)) continue;
        if ((this.used.get(entry.name) ?? 0) > quiet) continue;
        try {
          await rm(path.join(this.root(), entry.name), { recursive: true, force: true });
          total -= entry.size;
        } catch {
          return;
        }
      }
    } catch {
      // Nothing to evict, or the cache is unreadable: both are survivable.
    }
  }
}

/** Seconds, as ffmpeg wants them: milliseconds lose meaning here anyway. */
function seconds(ms: number): string {
  return (ms / 1000).toFixed(3);
}
