// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

import assert from "node:assert/strict";
import test from "node:test";

import { buildApiUrl, lookupSkipWindows, mediaToWindows } from "../src/introdb.js";
import { MemoryHttpCache } from "../src/cache.js";
import type { Env, IntroDbMediaResponse } from "../src/types.js";

const env: Env = { TIDB_API_KEY: "unit-test-key" };

test("a null end runs to the end of the file, a null start is 0:00", () => {
  const media: IntroDbMediaResponse = {
    intro: [{ start_ms: null, end_ms: 30000 }],
    credits: [{ start_ms: 1000000, end_ms: null }],
  };
  assert.deepEqual(mediaToWindows(media, ["intro", "credits"]), [
    { type: "intro", startMs: 0, endMs: 30000 },
    { type: "credits", startMs: 1000000, endMs: null },
  ]);
});

test("a segment with both bounds absent or zero is an existence claim, never a range", () => {
  const media: IntroDbMediaResponse = {
    intro: [{ start_ms: null, end_ms: null }],
    recap: [{ start_ms: 0, end_ms: 0 }],
    credits: [{ start_ms: 0, end_ms: 0 }],
  };
  assert.deepEqual(mediaToWindows(media, ["intro", "recap", "credits"]), []);
});

test("a null-end segment starting at 0:00 is dropped: it would cut the whole file", () => {
  const media: IntroDbMediaResponse = { credits: [{ start_ms: 0, end_ms: null }] };
  assert.deepEqual(mediaToWindows(media, ["credits"]), []);
});

test("a credits range with an explicit end that starts at 0:00 is kept", () => {
  const media: IntroDbMediaResponse = { credits: [{ start_ms: 0, end_ms: 90000 }] };
  assert.deepEqual(mediaToWindows(media, ["credits"]), [{ type: "credits", startMs: 0, endMs: 90000 }]);
});

test("only the enabled segment kinds become windows", () => {
  const media: IntroDbMediaResponse = {
    intro: [{ start_ms: 1000, end_ms: 2000 }],
    recap: [{ start_ms: 3000, end_ms: 4000 }],
    credits: [{ start_ms: 5000, end_ms: 6000 }],
    preview: [{ start_ms: 7000, end_ms: 8000 }],
  };
  assert.deepEqual(mediaToWindows(media, ["recap"]), [{ type: "recap", startMs: 3000, endMs: 4000 }]);
});

test("several occurrences of one type all count, and touching windows merge", () => {
  const media: IntroDbMediaResponse = {
    credits: [
      { start_ms: 100000, end_ms: 200000 },
      { start_ms: 200000, end_ms: null },
    ],
    intro: [{ start_ms: 5000, end_ms: 10000 }],
  };
  assert.deepEqual(mediaToWindows(media, ["credits", "intro"]), [
    { type: "intro", startMs: 5000, endMs: 10000 },
    { type: "credits", startMs: 100000, endMs: null },
  ]);
});

test("degenerate and malformed entries are ignored", () => {
  const media = {
    intro: [
      { start_ms: 5000, end_ms: 5000 },
      { start_ms: 6000, end_ms: 4000 },
      {},
      null,
      { start_ms: "1000", end_ms: 2000 },
    ],
  } as IntroDbMediaResponse;
  assert.deepEqual(mediaToWindows(media, ["intro"]), []);
});

test("the request URL carries the id, and season/episode only for episodes", () => {
  assert.equal(
    buildApiUrl({ imdbId: "tt0111161", season: null, episode: null }),
    "https://api.theintrodb.org/v4/media?imdb_id=tt0111161",
  );
  assert.equal(
    buildApiUrl({ imdbId: "tt0903747", season: 1, episode: 2 }),
    "https://api.theintrodb.org/v4/media?imdb_id=tt0903747&season=1&episode=2",
  );
});

test("without a key nothing is looked up, and no request is made", async () => {
  const fetchImpl: typeof fetch = async () => {
    throw new Error("should not be called");
  };
  const cache = new MemoryHttpCache();

  const fromNowhere = await lookupSkipWindows({}, { types: ["intro"] }, "tt0903747:1:1", {
    cache,
    fetchImpl,
  });
  assert.equal(fromNowhere.status, "unavailable");
  assert.equal(fromNowhere.reason, "missing_api_key");

  // Also when a key is present but blank.
  const blank = await lookupSkipWindows({ TIDB_API_KEY: "   " }, { types: ["intro"] }, "tt0903747:1:1", {
    cache,
    fetchImpl,
  });
  assert.equal(blank.reason, "missing_api_key");

  // A key in the install config counts as configured.
  const configured = await lookupSkipWindows({}, { types: ["intro"], key: "from-url" }, "tt0903747:1:1", {
    cache,
    fetchImpl: async () => new Response(JSON.stringify({ intro: [{ start_ms: 1, end_ms: 2 }] }), { status: 200 }),
  });
  assert.equal(configured.status, "ok");
});

test("a fresh lookup parses the body, and the second one is served from cache", async () => {
  const cache = new MemoryHttpCache();
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls++;
    return new Response(
      JSON.stringify({ tvdb_id: 81189, intro: [{ start_ms: 228665, end_ms: 246498 }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const config = { types: ["intro" as const] };
  const first = await lookupSkipWindows(env, config, "tt0903747:1:1", { cache, fetchImpl });
  assert.equal(first.status, "ok");
  assert.equal(first.cached, false);
  assert.equal(first.tvdbId, 81189);
  assert.deepEqual(first.windows, [{ type: "intro", startMs: 228665, endMs: 246498 }]);

  const second = await lookupSkipWindows(env, config, "tt0903747:1:1", { cache, fetchImpl });
  assert.equal(second.cached, true);
  assert.deepEqual(second.windows, first.windows);
  assert.equal(calls, 1);
});

test("the API key is sent when the config or the Worker provides one", async () => {
  const seen: string[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    seen.push(new Headers(init?.headers).get("authorization") ?? "");
    return new Response(JSON.stringify({ intro: [{ start_ms: 1000, end_ms: 2000 }] }), { status: 200 });
  };
  const cache = new MemoryHttpCache();

  await lookupSkipWindows(env, { types: ["intro"], key: "from-config" }, "tt0000001:1:1", { cache, fetchImpl });
  await lookupSkipWindows(env, { types: ["intro"] }, "tt0000002:1:1", { cache, fetchImpl });

  // The config wins over the deployment secret, so a user can bring their own key.
  assert.deepEqual(seen, ["Bearer from-config", "Bearer unit-test-key"]);
});

test("a 404 is a clean miss, and is cached as one", async () => {
  const cache = new MemoryHttpCache();
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ error: "media not found", code: "episode_not_found" }), {
      status: 404,
    });
  };

  const result = await lookupSkipWindows(env, { types: ["intro"] }, "tt0903747:9:9", { cache, fetchImpl });
  assert.equal(result.status, "not_found");
  assert.equal(result.reason, "episode_not_found");
  assert.deepEqual(result.windows, []);

  const again = await lookupSkipWindows(env, { types: ["intro"] }, "tt0903747:9:9", { cache, fetchImpl });
  assert.equal(again.cached, true);
  assert.equal(calls, 1);
});

test("a 429 and a network failure are unavailable, never a wrong answer", async () => {
  const cache = new MemoryHttpCache();
  const rateLimited = await lookupSkipWindows(env, { types: ["intro"] }, "tt0000005:1:1", {
    cache,
    fetchImpl: async () =>
      new Response("slow down", { status: 429, headers: { "retry-after": "30" } }),
  });
  assert.equal(rateLimited.status, "unavailable");
  assert.equal(rateLimited.reason, "rate_limited:retry_after=30");
  assert.deepEqual(rateLimited.windows, []);

  const failed = await lookupSkipWindows(env, { types: ["intro"] }, "tt0000006:1:1", {
    cache,
    fetchImpl: async () => {
      throw new TypeError("network");
    },
  });
  assert.equal(failed.status, "unavailable");
  assert.equal(failed.reason, "request_failed:TypeError");
});

test("an unsupported id and an empty type list never reach the network", async () => {
  const cache = new MemoryHttpCache();
  const fetchImpl: typeof fetch = async () => {
    throw new Error("should not be called");
  };
  const bad = await lookupSkipWindows(env, { types: ["intro"] }, "kitsu:1", { cache, fetchImpl });
  assert.equal(bad.reason, "unsupported_id");

  const nothingEnabled = await lookupSkipWindows(env, { types: [] }, "tt0000001:1:1", { cache, fetchImpl });
  assert.equal(nothingEnabled.status, "ok");
  assert.equal(nothingEnabled.reason, "no_segment_types_enabled");
});

test("a malformed body is unavailable, not empty", async () => {
  const result = await lookupSkipWindows(env, { types: ["intro"] }, "tt0000007:1:1", {
    cache: new MemoryHttpCache(),
    fetchImpl: async () => new Response("<html>oops</html>", { status: 200 }),
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "invalid_json");
});
