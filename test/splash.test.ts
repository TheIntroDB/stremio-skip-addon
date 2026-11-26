// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/** What the processing card says, without drawing it. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { cardText, clock, SPLASH_RE, splashArgs } from "../src/streams/splash.js";
import { placeholderAudio } from "../src/streams/streaminfo.js";

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
  // No "(1/2)": those are the packager's two kept stretches, not two segments being removed, and it
  // read as though the same intro were being cut twice.
  assert.ok(!/\(\d+\/\d+\)/.test(text.windows), "and no counter of stretches nobody can see");
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
  // No ticker: a stray "·" at the end of the line read as a typo, and nothing on the card moves now.
  assert.equal(one.windows, "Intro 0:00-0:30");
  const later = cardText({
    segments: 4,
    windows: [{ type: "intro", startMs: 0, endMs: 30_000 }],
    pass: 1,
    passes: 1,
  });
  assert.equal(later.count, "1 segment", "the count does not change as the work goes on");
  assert.equal(later.windows, "Intro 0:00-0:30", "and it reads the same however much has been cut");
});

test("the finished card says what went and where the film starts", () => {
  // The card is not thrown away once the film can play: it is replaced, in place, by one that says
  // what happened. "Processing…" over an episode that was cut days ago is a lie, and the pre-roll
  // the first viewing sat through is exactly where the film begins on the timeline.
  const text = cardText({
    segments: 0,
    windows: [{ type: "intro", startMs: 230_665, endMs: 244_498 }],
    pass: 1,
    passes: 1,
    state: "done",
    waitMs: 10_000,
  });
  assert.equal(text.title, "Segments removed");
  assert.equal(text.subtitle, "Video starts at 0:10");
  assert.equal(text.count, "1 segment");
  assert.equal(text.windows, "Intro 3:51-4:04", "no ticker: the work is over");
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

test("a placeholder speaks the film's audio codec, so a player never changes decoder", () => {
  // hls.js builds its audio buffer from the first segment it parses: silent AAC in front of an E-AC-3
  // film hands it an AAC buffer and the film's sound is then refused -- picture, no audio.
  assert.equal(placeholderAudio({ codec: "eac3" }), "eac3");
  assert.equal(placeholderAudio({ codec: "ac3" }), "ac3");
  assert.equal(placeholderAudio({ codec: "aac" }), "aac");
  assert.equal(placeholderAudio({ codec: "dts" }), "aac", "anything unencodable falls back to AAC");
  assert.equal(placeholderAudio(null), "aac");
  // And the encoder it names is the one ffmpeg is given.
  const args = splashArgs("/tmp/x/splash00000.ts", 0, 2, "/tmp/x", "eac3");
  assert.equal(args[args.indexOf("-c:a") + 1], "eac3");
});

test("the card carries the out-of-date notice, and nothing when it is current", () => {
  // The viewer is the person who would update this deployment, so the card is where it goes -- but only
  // when there is something to say: an empty line would be a gap between the windows and the footer.
  const card = {
    segments: 0,
    windows: [{ type: "intro" as const, startMs: 60_000, endMs: 90_000 }],
    pass: 1,
    passes: 2,
  };
  const current = cardText(card);
  assert.equal(current.notice, "", "a current deployment says nothing");
  assert.equal(
    splashArgs("/tmp/x/splash00000.ts", 0, 2, "/tmp/x", "aac", null).some((arg) =>
      arg.includes("card.notice.txt"),
    ),
    false,
    "and it is not drawn",
  );

  const behind = cardText({ ...card, notice: "This addon is out of date — v0.2.0 is available" });
  assert.equal(behind.notice, "This addon is out of date — v0.2.0 is available");
  const args = splashArgs("/tmp/x/splash00000.ts", 0, 2, "/tmp/x", "aac", behind.notice);
  const graph = args[args.indexOf("-filter_complex") + 1] ?? "";
  assert.ok(graph.includes("card.notice.txt"), "the line is drawn on the card");
  assert.ok(graph.includes("0xF5B60A"), "in the accent colour, not the grey of the rest");
  assert.ok(
    graph.indexOf("card.notice.txt") < graph.indexOf("card.footer.txt"),
    "above the footer",
  );
});
