// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * What `/drain` deletes, and what `/debug` reports about it.
 *
 * Two directories are working state, not settings: `hls` holds the packages cut out of a source
 * and `subs` the generated tracks. Both are rebuilt on demand, so wiping them costs CPU and
 * nothing else -- which is what makes it safe to offer as a button. `models` is deliberately
 * never touched: it is weights downloaded once, and re-fetching them is minutes of network.
 */

import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

/** Directories under the cache dir that a drain clears. `models` is not one of them. */
export const DRAINED = ["hls", "subs"] as const;

export interface CacheEntry {
  /** The directory's name under the cache dir. */
  name: string;
  /** Whether a drain would clear it. */
  cleared: boolean;
  /** Entries directly inside it: packages for `hls`, tracks for `subs`. */
  entries: number;
  bytes: number;
}

async function sizeOf(dir: string): Promise<number> {
  let total = 0;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      const info = await stat(full);
      total += info.isDirectory() ? await sizeOf(full) : info.size;
    } catch {
      // Gone between the listing and the stat.
    }
  }
  return total;
}

/** What is on disk right now, per directory, for the debug page. */
export async function cacheReport(cacheDir: string): Promise<CacheEntry[]> {
  const report: CacheEntry[] = [];
  let names: string[] = [];
  try {
    names = (await readdir(cacheDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return report;
  }
  for (const name of names) {
    const dir = path.join(cacheDir, name);
    const entries = await readdir(dir).then((list) => list.length).catch(() => 0);
    report.push({
      name,
      cleared: (DRAINED as readonly string[]).includes(name),
      entries,
      bytes: await sizeOf(dir),
    });
  }
  return report;
}

/** Delete the working state, and report what it was. */
export async function purgeCache(cacheDir: string): Promise<{ dirs: number; bytes: number }> {
  let bytes = 0;
  let dirs = 0;
  for (const name of DRAINED) {
    const dir = path.join(cacheDir, name);
    const before = await sizeOf(dir);
    try {
      await rm(dir, { recursive: true, force: true });
      dirs += 1;
      bytes += before;
    } catch {
      // A directory that cannot be removed is reported by the caller's next cache report.
    }
  }
  return { dirs, bytes };
}

/** Bytes as something an operator can read at a glance. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
