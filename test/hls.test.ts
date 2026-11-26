// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

import assert from "node:assert/strict";
import test from "node:test";

import {
  absoluteUri,
  isMasterPlaylist,
  parseMediaPlaylist,
  rewriteMasterPlaylist,
  spliceMediaPlaylist,
  type UriRewriters,
} from "../src/streams/hls.js";

const identity: UriRewriters = {
  playlistUri: (uri) => uri,
  resourceUri: (uri) => uri,
};

/** `count` segments of `duration` seconds, 0-based, relative URIs. */
function playlist(count: number, duration = 6, options: { map?: boolean } = {}): string {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:6", `#EXT-X-TARGETDURATION:${duration}`];
  if (options.map) lines.push('#EXT-X-MAP:URI="init.mp4"');
  for (let index = 0; index < count; index++) {
    lines.push(`#EXTINF:${duration.toFixed(3)},`, `seg${index}.ts`);
  }
  lines.push("#EXT-X-ENDLIST");
  return `${lines.join("\n")}\n`;
}

const base = "https://cdn.example/show/index.m3u8";

function uris(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

test("a media playlist splits into header, segments and trailer", () => {
  const parsed = parseMediaPlaylist(playlist(3));
  assert.ok(parsed);
  assert.deepEqual(parsed.header, ["#EXTM3U", "#EXT-X-VERSION:6", "#EXT-X-TARGETDURATION:6"]);
  assert.deepEqual(parsed.trailer, ["#EXT-X-ENDLIST"]);
  assert.equal(parsed.segments.length, 3);
  assert.equal(parsed.durationMs, 18000);
  assert.deepEqual(
    parsed.segments.map((segment) => [segment.startMs, segment.endMs, segment.durationMs]),
    [
      [0, 6000, 6000],
      [6000, 12000, 6000],
      [12000, 18000, 6000],
    ],
  );
});

test("anything that is not a playlist parses to null", () => {
  assert.equal(parseMediaPlaylist(""), null);
  assert.equal(parseMediaPlaylist("<html></html>"), null);
  assert.equal(parseMediaPlaylist("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n"), null);
  assert.equal(isMasterPlaylist("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n"), true);
});

test("no windows means the playlist is returned byte-identical", () => {
  const source = playlist(4);
  const result = spliceMediaPlaylist(source, { baseUrl: base, windows: [], rewriters: identity });
  assert.ok(result);
  assert.equal(result.text, source);
  assert.equal(result.changed, false);
  assert.equal(result.droppedSegments, 0);
});

test("a window drops every segment it overlaps, and marks the jump", () => {
  const parsed = parseMediaPlaylist(playlist(10))!;
  const windows = [{ type: "intro" as const, startMs: 22800, endMs: 25000 }];

  const result = spliceMediaPlaylist(playlist(10, 6), {
    baseUrl: base,
    windows,
    rewriters: identity,
  })!;

  // Segments 3 (18-24s) and 4 (24-30s) overlap [22.8, 25.0).
  assert.equal(result.droppedSegments, 2);
  assert.equal(result.droppedMs, 12000);
  assert.equal(parsed.durationMs, 60000);
  assert.deepEqual(uris(result.text), [
    `${base.replace("index.m3u8", "")}seg0.ts`,
    `${base.replace("index.m3u8", "")}seg1.ts`,
    `${base.replace("index.m3u8", "")}seg2.ts`,
    `${base.replace("index.m3u8", "")}seg5.ts`,
    `${base.replace("index.m3u8", "")}seg6.ts`,
    `${base.replace("index.m3u8", "")}seg7.ts`,
    `${base.replace("index.m3u8", "")}seg8.ts`,
    `${base.replace("index.m3u8", "")}seg9.ts`,
  ]);
  assert.equal(result.text.split("#EXT-X-DISCONTINUITY").length - 1, 1);
  assert.ok(result.text.includes("#EXT-X-ENDLIST"));
  // The header survives the cut: a player still needs the target duration.
  assert.ok(result.text.startsWith("#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:6\n"));
});

test("zero tolerance: a segment overlapping the window by a millisecond is dropped", () => {
  const result = spliceMediaPlaylist(playlist(3), {
    baseUrl: base,
    windows: [{ type: "intro", startMs: 11999, endMs: 12001 }],
    rewriters: identity,
  })!;
  assert.equal(result.droppedSegments, 2); // 6-12s and 12-18s
  assert.deepEqual(uris(result.text), ["https://cdn.example/show/seg0.ts"]);
});

test("dropping from the start needs no discontinuity; dropping from the end keeps every earlier segment", () => {
  const head = spliceMediaPlaylist(playlist(4), {
    baseUrl: base,
    windows: [{ type: "recap", startMs: 0, endMs: 12500 }],
    rewriters: identity,
  })!;
  assert.equal(head.droppedSegments, 3);
  assert.equal(head.text.includes("#EXT-X-DISCONTINUITY"), false);
  assert.deepEqual(uris(head.text), ["https://cdn.example/show/seg3.ts"]);

  const tail = spliceMediaPlaylist(playlist(4), {
    baseUrl: base,
    windows: [{ type: "credits", startMs: 10000, endMs: null }],
    rewriters: identity,
  })!;
  assert.equal(tail.droppedSegments, 3);
  assert.ok(tail.text.includes("#EXT-X-ENDLIST"));
  // The cut runs to the end of the file: there is nothing after it to mark.
  assert.equal(tail.text.split("#EXT-X-DISCONTINUITY").length - 1, 0);
  assert.deepEqual(uris(tail.text), ["https://cdn.example/show/seg0.ts"]);
});

test("windows that start past the end of the playlist are ignored", () => {
  const source = playlist(4);
  const result = spliceMediaPlaylist(source, {
    baseUrl: base,
    windows: [{ type: "credits", startMs: 3432884, endMs: null }],
    rewriters: identity,
  })!;
  assert.equal(result.changed, false);
  assert.equal(result.text, source);
});

test("a window that would remove everything is refused rather than served empty", () => {
  const source = playlist(3);
  const result = spliceMediaPlaylist(source, {
    baseUrl: base,
    windows: [{ type: "recap", startMs: 0, endMs: 60000 }],
    rewriters: identity,
  })!;
  assert.equal(result.degenerate, true);
  assert.equal(result.changed, false);
  assert.equal(result.text, source);
});

test("forceRewrite re-points every URI without dropping anything", () => {
  const source = playlist(2);
  const result = spliceMediaPlaylist(source, {
    baseUrl: base,
    windows: [],
    rewriters: {
      playlistUri: (uri) => uri,
      resourceUri: (uri) => `https://worker.example/seg?u=${encodeURIComponent(uri)}`,
    },
    forceRewrite: true,
  })!;
  assert.equal(result.changed, true);
  assert.equal(result.droppedSegments, 0);
  assert.deepEqual(uris(result.text), [
    "https://worker.example/seg?u=https%3A%2F%2Fcdn.example%2Fshow%2Fseg0.ts",
    "https://worker.example/seg?u=https%3A%2F%2Fcdn.example%2Fshow%2Fseg1.ts",
  ]);
});

test("an init segment declared in the header survives leading cuts", () => {
  const source = playlist(3, 6, { map: true });
  const result = spliceMediaPlaylist(source, {
    baseUrl: base,
    windows: [{ type: "intro", startMs: 0, endMs: 7000 }],
    rewriters: identity,
  })!;
  assert.equal(result.droppedSegments, 2);
  assert.ok(result.text.includes('#EXT-X-MAP:URI="https://cdn.example/show/init.mp4"'));
  assert.deepEqual(uris(result.text), ["https://cdn.example/show/seg2.ts"]);
});

test("an init segment carried by a dropped segment is re-emitted after the jump", () => {
  const source = [
    "#EXTM3U",
    "#EXTINF:6.000,",
    "seg0.ts",
    '#EXT-X-MAP:URI="init2.mp4"',
    "#EXTINF:6.000,",
    "seg1.ts",
    "#EXTINF:6.000,",
    "seg2.ts",
    "",
  ].join("\n");
  const result = spliceMediaPlaylist(source, {
    baseUrl: base,
    windows: [{ type: "intro", startMs: 6000, endMs: 11999 }],
    rewriters: identity,
  })!;
  const lines = result.text.split("\n");
  const discontinuity = lines.indexOf("#EXT-X-DISCONTINUITY");
  assert.ok(discontinuity >= 0);
  assert.equal(lines[discontinuity + 1], '#EXT-X-MAP:URI="https://cdn.example/show/init2.mp4"');
  assert.equal(lines[discontinuity + 2], "#EXTINF:6.000,");
  assert.equal(lines[discontinuity + 3], "https://cdn.example/show/seg2.ts");
});

test("a discontinuity from the source is kept when the segments around it are cut", () => {
  const source = [
    "#EXTM3U",
    "#EXTINF:6.000,",
    "seg0.ts",
    "#EXT-X-DISCONTINUITY",
    "#EXTINF:6.000,",
    "seg1.ts",
    "",
  ].join("\n");
  const result = spliceMediaPlaylist(source, {
    baseUrl: base,
    windows: [{ type: "intro", startMs: 0, endMs: 1 }],
    rewriters: identity,
  })!;
  assert.equal(result.droppedSegments, 1);
  assert.deepEqual(uris(result.text), ["https://cdn.example/show/seg1.ts"]);
  assert.ok(result.text.includes("#EXT-X-DISCONTINUITY"));
});

test("byte ranges keep pointing at the same bytes when a segment is dropped", () => {
  const source = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    "#EXT-X-TARGETDURATION:4",
    '#EXT-X-MAP:URI="init.mp4"',
    "#EXTINF:4.000,",
    "#EXT-X-BYTERANGE:1000@0",
    "file.mp4",
    "#EXTINF:4.000,",
    "#EXT-X-BYTERANGE:1000",
    "file.mp4",
    "#EXTINF:4.000,",
    "#EXT-X-BYTERANGE:1000",
    "file.mp4",
    "#EXTINF:4.000,",
    "#EXT-X-BYTERANGE:1000",
    "file.mp4",
    "#EXT-X-ENDLIST",
    "",
  ].join("\n");

  const result = spliceMediaPlaylist(source, {
    baseUrl: base,
    windows: [{ type: "intro", startMs: 4000, endMs: 7999 }],
    rewriters: identity,
  })!;

  assert.equal(result.droppedSegments, 1);
  // The implicit offsets are resolved against the ORIGINAL sequence, so the
  // surviving ranges still address the right bytes of the same file.
  assert.deepEqual(
    result.text.split("\n").filter((line) => line.startsWith("#EXT-X-BYTERANGE")),
    ["#EXT-X-BYTERANGE:1000@0", "#EXT-X-BYTERANGE:1000@2000", "#EXT-X-BYTERANGE:1000@3000"],
  );
});

test("URI attributes of keys and maps are resolved against the playlist URL", () => {
  const source = [
    "#EXTM3U",
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x1',
    '#EXT-X-MAP:URI="init.mp4"',
    "#EXTINF:6.000,",
    "seg0.ts",
    "",
  ].join("\n");
  const result = spliceMediaPlaylist(source, {
    baseUrl: base,
    windows: [],
    rewriters: identity,
    forceRewrite: true,
  })!;
  assert.ok(result.text.includes('URI="https://cdn.example/show/key.bin"'));
  assert.ok(result.text.includes('URI="https://cdn.example/show/init.mp4"'));
});

test("a master playlist sends its variants and renditions back through the addon", () => {
  const source = [
    "#EXTM3U",
    "#EXT-X-VERSION:6",
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",URI="audio/eng.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720,AUDIO="aud"',
    "720p/video.m3u8",
    '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100000,URI="720p/iframe.m3u8"',
    '#EXT-X-SESSION-KEY:METHOD=AES-128,URI="key.bin"',
    "",
  ].join("\n");

  const rewriters: UriRewriters = {
    playlistUri: (uri) => `https://worker.example/play?u=${encodeURIComponent(uri)}`,
    resourceUri: (uri) => uri,
  };
  const result = rewriteMasterPlaylist(source, base, rewriters);

  assert.ok(
    result.includes(
      `URI="https://worker.example/play?u=${encodeURIComponent("https://cdn.example/show/audio/eng.m3u8")}"`,
    ),
  );
  assert.ok(
    result.includes(
      `URI="https://worker.example/play?u=${encodeURIComponent("https://cdn.example/show/720p/iframe.m3u8")}"`,
    ),
  );
  assert.ok(
    result.includes(
      `https://worker.example/play?u=${encodeURIComponent("https://cdn.example/show/720p/video.m3u8")}`,
    ),
  );
  // A session key is a media resource, not a playlist: absolutised, not routed.
  assert.ok(
    result.includes('#EXT-X-SESSION-KEY:METHOD=AES-128,URI="https://cdn.example/show/key.bin"'),
  );
});

test("absolute URIs are left alone", () => {
  assert.equal(absoluteUri("https://other.example/a.ts", base), "https://other.example/a.ts");
  assert.equal(absoluteUri("seg0.ts?x=1", base), "https://cdn.example/show/seg0.ts?x=1");
  assert.equal(absoluteUri("/root.ts", base), "https://cdn.example/root.ts");
});
