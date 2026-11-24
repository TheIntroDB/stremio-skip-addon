// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * Live smoke test against the real API. Opt-in, because CI must not depend on it,
 * and it needs a key because the addon refuses to look anything up without one:
 *
 *   TIDB_LIVE=1 TIDB_API_KEY=<key> npm test
 *
 * It asserts the shape and the plumbing, never the community figures, so a new
 * submission to TheIntroDB cannot turn it red. The expected cut is recomputed from
 * whatever the API answers.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { spliceMediaPlaylist, type UriRewriters } from "../src/hls.js";
import { lookupSkipWindows } from "../src/introdb.js";
import type { Env, SkipWindow } from "../src/types.js";

const apiKey = (process.env.TIDB_API_KEY ?? "").trim();
const live = process.env.TIDB_LIVE === "1" && apiKey.length > 0;
const liveEnv: Env = { TIDB_API_KEY: apiKey };

const identity: UriRewriters = { playlistUri: (uri) => uri, resourceUri: (uri) => uri };

test("the live API answers for a known episode, and the answer cuts that episode", { skip: !live }, async () => {
  const result = await lookupSkipWindows(
    liveEnv,
    { types: ["intro", "recap", "credits", "preview"] },
    "tt0903747:1:1",
  );
  assert.equal(result.status, "ok", `lookup failed: ${result.reason}`);
  assert.ok(result.windows.length > 0, "Breaking Bad S1E1 has had timings for years");

  for (const window of result.windows) {
    assert.ok(window.startMs >= 0 && window.startMs < 3600_000, "a window starts inside an hour");
    if (window.endMs !== null) assert.ok(window.endMs > window.startMs);
  }
  const intro = result.windows.find((window) => window.type === "intro");
  assert.ok(intro, "an intro is expected on this episode");

  // Build a four-hour playlist on a 6s grid and cut it with the live windows.
  const durationMs = 4 * 60 * 60 * 1000;
  const gridMs = 6000;
  const count = durationMs / gridMs;
  const lines = ["#EXTM3U", "#EXT-X-TARGETDURATION:6", "#EXT-X-PLAYLIST-TYPE:VOD"];
  for (let index = 0; index < count; index++) {
    lines.push("#EXTINF:6.000,", `seg${index}.ts`);
  }
  lines.push("#EXT-X-ENDLIST");

  const spliced = spliceMediaPlaylist(lines.join("\n"), {
    baseUrl: "https://cdn.example/index.m3u8",
    windows: result.windows as SkipWindow[],
    rewriters: identity,
  })!;

  const expected = result.windows.reduce((total, window) => {
    const start = Math.max(0, window.startMs);
    const end = window.endMs === null ? durationMs : window.endMs;
    let dropped = 0;
    for (let index = 0; index < count; index++) {
      const segmentStart = index * gridMs;
      const segmentEnd = segmentStart + gridMs;
      if (segmentStart < end && segmentEnd > start) dropped++;
    }
    return total + dropped;
  }, 0);

  assert.equal(spliced.droppedSegments, expected);
  assert.ok(spliced.changed);
  assert.ok(spliced.droppedMs > 0);
  console.log(
    `live: ${result.windows.map((w) => `${w.type} ${w.startMs}-${w.endMs ?? "end"}`).join(", ")} ` +
      `-> ${spliced.droppedSegments}/${count} segments removed (${Math.round(spliced.droppedMs / 1000)}s)`,
  );
});

test("the live API has no timings for a title that does not exist", { skip: !live }, async () => {
  const result = await lookupSkipWindows(liveEnv, { types: ["intro"] }, "tt99999999:1:1");
  assert.equal(result.status, "not_found");
  assert.deepEqual(result.windows, []);
});
