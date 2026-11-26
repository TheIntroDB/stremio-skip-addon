// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * A small in-process cache for the lookups and the playlist verdicts.
 *
 * This is a long-running server, so a Map with a TTL is all that is needed: the
 * entries are a few hundred bytes and the things being cached (TheIntroDB answers,
 * "this target is not a playlist") are cheap to recompute.
 */

export interface CachedResponse {
  status: number;
  /** Raw response body. Always text here: only JSON and playlists are cached. */
  body: string;
  contentType: string;
}

export interface HttpCache {
  match(key: string): Promise<CachedResponse | null>;
  put(key: string, value: CachedResponse, ttlSeconds: number): Promise<void>;
}

const MAX_ENTRIES = 4096;

export class MemoryHttpCache implements HttpCache {
  private readonly entries = new Map<string, { value: CachedResponse; expiresAt: number }>();

  async match(key: string): Promise<CachedResponse | null> {
    const hit = this.entries.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    // Refresh insertion order so the oldest survivor is a genuine LRU victim.
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit.value;
  }

  async put(key: string, value: CachedResponse, ttlSeconds: number): Promise<void> {
    this.entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

const memoryCache = new MemoryHttpCache();

/** The cache this process uses. */
export function getHttpCache(): HttpCache {
  return memoryCache;
}

/** Drop the in-process cache. For tests that must observe a cold miss. */
export function resetMemoryCache(): void {
  memoryCache.clear();
}
