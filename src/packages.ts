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
import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Settings } from "./env.js";
import {
  cardSeconds,
  generatePadPiece,
  generateSplashPiece,
  PAD_RE,
  PAD_SECONDS,
  SPLASH_PIECE_MS,
  SPLASH_RE,
  splashAvailable,
} from "./splash.js";
import {
  delay,
  errorText,
  inputOptions,
  keptRanges,
  run,
  type KeptRange,
} from "./ffmpeg.js";
import type { SkipWindow } from "./types.js";

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
 * the episode had arrived. One segment's worth keeps it behaving like any other playlist,
 * which is what it is: a two-hour episode is ~1200 entries whether or not some are placeholder.
 */
const PAD_ENTRY_MS = PAD_SECONDS * 1000;
/** A padded playlist is still a playlist; this bounds a pathological file length. */
const PAD_MAX_ENTRIES = 2000;
const PLAN = "plan.json";
const DONE = "done";
const PASS = "pass-";
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
const SEGMENT_RE = /^seg\d{5}\.ts$/;

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
  private readonly running = new Map<string, Promise<PackageState>>();
  private readonly tasks: Array<() => void> = [];
  private active = 0;
  private available: boolean | null = null;

  constructor(private readonly settings: Settings) {}

  /** Check that ffmpeg exists and the cache directory is usable. */
  async start(): Promise<{ ok: boolean; detail: string }> {
    // `hls` is not "cutting is off": playlists are still spliced, and the engine's own health is
    // about the packaging path. Reporting it unavailable made an HLS-only install look broken.
    const used = this.settings.cuts !== "hls";
    // Nothing is packaged in this mode, so there is no engine to check, no cache to clear and no
    // half-written package to sweep: say so and leave the disk alone.
    if (!used) return { ok: true, detail: "only HLS playlists are cut" };
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

    const probe = await run(this.settings.ffmpegPath, ["-version"], 10_000);
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
    return this.settings.cuts !== "hls" && this.available !== false;
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
    return createHash("sha1").update(`${identity}|${shape}`).digest("hex").slice(0, 20);
  }

  /** Queue generation unless it is already queued, running or done. */
  schedule(
    sourceUrl: string,
    windows: readonly SkipWindow[],
    streamIdentity?: string | null,
    durationMs?: number | null,
  ): PackageState {
    const key = this.keyFor(sourceUrl, windows, streamIdentity);
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
    const task = this.enqueue(() => this.perform(state, sourceUrl, windows, durationMs ?? null));
    this.running.set(key, task);
    void task.finally(() => this.running.delete(key));
    return state;
  }

  state(key: string): PackageState | null {
    return this.states.get(key) ?? null;
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
  ): Promise<Array<Array<{ name: string; ms: number }>>> {
    const dir = this.dirFor(key);
    const stretches: Array<Array<{ name: string; ms: number }>> = [];
    for (let i = 0; i < plan.ranges.length; i++) {
      const range = plan.ranges[i];
      if (!range) continue;
      const rows = await this.readCsv(path.join(dir, `${PASS}${i}.csv`));
      const wanted = range.endMs - range.startMs;
      // ffmpeg stops at the keyframe after the requested end, so the last segment of a
      // stretch can hold a little of the dropped window. Whole segments that start past
      // the end are dropped; the remainder is left to the GOP.
      const kept = rows
        .filter((row) => row.startMs < wanted)
        .map((row) => ({ name: row.name, ms: Math.max(0, row.endMs - row.startMs) }));
      if (kept.length > 0) stretches.push(kept);
    }
    return stretches;
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
    if (card.length === 0 && stretches.length === 0) return null;

    const items: Array<{ uri: string; ms: number } | "disc"> = [];
    const add = (group: Array<{ name: string; ms: number }>): void => {
      if (group.length === 0) return;
      // Between stretches -- and between the card and the episode -- the clock restarts,
      // which is what the tag declares.
      if (items.length > 0) items.push("disc");
      for (const entry of group) {
        items.push({ uri: `seg?f=${encodeURIComponent(key)}/${entry.name}`, ms: entry.ms });
      }
    };
    add(card);
    for (const stretch of stretches) add(stretch);

    const segments = stretches.reduce((total, stretch) => total + stretch.length, 0);
    const complete = segments > 0 && (await this.isDone(key));
    const realMs = stretches.reduce(
      (total, stretch) => total + stretch.reduce((sum, entry) => sum + entry.ms, 0),
      0,
    );
    // The placeholder keeps the declared length honest while the packaging is still running.
    const padding = complete ? [] : await this.paddingEntries(plan, key, realMs);
    for (const entry of padding) {
      if (items.length > 0 && !items.includes("disc")) items.push("disc");
      items.push(entry);
    }
    return this.playlistView(items, {
      complete,
      segments,
      card: card.length,
      padding: padding.length,
      expectedMs: await this.episodeMs(plan),
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
    if (state.pieces > 0) return;
    if (state.frozen) return;
    this.used.set(key, Date.now());
    this.sweepCards();

    const plan = await this.readPlan(key);
    const shown = plan?.windows?.length ? plan.windows : windows;
    const passes = plan?.ranges.length ?? 1;
    const stretches = plan ? await this.realStretches(plan, key) : [];
    const written = stretches.reduce((total, stretch) => total + stretch.length, 0);
    const piece = await generateSplashPiece(this.settings, this.dirFor(key), state.pieces, {
      segments: written,
      windows: shown,
      pass: Math.min(passes, stretches.length + 1),
      passes,
      subtitles,
    });
    if (piece.ok) {
      await this.appendSplashList(key, piece.name, cardSeconds(this.settings) * 1000);
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

  /** Stop the card for a key that is finished, and forget cards nobody is watching. */
  private sweepCards(): void {
    const idle = Date.now() - SPLASH_SESSION_MS;
    for (const [key, state] of this.cards) {
      if (state.lastAt < idle) this.cards.delete(key);
    }
  }

  /** The playlist itself: headers, the entries, and an end marker when it is finished. */
  private playlistView(
    items: Array<{ uri: string; ms: number } | "disc">,
    facts: {
      complete: boolean;
      segments: number;
      card: number;
      padding: number;
      expectedMs: number | null;
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
      durationMs: Math.round(durationMs),
    };
  }

  /**
   * The length the playlist should declare: the source minus the windows being cut.
   *
   * Null when the source's length was never probed, in which case nothing can be padded and
   * the playlist grows as it did before.
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
  ): Promise<Array<{ uri: string; ms: number }>> {
    const expected = await this.episodeMs(plan);
    if (expected === null) return [];
    const remaining = expected - realMs;
    if (remaining <= PAD_ENTRY_MS / 2) return [];
    const media = await this.paddingMedia(key);
    if (media.length === 0) return [];
    const count = Math.min(PAD_MAX_ENTRIES, Math.ceil(remaining / PAD_ENTRY_MS));
    const entries: Array<{ uri: string; ms: number }> = [];
    for (let i = 0; i < count; i += 1) {
      const ms = i === count - 1 ? remaining - PAD_ENTRY_MS * (count - 1) : PAD_ENTRY_MS;
      if (ms <= 0) continue;
      entries.push({ uri: `seg?f=${encodeURIComponent(key)}/${media[i % media.length]!}`, ms });
    }
    return entries;
  }

  /**
   * What the padding points at: the card's own pieces when it has drawn any, so a player that
   * outruns the packaging sees the card, otherwise one plain black piece.
   */
  private async paddingMedia(key: string): Promise<string[]> {
    const card = await this.readSplashList(key);
    if (card.length > 0) return card.slice(-8).map((entry) => entry.name);
    const fallback = await generatePadPiece(this.settings, this.dirFor(key));
    return fallback ? [fallback.name] : [];
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
   * Wait for the first usable segment, up to `timeoutMs`.
   *
   * This is the whole answer to "players give up while it downloads": the wait is
   * one segment long, not one file long.
   */
  async waitForFirstSegment(key: string, timeoutMs: number): Promise<ManifestView | null> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      const view = await this.manifest(key);
      if (view) return view;
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
   * The card is the stem of the presentation -- the episode starts after it -- so this is the
   * offset every subtitle generated for the cut video is shifted by. It is a constant for a
   * given deployment precisely because the card is drawn once and its length is the pre-roll.
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
    const known = await this.readDuration(key);
    if (known !== null) return known;
    if (!KEY_RE.test(key)) return null;
    const probe = await run(
      this.settings.ffprobePath,
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", target],
      30_000,
    );
    const seconds = Number(probe.stdout.trim());
    if (probe.code !== 0 || !Number.isFinite(seconds) || seconds <= 0) return null;
    const ms = Math.round(seconds * 1000);
    try {
      await mkdir(this.dirFor(key), { recursive: true });
      await writeFile(path.join(this.dirFor(key), DURATION), JSON.stringify({ ms }));
    } catch {
      // Not fatal: without it the playlist cannot pad, and the caller still gets to play.
    }
    return ms;
  }

  private async readDuration(key: string): Promise<number | null> {
    try {
      const parsed = JSON.parse(await readFile(path.join(this.dirFor(key), DURATION), "utf8")) as {
        ms?: number;
      };
      return typeof parsed.ms === "number" && parsed.ms > 0 ? parsed.ms : null;
    } catch {
      return null;
    }
  }

  /** A path inside this key's package, or null when the name is not one of ours. */
  segmentPath(key: string, name: string): string | null {
    if (!KEY_RE.test(key) || !(SEGMENT_RE.test(name) || SPLASH_RE.test(name) || PAD_RE.test(name))) {
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
      mode: this.settings.cuts,
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
    try {
      await stat(path.join(this.dirFor(key), DONE));
      return true;
    } catch {
      return false;
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
  private async readCsv(file: string): Promise<Array<{ name: string; startMs: number; endMs: number }>> {
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
  ): Promise<PackageState> {
    const ranges = keptRanges(windows, durationMs);
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

    let recorded = 0;
    for (let i = 0; i < ranges.length; i++) {
      const range = ranges[i];
      if (!range) continue;
      const wanted = range.endMs - range.startMs;
      if (wanted < 500) continue;
      const csv = path.join(state.dir, `${PASS}${i}.csv`);
      const result = await run(
        this.settings.ffmpegPath,
        [
          "-nostdin", "-hide_banner", "-v", "error", "-y",
          ...inputOptions(),
          "-ss", seconds(range.startMs),
          "-i", sourceUrl,
          "-t", seconds(wanted),
          "-c", "copy",
          "-f", "segment",
          "-segment_time", String(SEGMENT_SECONDS),
          "-segment_format", "mpegts",
          // The timestamps must *run* across the segments of a stretch. Resetting
          // them per segment (`-reset_timestamps 1`) stamps every segment with the
          // same clock, so a player sees a ten-second item that restarts at every
          // segment: the bar loops, the duration is one segment long, and audio and
          // video — reset on different frame boundaries — drift apart.
          "-muxdelay", "0", "-muxpreload", "0",
          // Keep the first frame of a stretch at zero rather than negative: ffmpeg
          // starts a copy at the keyframe *before* the requested point.
          "-avoid_negative_ts", "make_zero",
          "-segment_list", csv,
          "-segment_list_type", "csv",
          "-segment_start_number", String(recorded),
          path.join(state.dir, "seg%05d.ts"),
        ],
        this.timeoutFor(wanted),
      );
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
