// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * The line a stream list shows when a stream will be prepared without a preview.
 *
 * Nothing here probes anything: a list is a menu. It says what an earlier playback of the same
 * release learnt, or failing that what the release calls itself, and it only does so when the
 * stream is one that is packaged (a file) and packaged without a card in front of it.
 */

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { KnownCodecs } from "../src/known.js";
import { labelledHevc, wrapStream } from "../src/upstream.js";
import type { UpstreamStream } from "../src/types.js";

function item(overrides: Partial<UpstreamStream> = {}): UpstreamStream {
  return { name: "Source", title: "Some.Release", url: "https://cdn.example/film.mkv", ...overrides };
}

test("a release's own labels say whether it is HEVC", () => {
  assert.equal(labelledHevc(item({ title: "Some.Release.2160p.HEVC.x265" })), true);
  assert.equal(labelledHevc(item({ title: "Some.Release.1080p.H.265" })), true);
  assert.equal(labelledHevc(item({ description: "UHD bluray hevc 10bit" })), true);
  // A release that says x264 is not HEVC, whatever else its name says.
  assert.equal(labelledHevc(item({ title: "Some.Release.1080p.x264.x265-rip" })), false);
  assert.equal(labelledHevc(item({ title: "Some.Release.1080p.WEB" })), false);
  assert.equal(labelledHevc(item({})), false);
});

test("what a playback learnt about a release comes back on the next list", async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "tidb-known-"));
  const store = new KnownCodecs(cacheDir);
  assert.deepEqual(await store.read(), {}, "nothing learnt yet");

  await store.remember("release-a", "hevc");
  assert.equal((await store.read())["release-a"]?.video, "hevc", "and it is remembered");

  // A second instance sees the same file: this is how a playback teaches the menu.
  const again = new KnownCodecs(cacheDir);
  assert.equal((await again.read())["release-a"]?.video, "hevc");

  await again.clear();
  assert.deepEqual(await new KnownCodecs(cacheDir).read(), {}, "a drain forgets it");
});

test("the map stays small, keeping what was learnt most recently", async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "tidb-known-cap-"));
  const store = new KnownCodecs(cacheDir);
  for (let index = 0; index < 520; index += 1) await store.remember(`release-${index}`, "h264");
  const entries = await store.read();
  assert.equal(Object.keys(entries).length, 500, "capped");
  assert.ok(!entries["release-0"], "the oldest went");
  assert.ok(entries["release-519"], "the newest stayed");
});

test("the warning goes on the item, beneath what the release is", () => {
  const wrapped = wrapStream(item({ title: "Some.Release.2160p.HEVC" }), {
    playUrl: (target, identity) => `https://addon.example/play?u=${encodeURIComponent(target)}&k=${identity}`,
    label: "TheIntroDB",
    cutSummary: "intro 0:10-0:40",
    allowPrivateHosts: true,
    sourceBase: "https://cdn.example",
    warningFor: (_identity, stream) => (labelledHevc(stream) ? "⚠ HEVC: the first play can take a minute." : null),
  });
  assert.match(wrapped.description ?? "", /intro 0:10-0:40/, "what will be cut");
  assert.match(wrapped.description ?? "", /HEVC/, "and why it is slow");

  const plain = wrapStream(item({ title: "Some.Release.1080p.WEB" }), {
    playUrl: (target, identity) => `https://addon.example/play?u=${encodeURIComponent(target)}&k=${identity}`,
    label: "TheIntroDB",
    cutSummary: null,
    allowPrivateHosts: true,
    sourceBase: "https://cdn.example",
    warningFor: () => null,
  });
  assert.equal(plain.description, undefined, "nothing to say, nothing added");
});
