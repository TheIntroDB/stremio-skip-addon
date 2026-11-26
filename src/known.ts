// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * What a stream turned out to be, remembered between playbacks.
 *
 * A stream list is a menu and must not do work (see `handleStreams`), so the list cannot probe
 * anything to find out whether a stream is one that will be packaged without a processing card --
 * an HEVC file, which is most 4K releases, takes a minute to start and shows nothing while it
 * does. What the list *can* do is remember: the first play of a release learns its codec from the
 * probe that is already paid for, and every later list for that release can say so.
 *
 * The identity is the stream's own (`streamIdentity`), not its URL: a debrid link is re-minted for
 * every playback, and a map keyed by the link would never hit twice.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** What a release is, as far as warning the menu is concerned. */
export interface Known {
  /** ffprobe's name for the video codec: `hevc`, `h264`, ... */
  video: string;
  /** When it was learnt, so the map can stay small. */
  at: number;
}

const FILE = "known.json";
/** Enough for a household's watching habit, small enough to read on every list. */
const LIMIT = 500;

const stores = new Map<string, KnownCodecs>();

/** One store per cache directory, so a playback and the menu agree without threading it around. */
export function knownCodecs(cacheDir: string): KnownCodecs {
  const existing = stores.get(cacheDir);
  if (existing) return existing;
  const created = new KnownCodecs(cacheDir);
  stores.set(cacheDir, created);
  return created;
}

export class KnownCodecs {
  private entries: Record<string, Known> | null = null;
  /** Writes are serialised: two playbacks finishing together must not lose one's entry. */
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly cacheDir: string) {}

  private get file(): string {
    return path.join(this.cacheDir, FILE);
  }

  /** Everything learnt so far. A missing or unreadable file is simply "nothing yet". */
  async read(): Promise<Record<string, Known>> {
    if (this.entries) return this.entries;
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as unknown;
      const entries: Record<string, Known> = {};
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [identity, value] of Object.entries(parsed as Record<string, unknown>)) {
          const candidate = value as Partial<Known> | null;
          if (!candidate || typeof candidate.video !== "string") continue;
          entries[identity] = { video: candidate.video, at: Number(candidate.at) || 0 };
        }
      }
      this.entries = entries;
    } catch {
      this.entries = {};
    }
    return this.entries;
  }

  /** Record what this release is. Cheap: one small file, rewritten only when it changes. */
  async remember(identity: string, video: string): Promise<void> {
    if (!identity || !video) return;
    const entries = await this.read();
    if (entries[identity]?.video === video) return;
    entries[identity] = { video, at: Date.now() };
    const kept = Object.entries(entries)
      .sort(([, left], [, right]) => right.at - left.at)
      .slice(0, LIMIT);
    this.entries = Object.fromEntries(kept);
    this.writing = this.writing.then(async () => {
      try {
        await mkdir(this.cacheDir, { recursive: true });
        await writeFile(this.file, JSON.stringify(this.entries));
      } catch {
        // Not fatal: the warning is a convenience, and the next playback tries again.
      }
    });
    await this.writing;
  }

  /** Forget everything, for a drain. */
  async clear(): Promise<void> {
    this.entries = {};
    this.writing = this.writing.then(async () => {
      try {
        await writeFile(this.file, "{}");
      } catch {
        // Nothing to clear.
      }
    });
    await this.writing;
  }
}
