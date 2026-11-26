// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/** What the processing card says, without drawing it. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { cardText, clock, SPLASH_RE, splashArgs } from "../src/streams/splash.js";

test("a clock reads as minutes and seconds, and as hours when it has to", () => {
  assert.equal(clock(0), "0:00");
  assert.equal(clock(228_665), "3:49");
  assert.equal(clock(3_432_884), "57:13");
  assert.equal(clock(7_200_000), "2:00:00");
});

test("the card names the windows it is cutting, in the order they are cut", () => {
  const text = cardText({
    segments: 12,
    windows: [
      { type: "intro", startMs: 230_665, endMs: 244_498 },
      { type: "credits", startMs: 3_434_884, endMs: null },
    ],
    pass: 1,
    passes: 2,
  });
  assert.equal(text.title, "Processing…");
  assert.equal(text.subtitle, "TheIntroDB is currently cutting the segments from your stream");
  assert.equal(text.count, "2 segments", "the two windows are the two segments being cut");
  assert.ok(
    text.windows.startsWith("Intro 3:51-4:04  ·  Credits 57:15-end"),
    `windows line: ${text.windows}`,
  );
  assert.ok(text.windows.includes("(1/2)"), "and it says which of the stretches is being written");
  // A window that runs to the end of the file says so rather than naming a time it does not have.
  assert.ok(
    text.windows.includes("Credits 57:15-end"),
    "a window with no end says so rather than inventing one",
  );
  assert.equal(text.footer, "Go to theintrodb.org to submit or report incorrect segments");
});

test("the count reads naturally, and counts what the card lists", () => {
  const one = cardText({
    segments: 0,
    windows: [{ type: "intro", startMs: 0, endMs: 30_000 }],
    pass: 1,
    passes: 1,
  });
  assert.equal(one.count, "1 segment");
  // Nothing written yet, so the ticker is empty while the count still says what is coming.
  assert.equal(one.windows.endsWith("·"), false);
  const later = cardText({
    segments: 4,
    windows: [{ type: "intro", startMs: 0, endMs: 30_000 }],
    pass: 1,
    passes: 1,
  });
  assert.equal(later.count, "1 segment", "the count does not change as the work goes on");
  assert.ok(later.windows.endsWith("····"), "the ticker is what moves");
});

test("the pieces are drawn from text files, not from filter arguments", () => {
  // A colon cannot be passed through a filter graph at all, so the card's lines are files.
  const args = splashArgs("/tmp/x/splash00000.ts", 0, 10, "/tmp/x");
  const graph = args[args.indexOf("-filter_complex") + 1]!;
  assert.ok(graph.includes("textfile=/tmp/x/card.title.txt"));
  assert.ok(graph.includes("card.footer.txt"));
  assert.ok(!/text=[^f]/.test(graph), "no text= argument anywhere");
  // Each piece is offset onto one shared clock, or a player loops on the pieces.
  assert.equal(args[args.indexOf("-output_ts_offset") + 1], "0.000");
  const second = splashArgs("/tmp/x/splash00001.ts", 10, 10, "/tmp/x");
  assert.equal(second[second.indexOf("-output_ts_offset") + 1], "10.000");
  assert.ok(SPLASH_RE.test("splash00001.ts"));
  assert.ok(!SPLASH_RE.test("splash1.ts"));
});
