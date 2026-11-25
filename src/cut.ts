// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * The cut engine: removes segments from a file that cannot be expressed as a
 * playlist.
 *
 * An HLS source is cut by rewriting its playlists (see `hls.ts`) and no video ever
 * touches this service. A progressive `.mkv`/`.mp4` from a debrid has no playlist
 * to rewrite, so it is remuxed instead: ffmpeg is asked to copy the ranges that
 * survive and concatenate them, with no re-encode (`-c copy`), which is fast and
 * leaves every codec exactly as the player already handled it. The result is
 * cached on disk and served with range support, so seeking works normally.
 *
 * The first playback of a title may therefore pass through uncut while the remux
 * runs in the background; from the next start of that item the cut is served.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Settings } from "./env.js";
import type { SkipWindow } from "./types.js";

export type CutStatus = "queued" | "running" | "ready" | "failed" | "skipped";

export interface CutState {
  key: string;
  status: CutStatus;
  /** Absolute path of the cut file once it is ready. */
  path?: string;
  /** Source extension, so the player sees the same container it expected. */
  container?: string;
  bytes?: number;
  durationMs?: number;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

interface KeptRange {
  startMs: number;
  endMs: number;
}

const MIN_KEPT_MS = 500;
const CACHE_META = ".tidb-cut-cache.json";
/** Where a cut is assembled before it is renamed into place. */
const PART_PREFIX = ".parts-";

export class CutEngine {
  private readonly states = new Map<string, CutState>();
  private readonly running = new Map<string, Promise<CutState>>();
  private readonly queue: Array<() => void> = [];
  private active = 0;
  private available: boolean | null = null;

  constructor(private readonly settings: Settings) {}

  /** Check that ffmpeg exists and the cache directory is writable. */
  async start(): Promise<{ ok: boolean; detail: string }> {
    if (this.settings.cuts === "off") {
      this.available = false;
      return { ok: true, detail: "cuts are off" };
    }
    try {
      await mkdir(this.settings.cacheDir, { recursive: true });
    } catch (error) {
      this.available = false;
      return { ok: false, detail: `cache dir unusable: ${errorText(error)}` };
    }
    // A process killed mid-cut leaves a half-written part directory behind, and
    // something has to clean it up: at boot nothing is using the cache.
    try {
      for (const name of await readdir(this.settings.cacheDir)) {
        if (name.startsWith(PART_PREFIX)) {
          await rm(path.join(this.settings.cacheDir, name), { recursive: true, force: true });
        }
      }
    } catch {
      // Not fatal: the worst case is a stale directory that the next cut replaces.
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

  /** Stable identity for one source file + one set of windows. */
  keyFor(sourceUrl: string, windows: readonly SkipWindow[]): string {
    let identity = sourceUrl;
    try {
      const url = new URL(sourceUrl);
      // Query strings are usually rotating debrid tokens: key on the path only.
      identity = `${url.origin}${url.pathname}`;
    } catch {
      // Keep the raw string when it is not a URL.
    }
    const shape = windows
      .map((window) => `${window.type}:${window.startMs}:${window.endMs ?? "end"}`)
      .join(",");
    return createHash("sha1").update(`${identity}|${shape}`).digest("hex").slice(0, 20);
  }

  state(key: string): CutState | null {
    return this.states.get(key) ?? null;
  }

  /** Queue a cut unless one is already queued, running or ready. */
  schedule(sourceUrl: string, windows: readonly SkipWindow[]): CutState {
    const key = this.keyFor(sourceUrl, windows);
    const existing = this.states.get(key);
    if (existing && existing.status !== "failed") return existing;

    const state: CutState = { key, status: "queued" };
    this.states.set(key, state);
    const task = this.enqueue(() => this.perform(sourceUrl, windows, state));
    this.running.set(key, task);
    void task.finally(() => this.running.delete(key));
    return state;
  }

  /** The path of a finished cut, or null. */
  async ready(key: string): Promise<string | null> {
    const state = this.states.get(key);
    if (!state || state.status !== "ready" || !state.path) return null;
    try {
      const info = await stat(state.path);
      return info.isFile() ? state.path : null;
    } catch {
      // Somebody removed the file: forget it so it can be cut again.
      this.states.delete(key);
      return null;
    }
  }

  /** Wait for a queued cut, up to `timeoutMs`. Null when it is not ready in time. */
  async waitFor(key: string, timeoutMs: number): Promise<string | null> {
    const ready = await this.ready(key);
    if (ready) return ready;
    const task = this.running.get(key);
    if (!task) return null;
    if (timeoutMs <= 0) return null;
    await Promise.race([task.catch(() => undefined), delay(timeoutMs)]);
    return this.ready(key);
  }

  stats(): Record<string, unknown> {
    const byStatus: Record<string, number> = {};
    let lastError: { key: string; error: string } | null = null;
    for (const state of this.states.values()) {
      byStatus[state.status] = (byStatus[state.status] ?? 0) + 1;
      if (state.status === "failed" && state.error) lastError = { key: state.key, error: state.error };
    }
    return {
      mode: this.settings.cuts,
      available: this.available,
      cacheDir: this.settings.cacheDir,
      cacheMaxGb: Math.round(this.settings.cacheMaxBytes / 1024 ** 3),
      active: this.active,
      queued: this.queue.length,
      known: byStatus,
      // Only the newest one: this is what an operator needs to see, and /health
      // stays small.
      lastError,
    };
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const runNow = () => {
        this.active++;
        work()
          .then(resolve, reject)
          .finally(() => {
            this.active--;
            const next = this.queue.shift();
            if (next) next();
          });
      };
      if (this.active < this.settings.cutConcurrency) runNow();
      else this.queue.push(runNow);
    });
  }

  private async perform(
    sourceUrl: string,
    windows: readonly SkipWindow[],
    state: CutState,
  ): Promise<CutState> {
    state.status = "running";
    state.startedAt = Date.now();
    try {
      // A playlist has no file to copy, and asking ffprobe about one makes it fetch
      // a segment, so this is settled with a cheap look first.
      if (await this.looksLikePlaylist(sourceUrl)) {
        state.status = "skipped";
        state.error = "playlist (handled by the playlist splicer)";
        return state;
      }

      const probe = await this.probe(sourceUrl);
      if (!probe.isFile) {
        // HLS and anything else that is not a plain file is handled elsewhere.
        state.status = "skipped";
        state.error = `not a file (${probe.formatName || "unknown"})`;
        return state;
      }
      state.container = probe.container;
      const kept = keptRanges(windows, probe.durationMs);
      if (kept.length === 0) {
        state.status = "skipped";
        state.error = "every range was skipped";
        return state;
      }

      const target = path.join(this.settings.cacheDir, `${state.key}.${probe.container}`);
      const partDir = path.join(this.settings.cacheDir, `${PART_PREFIX}${state.key}`);
      await mkdir(partDir, { recursive: true });
      const parts: string[] = [];
      try {
        for (const [index, range] of kept.entries()) {
          const part = path.join(partDir, `part${index}.${probe.container}`);
          await this.copyRange(sourceUrl, range, part, probe.container);
          parts.push(part);
        }
        if (parts.length === 1) {
          await rm(target, { force: true });
          await rename(parts[0]!, target);
        } else {
          const list = path.join(partDir, "list.txt");
          await writeFile(
            list,
            parts.map((part) => `file '${part.replace(/'/g, "'\\''")}'`).join("\n"),
            "utf8",
          );
          await this.concat(list, target, probe.container);
        }
      } finally {
        await rm(partDir, { recursive: true, force: true });
      }

      const info = await stat(target);
      const outProbe = await this.probe(target);
      state.path = target;
      state.bytes = info.size;
      state.durationMs = outProbe.durationMs ?? undefined;
      state.status = "ready";
      state.finishedAt = Date.now();
      await this.evict();
      return state;
    } catch (error) {
      state.status = "failed";
      state.error = errorText(error).slice(0, 300);
      state.finishedAt = Date.now();
      return state;
    }
  }

  /** A cheap test for "this is a playlist, not a file" before ffprobe sees it. */
  private async looksLikePlaylist(sourceUrl: string): Promise<boolean> {
    let pathname = sourceUrl;
    try {
      pathname = new URL(sourceUrl).pathname;
    } catch {
      // Not a URL (a local path in tests): the extension check still applies.
    }
    if (/\.m3u8?$/i.test(pathname)) return true;

    // A playlist on a URL with no extension: look at the first bytes.
    try {
      const response = await fetch(sourceUrl, {
        headers: { range: "bytes=0-8191" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.body) return false;
      if (/mpegurl/i.test(response.headers.get("content-type") ?? "")) {
        await response.body.cancel().catch(() => undefined);
        return true;
      }
      const reader = response.body.getReader();
      const { value } = await reader.read();
      await reader.cancel().catch(() => undefined);
      if (!value) return false;
      return new TextDecoder().decode(value.subarray(0, 64)).trimStart().startsWith("#EXTM3U");
    } catch {
      return false;
    }
  }

  private async probe(target: string): Promise<{
    isFile: boolean;
    durationMs: number | null;
    container: string;
    formatName: string;
  }> {
    const result = await run(
      this.settings.ffprobePath,
      [
        "-v", "error",
        "-show_entries", "format=duration,format_name",
        "-of", "json",
        ...inputOptions(),
        target,
      ],
      60_000,
    );
    if (result.code !== 0) throw new Error(`ffprobe failed: ${result.stderr.trim().slice(0, 200)}`);

    let parsed: { format?: { duration?: string; format_name?: string } };
    try {
      parsed = JSON.parse(result.stdout) as typeof parsed;
    } catch {
      throw new Error("ffprobe returned unreadable output");
    }

    const formatName = parsed.format?.format_name ?? "";
    const isPlaylist = /mpegurl|applehttp|(^|,)hls(,|$)/i.test(formatName);
    const seconds = Number(parsed.format?.duration ?? Number.NaN);
    return {
      isFile: !isPlaylist,
      durationMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null,
      container: containerFor(formatName),
      formatName,
    };
  }

  private async copyRange(
    sourceUrl: string,
    range: KeptRange,
    part: string,
    container: string,
  ): Promise<void> {
    const durationSeconds = (range.endMs - range.startMs) / 1000;
    const args = [
      "-nostdin",
      "-hide_banner",
      "-v", "error",
      // Seek before the input: with `-c copy` this lands on the nearest keyframe,
      // which is the finest cut a remux can make.
      "-ss", (range.startMs / 1000).toFixed(3),
      ...inputOptions(),
      "-i", sourceUrl,
      "-t", durationSeconds.toFixed(3),
      "-map", container === "mp4" ? "0:v?" : "0",
      ...(container === "mp4" ? ["-map", "0:a?"] : []),
      "-c", "copy",
      "-avoid_negative_ts", "make_zero",
      "-y", part,
    ];
    const result = await run(this.settings.ffmpegPath, args, this.cutTimeoutMs());
    if (result.code !== 0) {
      throw new Error(`ffmpeg copy failed: ${result.stderr.trim().slice(0, 200)}`);
    }
  }

  private async concat(list: string, target: string, container: string): Promise<void> {
    const result = await run(
      this.settings.ffmpegPath,
      [
        "-nostdin", "-hide_banner", "-v", "error",
        "-f", "concat", "-safe", "0", "-i", list,
        "-map", container === "mp4" ? "0:v?" : "0",
        ...(container === "mp4" ? ["-map", "0:a?"] : []),
        "-c", "copy",
        "-y", target,
      ],
      this.cutTimeoutMs(),
    );
    if (result.code !== 0) {
      throw new Error(`ffmpeg concat failed: ${result.stderr.trim().slice(0, 200)}`);
    }
  }

  private cutTimeoutMs(): number {
    return Math.max(60_000, this.settings.cutWaitSeconds * 1000 * 10);
  }

  /**
   * Keep the cache under `cacheMaxBytes`, oldest file first.
   *
   * A file that is being streamed right now can safely be unlinked: the open file
   * descriptor keeps serving it to that player, and the next playback simply cuts
   * it again.
   */
  private async evict(): Promise<void> {
    if (this.settings.cacheMaxBytes <= 0) return;
    const entries: Array<{ name: string; size: number; used: number }> = [];
    try {
      for (const name of await readdir(this.settings.cacheDir)) {
        if (name.startsWith(".")) continue;
        const info = await stat(path.join(this.settings.cacheDir, name));
        if (info.isFile()) entries.push({ name, size: info.size, used: info.mtimeMs });
      }
    } catch {
      return;
    }

    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    if (total <= this.settings.cacheMaxBytes) return;

    entries.sort((a, b) => a.used - b.used);
    for (const entry of entries) {
      if (total <= this.settings.cacheMaxBytes) return;
      try {
        await rm(path.join(this.settings.cacheDir, entry.name), { force: true });
        total -= entry.size;
      } catch {
        return;
      }
    }
  }
}

/** The ranges that survive, from the windows to remove. */
export function keptRanges(
  windows: readonly SkipWindow[],
  durationMs: number | null,
): KeptRange[] {
  const sorted = [...windows].sort((a, b) => a.startMs - b.startMs);
  const kept: KeptRange[] = [];
  let cursor = 0;

  for (const window of sorted) {
    const start = Math.max(0, window.startMs);
    const end = window.endMs === null ? (durationMs ?? Number.POSITIVE_INFINITY) : window.endMs;
    if (start - cursor >= MIN_KEPT_MS) kept.push({ startMs: cursor, endMs: start });
    cursor = Math.max(cursor, end);
  }

  if (durationMs === null) {
    // No duration to bound the tail: the last window runs to the end of the file.
    if (cursor === 0) kept.push({ startMs: 0, endMs: Number.MAX_SAFE_INTEGER });
    return kept;
  }
  if (durationMs - cursor >= MIN_KEPT_MS) kept.push({ startMs: cursor, endMs: durationMs });
  return kept;
}

function containerFor(formatName: string): string {
  if (/matroska|webm/i.test(formatName)) return "mkv";
  if (/mpegts/i.test(formatName)) return "ts";
  if (/mov|mp4|isom|3gp/i.test(formatName)) return "mp4";
  return "mkv";
}

/** Options that keep a flaky CDN link from failing a long remux. */
function inputOptions(): string[] {
  return [
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "5",
    "-rw_timeout", "30000000",
  ];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command to completion, killing it after `timeoutMs`. */
export function run(command: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      stderr += `\n[timed out after ${Math.round(timeoutMs / 1000)}s]`;
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}
