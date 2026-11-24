// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * A tiny HTTP cache abstraction.
 *
 * The Worker runs on Cloudflare's edge, where `caches.default` is per-datacentre
 * and free. In Node (tests, and `wrangler dev` with an older runtime) there is no
 * edge cache, so a bounded in-process Map stands in. Both are best-effort: a cache
 * failure must never fail a request.
 */

import type { Env } from "./types.js";

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

interface EdgeCacheStorage {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

const CACHE_ORIGIN = "https://cache.tidb-skip.invalid/";

/** Read `caches.default` without depending on a DOM lib being configured. */
function edgeCache(): EdgeCacheStorage | null {
  const candidate = (globalThis as { caches?: { default?: EdgeCacheStorage } }).caches;
  const store = candidate?.default;
  if (!store || typeof store.match !== "function" || typeof store.put !== "function") return null;
  return store;
}

class EdgeHttpCache implements HttpCache {
  constructor(private readonly store: EdgeCacheStorage) {}

  async match(key: string): Promise<CachedResponse | null> {
    try {
      const hit = await this.store.match(new Request(CACHE_ORIGIN + encodeURIComponent(key)));
      if (!hit) return null;
      return {
        status: Number(hit.headers.get("x-cached-status") ?? "200"),
        body: await hit.text(),
        contentType: hit.headers.get("x-cached-content-type") ?? "text/plain",
      };
    } catch {
      return null;
    }
  }

  async put(key: string, value: CachedResponse, ttlSeconds: number): Promise<void> {
    try {
      await this.store.put(
        new Request(CACHE_ORIGIN + encodeURIComponent(key)),
        new Response(value.body, {
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": `max-age=${Math.max(1, Math.floor(ttlSeconds))}`,
            "x-cached-status": String(value.status),
            "x-cached-content-type": value.contentType,
          },
        }),
      );
    } catch {
      // A cache write is never worth failing a request over.
    }
  }
}

const MAX_ENTRIES = 512;

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

/** Drop the in-process cache. Only useful to a test that must observe a cold miss. */
export function resetMemoryCache(): void {
  memoryCache.clear();
}

/** The cache this deployment should use. */
export function getHttpCache(env: Env): HttpCache {
  if (env.CACHE_MODE === "memory") return memoryCache;
  const edge = edgeCache();
  return edge ? new EdgeHttpCache(edge) : memoryCache;
}
