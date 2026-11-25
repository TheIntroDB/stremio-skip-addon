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
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Settings } from "./env.js";
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
  segments: number;
  durationMs: number;
}

interface Plan {
  key: string;
  windows: SkipWindow[];
  ranges: KeptRange[];
  createdAt: number;
}

const PACKAGE_ROOT = "hls";
const PLAN = "plan.json";
const DONE = "done";
const PASS = "pass-";
/** How often a waiting play re-reads the CSVs while the first segment is written. */
const POLL_MS = 250;
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
  private readonly running = new Map<string, Promise<PackageState>>();
  private readonly tasks: Array<() => void> = [];
  private active = 0;
  private available: boolean | null = null;

  constructor(private readonly settings: Settings) {}

  /** Check that ffmpeg exists and the cache directory is usable. */
  async start(): Promise<{ ok: boolean; detail: string }> {
    if (this.settings.cuts === "off") {
      this.available = false;
      return { ok: true, detail: "cutting is off" };
    }
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
    return {
      ok: this.available,
      detail: this.available
        ? `${(probe.stdout.split("\n")[0] ?? "ffmpeg").trim()} -> ${this.settings.cacheDir}`
        : `${this.settings.ffmpegPath} not runnable: ${probe.stderr.trim().slice(0, 200)}`,
    };
  }

  get enabled(): boolean {
    return this.settings.cuts !== "off" && this.available !== false;
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
   * The playlist for this key, or null when no segment is complete yet.
   *
   * Everything comes off disk, so a package made by an earlier process plays too.
   * Only segments that ffmpeg has reported as closed are listed: a player asking for
   * a segment that is still being written would fail, and the CSV is the signal that
   * says which ones are whole.
   */
  async manifest(key: string): Promise<ManifestView | null> {
    const plan = await this.readPlan(key);
    if (!plan) return null;
    this.used.set(key, Date.now());
    const dir = this.dirFor(key);
    const lines: string[] = [];
    let segments = 0;
    let durationMs = 0;
    let longestMs = 0;

    for (let i = 0; i < plan.ranges.length; i++) {
      const range = plan.ranges[i];
      if (!range) continue;
      const rows = await this.readCsv(path.join(dir, `${PASS}${i}.csv`));
      const wanted = range.endMs - range.startMs;
      // ffmpeg stops at the keyframe after the requested end, so the last segment of
      // a stretch can hold a little of the dropped window. Whole segments that start
      // past the end are dropped; the remainder is left to the GOP.
      const kept = rows.filter((row) => row.startMs < wanted);
      if (kept.length === 0) continue;
      if (segments > 0) lines.push("#EXT-X-DISCONTINUITY");
      for (const row of kept) {
        const duration = Math.max(0, row.endMs - row.startMs);
        lines.push(`#EXTINF:${(duration / 1000).toFixed(3)},`);
        lines.push(`seg?f=${encodeURIComponent(key)}/${row.name}`);
        segments += 1;
        durationMs += duration;
        longestMs = Math.max(longestMs, duration);
      }
    }

    if (segments === 0) return null;
    const complete = await this.isDone(key);
    const head = [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(longestMs / 1000))}`,
      "#EXT-X-MEDIA-SEQUENCE:0",
      "#EXT-X-DISCONTINUITY-SEQUENCE:0",
      // EVENT while it grows: the player keeps re-reading the playlist, which is how
      // it learns about the segments written after it started.
      `#EXT-X-PLAYLIST-TYPE:${complete ? "VOD" : "EVENT"}`,
    ];
    const tail = complete ? ["#EXT-X-ENDLIST"] : [];
    return {
      body: `${[...head, ...lines, ...tail].join("\n")}\n`,
      complete,
      segments,
      // Summed from the segment durations, so this is a float until it is rounded: it
      // goes out in a header and is read by people.
      durationMs: Math.round(durationMs),
    };
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

  /** A path inside this key's package, or null when the name is not one of ours. */
  segmentPath(key: string, name: string): string | null {
    if (!KEY_RE.test(key) || !SEGMENT_RE.test(name)) return null;
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
      skipMarginSeconds: this.settings.skipMarginSeconds,
      available: this.available,
      cacheDir: this.settings.cacheDir,
      cacheMaxGb: Math.round(this.settings.cacheMaxBytes / 1024 ** 3),
      cutConcurrency: this.settings.cutConcurrency,
      active: this.active,
      queued: this.tasks.length,
      packages: byStatus,
      segments,
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
