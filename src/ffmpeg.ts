// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * The pieces every ffmpeg job in this service needs: running it, deciding what to
 * copy, and refusing to fill a disk.
 */

import { spawn } from "node:child_process";
import { statfs } from "node:fs/promises";

/** A stretch of a file that survives the skip windows. */
export interface KeptRange {
  startMs: number;
  endMs: number;
}

/**
 * Nothing shorter than this is worth a separate stretch: ffmpeg cannot cut inside a
 * GOP anyway, so a smaller range would come back as a stray fragment.
 */
const MIN_KEPT_MS = 500;

/**
 * Free space available to this process, in bytes.
 *
 * `bavail` is what an unprivileged user may use, which is what matters here (the
 * image runs as `node`). Anything unexpected answers Infinity: this guard exists to
 * prevent a filled disk, not to be a reason a job cannot run.
 */
export async function freeBytes(dir: string): Promise<number> {
  try {
    const info = await statfs(dir);
    return info.bavail * info.bsize;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Whether a copy of `neededBytes` fits, keeping a tenth of the disk for everything
 * else (logs, the database of another app on the same volume).
 *
 * An unknown size is allowed through: a debrid link that streams in chunks reports
 * none, and refusing those would remove the feature for the sources that need it.
 */
export function hasRoomFor(
  neededBytes: number | null,
  free: number,
  headroom = 0.9,
): boolean {
  if (neededBytes === null || neededBytes <= 0) return true;
  return neededBytes <= free * headroom;
}

/**
 * The ranges that survive, from the windows to remove.
 *
 * A known `durationMs` bounds everything: a window that starts past the end of the
 * file is not in this file at all (timings can belong to a longer release), and a
 * window that runs past it is clipped. Without a bound the last window runs to the
 * end of the file, which is what a pre-cut does before it has probed anything.
 */
export function keptRanges(
  windows: readonly { type: string; startMs: number; endMs: number | null }[],
  durationMs: number | null,
): KeptRange[] {
  const sorted = [...windows].sort((a, b) => a.startMs - b.startMs);
  const duration = durationMs ?? Number.POSITIVE_INFINITY;
  const kept: KeptRange[] = [];
  let cursor = 0;

  for (const window of sorted) {
    const start = Math.min(Math.max(0, window.startMs), duration);
    const end = Math.min(window.endMs === null ? duration : Math.max(0, window.endMs), duration);
    if (end <= start) continue;
    if (start - cursor >= MIN_KEPT_MS) kept.push({ startMs: cursor, endMs: start });
    cursor = Math.max(cursor, end);
  }

  if (durationMs === null) {
    if (cursor === 0) kept.push({ startMs: 0, endMs: Number.MAX_SAFE_INTEGER });
    return kept;
  }
  if (durationMs - cursor >= MIN_KEPT_MS) kept.push({ startMs: cursor, endMs: durationMs });
  return kept;
}

/** Options that keep a flaky CDN link from failing a long job. */
export function inputOptions(): string[] {
  return [
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "5",
    "-rw_timeout", "30000000",
  ];
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command to completion, killing it after `timeoutMs`, or when `signal` aborts. */
export function run(
  command: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      stderr += `\n[timed out after ${Math.round(timeoutMs / 1000)}s]`;
    }, timeoutMs);

    // A drain has to be able to stop a job mid-encode: the whole point of it is that nothing this
    // process started is still reading or writing when the cache is cleared.
    const abort = () => {
      child.kill("SIGKILL");
      stderr += "\n[aborted]";
    };
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
    const settle = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(result);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      settle({ code: -1, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on("close", (code) => {
      settle({ code: code ?? -1, stdout, stderr });
    });
  });
}
