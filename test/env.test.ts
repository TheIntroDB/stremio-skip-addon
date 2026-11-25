// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * The settings loader, and the one thing about it that has bitten: a default outside its own
 * bounds is not a default.
 *
 * `SUBTITLES_CHUNK_SECONDS` fell back to 30 while the clamp started at 60, so an unset variable
 * and an explicit 30 both landed on a minute of audio per subtitle segment -- the first cues
 * arrived twice as late as they were written to, and nothing said so.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { readFile } from "node:fs/promises";

import { DEFAULT_SUBTITLES_CHUNK_SECONDS, loadSettings } from "../src/env.js";

/** Read the settings with `env` applied, then put the process's environment back as it was. */
function settingsWith(env: Record<string, string | undefined>) {
  const saved = Object.entries(env).map(([name]) => [name, process.env[name]] as const);
  try {
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    return loadSettings();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("an unset SUBTITLES_CHUNK_SECONDS is what the docs say it is", () => {
  const settings = settingsWith({ SUBTITLES_CHUNK_SECONDS: undefined });
  assert.equal(settings.subtitlesChunkSeconds, DEFAULT_SUBTITLES_CHUNK_SECONDS);
  assert.equal(settings.subtitlesChunkSeconds, 30, "one window of the recogniser");
});

test("a chunk is a subtitle segment, so the value is taken, not raised past it", () => {
  assert.equal(settingsWith({ SUBTITLES_CHUNK_SECONDS: "60" }).subtitlesChunkSeconds, 60);
  assert.equal(settingsWith({ SUBTITLES_CHUNK_SECONDS: "300" }).subtitlesChunkSeconds, 300);
});

test("values the recogniser cannot use faster are clamped, in both directions", () => {
  assert.equal(settingsWith({ SUBTITLES_CHUNK_SECONDS: "5" }).subtitlesChunkSeconds, 30, "below one window");
  assert.equal(settingsWith({ SUBTITLES_CHUNK_SECONDS: "100000" }).subtitlesChunkSeconds, 900, "a typo");
});

test("junk falls back to the default rather than to NaN", () => {
  assert.equal(settingsWith({ SUBTITLES_CHUNK_SECONDS: "half a minute" }).subtitlesChunkSeconds, 30);
  assert.equal(settingsWith({ SUBTITLES_CHUNK_SECONDS: "" }).subtitlesChunkSeconds, 30);
});

test("the documented settings table states the default the code actually uses", async () => {
  // The full configuration table is the reference; the README is the short page and links to it.
  const reference = await readFile(new URL("../AGENTS.md", import.meta.url), "utf8");
  const row = /^\|\s*`SUBTITLES_CHUNK_SECONDS`\s*\|\s*`(\d+)`/m.exec(reference);
  assert.ok(row, "the variable is in the reference's settings table");
  assert.equal(Number(row[1]), DEFAULT_SUBTITLES_CHUNK_SECONDS);
});
