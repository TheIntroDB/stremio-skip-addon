// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * End-to-end tests: the real Worker entry point, driven over HTTP, against a stub
 * source addon, a stub HLS origin and a stub TheIntroDB API that answers with the
 * figures measured from the live API for Breaking Bad S1E1 (2026-11-24:
 * intro 228665-246498, credits 3432884 to the end of the file).
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

import { resetMemoryCache } from "../src/cache.js";
import { encodeConfig } from "../src/config.js";
import { INTRODB_API_BASE } from "../src/constants.js";
import { PackageEngine } from "../src/packages.js";
import type { Settings } from "../src/env.js";
import { handleRequest } from "../src/index.js";
import type { SegmentType } from "../src/types.js";

let server: Server;
let base = "";
let amplified = "";
let rotatingTokens = 0;
let apiUserAgents: string[] = [];
let proxyConfig = "";
/** The same install, but one that packages files too. */
let cutConfig = "";
const apiCalls = new Map<string, number>();
/** Every path the stub was asked for, so a test can prove nothing was fetched. */
const hits = new Map<string, number>();

const SEGMENT_SECONDS = 6;
const LONG_PLAYLIST_SEGMENTS = 600; // 3600s, long enough for both real windows
const SHORT_PLAYLIST_SEGMENTS = 30; // 180s

/** Media body for one title. */
function mediaBody(entry: unknown): string {
  return JSON.stringify(entry);
}

const BREAKING_BAD_S1E1 = mediaBody({
  tvdb_id: 81189,
  type: "tv",
  season: 1,
  episode: 1,
  intro: [{ start_ms: 228665, end_ms: 246498 }],
  credits: [{ start_ms: 3432884, end_ms: null }],
});

/** A movie whose credits start 2:18:20 in, matching the live tt0111161 answer. */
const SHAWSHANK = mediaBody({
  tvdb_id: 190,
  type: "movie",
  credits: [{ start_ms: 8300000, end_ms: null }],
  intro: [{ start_ms: 60000, end_ms: 90000 }],
});

function mediaPlaylistBody(count: number): string {
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:6",
    `#EXT-X-TARGETDURATION:${SEGMENT_SECONDS}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
  ];
  for (let index = 0; index < count; index++) {
    lines.push(`#EXTINF:${SEGMENT_SECONDS}.000,`, `seg${index}.ts`);
  }
  lines.push("#EXT-X-ENDLIST");
  return `${lines.join("\n")}\n`;
}

function masterPlaylistBody(): string {
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:6",
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",DEFAULT=YES,URI="audio/eng.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720,AUDIO="aud"',
    "720p/video.m3u8",
    '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100000,URI="720p/iframe.m3u8"',
    "",
  ].join("\n");
}

function streamsBody(): string {
  return JSON.stringify({
    streams: [
      {
        name: "StubSource",
        title: "Some.Release.1080p.WEB",
        url: `${base}/hls/master.m3u8`,
      },
      {
        name: "StubSource",
        title: "Another.Release.2160p",
        url: "/hls/movie.mp4", // relative on purpose: it must be resolved against the addon
      },
      { name: "StubSource", title: "Torrent release", infoHash: "abcdef", fileIdx: 0 },
      {
        name: "StubSource",
        title: "Header gated release",
        url: `${base}/hls/media.m3u8`,
        behaviorHints: { proxyHeaders: { request: { Referer: "https://example.com" } } },
      },
    ],
  });
}

function send(
  response: import("node:http").ServerResponse,
  status: number,
  body: string,
  contentType: string,
): void {
  response.writeHead(status, { "content-type": contentType, "content-length": Buffer.byteLength(body) });
  response.end(body);
}

before(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);

    if (path === "/api/v4/media") {
      apiUserAgents.push(request.headers["user-agent"] ?? "");
      const id = url.searchParams.get("imdb_id") ?? "";
      const season = url.searchParams.get("season") ?? "-";
      const episode = url.searchParams.get("episode") ?? "-";
      const key = `${id}:${season}:${episode}`;
      apiCalls.set(key, (apiCalls.get(key) ?? 0) + 1);

      if (id === "tt0903747") return send(response, 200, BREAKING_BAD_S1E1, "application/json");
      if (id === "tt0111161") return send(response, 200, SHAWSHANK, "application/json");
      if (id === "tt0000001") {
        return send(
          response,
          404,
          JSON.stringify({ error: "media not found for provided imdb_id", code: "media_not_found" }),
          "application/json",
        );
      }
      if (id === "tt0000002") return send(response, 429, JSON.stringify({ code: "rate_limit_exceeded" }), "application/json");
      if (id === "tt0000003") {
        // What a proxy in front of the API does to an address it has blocked.
        return send(response, 403, "<html>Sorry, you have been blocked</html>", "text/html");
      }
      return send(response, 500, JSON.stringify({ code: "internal" }), "application/json");
    }

    if (path === "/upstream/manifest.json") {
      return send(
        response,
        200,
        JSON.stringify({
          id: "org.example.stub",
          version: "1.0.0",
          name: "Stub Source",
          resources: ["stream"],
          types: ["movie", "series"],
          idPrefixes: ["tt"],
        }),
        "application/json",
      );
    }

    if (path.startsWith("/upstream/stream/")) {
      return send(response, 200, streamsBody(), "application/json");
    }

    // A source that only routes the percent-encoded episode id, like Stremio sends.
    if (path.startsWith("/upstream-encoded/stream/")) {
      if (path.includes("%3A")) return send(response, 200, streamsBody(), "application/json");
      return send(response, 400, JSON.stringify({ error: "id must be encoded" }), "application/json");
    }

    if (path === "/hls/master.m3u8") {
      return send(response, 200, masterPlaylistBody(), "application/vnd.apple.mpegurl");
    }
    if (path === "/hls/720p/video.m3u8" || path === "/hls/media.m3u8" || path === "/hls/odd") {
      // `/hls/odd` is served with a content type that does not say "playlist".
      const contentType = path === "/hls/odd" ? "application/octet-stream" : "application/vnd.apple.mpegurl";
      return send(response, 200, mediaPlaylistBody(LONG_PLAYLIST_SEGMENTS), contentType);
    }
    if (path === "/hls/media-short.m3u8" || path === "/hls/audio/eng.m3u8") {
      return send(response, 200, mediaPlaylistBody(SHORT_PLAYLIST_SEGMENTS), "application/vnd.apple.mpegurl");
    }
    if (path === "/hls/key.bin" || path === "/hls/init.mp4") {
      return send(response, 200, "BINARY", "application/octet-stream");
    }
    if (path === "/hls/movie.mp4" || path === "/blob") {
      return send(response, 200, "NOT-A-PLAYLIST-AT-ALL".padEnd(64, "."), "application/octet-stream");
    }
    if (path === "/rotating/manifest.json") {
      return send(response, 200, JSON.stringify({
        id: "org.rotating", version: "1.0.0", name: "Rotating", resources: ["stream"],
        types: ["series"], idPrefixes: ["tt"],
      }), "application/json");
    }
    if (path.startsWith("/rotating/stream/")) {
      // A fresh token in the path on every request, exactly like a debrid source.
      rotatingTokens += 1;
      return send(response, 200, JSON.stringify({
        streams: [
          { name: "Comet 2160p", title: "Some.Release.2160p.WEB", url: `/playback/token-${rotatingTokens}` },
          { name: "Comet 1080p", title: "Some.Release.1080p.WEB", url: `/playback/token-${rotatingTokens}-b` },
        ],
      }), "application/json");
    }
    if (path === "/echo") {
      // Answers with what it was asked for, so a forwarded range header is visible.
      return send(response, 200, `range=${request.headers.range ?? "none"}`, "text/plain");
    }
    if (/^\/hls\/seg\d+\.ts$/.test(path)) {
      return send(response, 200, "SEGMENT-BYTES", "video/mp2t");
    }

    send(response, 404, "nope", "text/plain");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;

  // The API host is a constant in src/constants.ts, not a binding, so the only way
  // to answer it deterministically is to stand in front of the network: requests to
  // the real API base are redirected to the stub, everything else is untouched.
  const realFetch = globalThis.fetch;
  type FetchInput = Parameters<typeof fetch>[0];
  globalThis.fetch = ((input: FetchInput, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith(INTRODB_API_BASE)) {
      return realFetch(url.replace(INTRODB_API_BASE, `${base}/api`), init);
    }
    return realFetch(input, init);
  }) as typeof fetch;

  // Built once the stub is listening: the config is packed into the URL, so the
  // source base has to be the real port.
  //
  // The fixture install only splices playlists (`cuts: "hls"`), so the relay and playlist
  // tests below are not racing a package being built. Tests that exercise packaging build
  // their own link with `cuts: "mkv"` -- the mode is per install, so that is where it belongs.
  const config = {
    src: [`${base}/upstream`],
    types: ["intro", "recap", "credits"] as SegmentType[],
    cuts: "hls" as const,
  };
  amplified = encodeConfig(config);
  // Proxying comes from the deployment now (see testSettings), so this is just a config.
  proxyConfig = encodeConfig({ ...config });
  cutConfig = encodeConfig({ ...config, cuts: "mkv" });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  relaying = true;
  resetMemoryCache();
  apiCalls.clear();
  hits.clear();
});

/**
 * Whether these tests describe a relaying deployment (the default) or one with `PROXY=off`,
 * where the player fetches segments and files from the source. The behaviour differs by mode --
 * a URI is rewritten to this service or left pointing at the source -- so this exists to make
 * that explicit rather than incidental.
 */
let relaying = true;

function testSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    TIDB_API_KEY: "test-key",
    ALLOW_PRIVATE_HOSTS: "1",
    port: 0,
    cacheDir: path.join(tmpdir(), "tidb-addon-test-cache"),
    cacheMaxBytes: 0,
    // Whether files are packaged is the install's choice, not the deployment's: a link that
    // says `cuts: "hls"` never copies anything. The package engine has its own suite, which
    // runs real ffmpeg (test/packages.test.ts).
    // The production default: the sources people use are debrid files, so everything is relayed.
    proxy: relaying,
subtitles: false,
subtitlesLanguage: "en",
subtitlesChunkSeconds: 300,
subtitlesTtlHours: 24,
    skipMarginSeconds: 0,
    splash: false,
    prerollSeconds: 10,
    cutWaitSeconds: 0,
    cutConcurrency: 1,
    precutSources: 2,
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
    ...overrides,
  };
}

async function call(
  path: string,
  settings: Settings = testSettings(),
  init?: RequestInit,
  packages?: PackageEngine,
): Promise<Response> {
  return handleRequest(
    new Request(`https://worker.example${path}`, init),
    settings,
    packages ?? new PackageEngine(settings),
  );
}

function playPath(target: string, id: string, encoded = amplified): string {
  return `/${encoded}/play?u=${encodeURIComponent(target)}&id=${encodeURIComponent(id)}`;
}

function segmentNumbers(text: string): number[] {
  return text
    .split("\n")
    .map((line) => /\/seg(\d+)\.ts$/.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]));
}

test("the Worker serves a config page, a health check and a bare manifest", async () => {
  const page = await call("/");
  assert.equal(page.status, 200);
  const body = await page.text();
  assert.ok(body.includes("TheIntroDB Skip"));
  assert.ok(body.includes("https://worker.example"));
  assert.ok(body.includes("your-aiostreams.example.com"));

  const health = await call("/health");
  assert.equal(health.status, 200);
  const healthBody = (await health.json()) as Record<string, unknown>;
  assert.equal(healthBody.status, "ok");
  assert.equal(healthBody.name, "TheIntroDB Skip");
  assert.equal(healthBody.version, "1.0.0");
  assert.equal(healthBody.api, "https://api.theintrodb.org/v4/media");
  assert.equal(healthBody.site, "https://theintrodb.org");
  assert.equal(healthBody.apiKeyConfigured, true);
  // No deployment-wide cutting mode: it is the install's choice, and /health does not report one.
  assert.equal(healthBody.cuts, undefined, "the cutting mode is per install, not a deployment setting");
  assert.ok(healthBody.cutsStatus);

  // The page knows whether this deployment has a key, and says so.
  assert.ok(body.includes('"serverKeyConfigured":true'));
  const keylessPage = await call("/", testSettings({ TIDB_API_KEY: "" }));
  assert.ok((await keylessPage.text()).includes('"serverKeyConfigured":false'));

  // The instance panel is filled in by script, so the data it reads has to be in the
  // page: a field rename that missed the script would show "undefined" to the user.
  const data = /<script id="config-data" type="application\/json">(.*?)<\/script>/s.exec(body)?.[1];
  assert.ok(data, "the page carries its data blob");
  const parsed = JSON.parse(data.replace(/\\u003c/g, "<")) as { cuts: Record<string, unknown> };
  for (const field of ["available", "cacheDir", "cacheMaxGb", "cutConcurrency"]) {
    assert.ok(field in parsed.cuts, `the page's cut data has ${field}`);
  }
  assert.ok(!body.includes('id="proxy"'), "relaying is a deployment setting, not an install one");
  // The cutting mode is a per-install choice, so the page has to offer it.
  assert.match(body, /<select id="cuts">/);
  // Two choices, not three: cut files with no playlist as well, or only splice playlists.
  for (const mode of ["mkv", "hls"]) {
    assert.ok(body.includes(`value="${mode}"`), `the page offers the ${mode} mode`);
  }
  assert.ok(body.includes('"cuts":{"proxy"'), "the page reports the deployment's own settings");
  assert.equal(parsed.cuts.mode, undefined, "and no cutting mode: that belongs to the install");
  assert.ok(body.includes('"skipMarginSeconds":0'), "including its margin");
  assert.match(body, /<select id="margin"><\/select>/, "the page offers the margin as a dropdown");
  for (const id of ["cuts-mode", "cuts-cache", "cuts-margin", "cuts-ffmpeg", "api", "origin"]) {
    assert.ok(body.includes(`id="${id}"`), `the page has the #${id} element the script writes to`);
  }

  const bare = await call("/manifest.json");
  const manifest = (await bare.json()) as { behaviorHints: Record<string, unknown>; id: string };
  assert.equal(manifest.behaviorHints.configurationRequired, true);
  assert.equal(manifest.id, "org.theintrodb.stremio.skip");

  const robots = await call("/robots.txt");
  assert.equal(await robots.text(), "User-agent: *\nDisallow: /\n");
});

test("an install URL opens the settings for that install, not a not-found page", async () => {
  // The whole configuration lives in the path, so this is the link back to the
  // settings that produced an install: it has to come back with them in the form.
  const response = await call(`/${amplified}/`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store", "an install link is not cacheable");
  const body = await response.text();

  const blob = /<script id="config-data" type="application\/json">(.*?)<\/script>/s.exec(body)?.[1];
  assert.ok(blob, "the page carries its data blob");
  const data = JSON.parse(blob.replace(/\\u003c/g, "<")) as {
    config: { src: string[]; types: string[] } | null;
    configError: string | null;
  };
  assert.equal(data.configError, null);
  assert.deepEqual(data.config?.src, [`${base}/upstream`]);
  assert.deepEqual(data.config?.types, ["intro", "recap", "credits"]);
  assert.ok(body.includes('id="notice"'), "the page has somewhere to say this is an install");
  assert.ok(body.includes("You are editing an install"), "and it says so");

  // Without an install URL there is nothing to restore, and the page may be cached.
  const bare = await call("/");
  assert.equal(bare.headers.get("cache-control"), "public, max-age=300");
  assert.ok(!(await bare.text()).includes('"config":{'));

  // A series request without a route is unchanged: this is only about the bare path.
  const routed = await call(`/${amplified}/manifest.json`);
  assert.equal(routed.headers.get("content-type")?.startsWith("application/json"), true);
});

test("an install link with a character lost explains itself", async () => {
  // Long enough to be an install link (a real one is hundreds of characters), so it
  // gets an explanation rather than a 404 -- and a short path is still a 404.
  const response = await call("/" + "z".repeat(60) + "/");
  assert.equal(response.status, 200);
  const body = await response.text();
  const blob = /<script id="config-data" type="application\/json">(.*?)<\/script>/s.exec(body)?.[1] ?? "";
  const data = JSON.parse(blob.replace(/\\u003c/g, "<")) as { config: unknown; configError: string | null };
  assert.equal(data.config, null);
  assert.match(String(data.configError), /could not be read/);
  // It still serves the page, so the form below it can build a fresh install.
  assert.ok(body.includes('id="sources"'));
});

test("a configured manifest is a stream addon keyed by config", async () => {
  const response = await call(`/${amplified}/manifest.json`);
  const manifest = (await response.json()) as Record<string, unknown> & {
    behaviorHints: Record<string, unknown>;
  };
  assert.deepEqual(manifest.resources, ["stream"], "a stream addon, and nothing else");
  assert.deepEqual(manifest.types, ["movie", "series"]);
  assert.deepEqual(manifest.idPrefixes, ["tt"]);
  assert.equal(manifest.behaviorHints.configurationRequired, false);
  assert.ok(String(manifest.id).startsWith("org.theintrodb.stremio.skip."));
  assert.ok(String(manifest.description).includes("intro, recap, credits"));
  assert.ok(String(manifest.description).includes("127.0.0.1"));
});

test("an episode id percent-encoded the way Stremio sends it is understood", async () => {
  // Stremio Core encodes every path component (URI_COMPONENT_ENCODE_SET), so a
  // series request arrives as tt0903747%3A1%3A1.json. A router that only matches
  // the raw form answers 400 for every episode while movies keep working.
  const encoded = await call(`/${amplified}/stream/series/tt0903747%3A1%3A1.json`);
  const plain = await call(`/${amplified}/stream/series/tt0903747:1:1.json`);
  const encodedBody = (await encoded.json()) as { streams: Array<Record<string, unknown>> };

  assert.equal(encoded.status, 200);
  assert.equal(encoded.headers.get("x-tidb-windows"), "2");
  assert.deepEqual(encodedBody, await plain.json());
  assert.equal(encodedBody.streams.length, 4);
  assert.ok(String(encodedBody.streams[0]!.url).startsWith("https://worker.example/"));
});

test("a source that only routes the percent-encoded id is retried", async () => {
  const encodedConfig = encodeConfig({
    src: [`${base}/upstream-encoded`],
    types: ["intro", "recap", "credits"] as SegmentType[],
  });
  const response = await call(`/${encodedConfig}/stream/series/tt0903747%3A1%3A1.json`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-tidb-upstream-streams"), "4");
  const body = (await response.json()) as { streams: unknown[] };
  assert.equal(body.streams.length, 4);
});

test("a stream list relays the source addon and says what will be cut", async () => {
  const response = await call(`/${amplified}/stream/series/tt0903747:1:1.json`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { streams: Array<Record<string, unknown>> };

  assert.equal(body.streams.length, 4);

  const first = body.streams[0]!;
  const playUrl = new URL(String(first.url));
  assert.equal(playUrl.origin, "https://worker.example");
  assert.equal(playUrl.pathname, `/${amplified}/play`);
  assert.equal(playUrl.searchParams.get("u"), `${base}/hls/master.m3u8`);
  assert.equal(playUrl.searchParams.get("id"), "tt0903747:1:1");
  // The release's own labels survive; the addon marks itself on `name` and puts
  // the cut list on `description`.
  assert.equal(first.name, "StubSource · TheIntroDB");
  assert.equal(first.title, "Some.Release.1080p.WEB");
  assert.equal(first.description, "TheIntroDB cuts: intro 3:48-4:06, credits 57:12-end.");

  // The torrent has no URL to rewrite: it is left as it was, plus a note.
  const torrent = body.streams[2]!;
  assert.equal(torrent.infoHash, "abcdef");
  assert.equal(torrent.name, "StubSource");
  assert.equal(torrent.url, undefined);
  assert.match(String(torrent.description), /cannot be rewired/);

  // The relative URL of the second stream is resolved against its own addon.
  const second = new URL(String(body.streams[1]!.url));
  assert.equal(second.searchParams.get("u"), `${base}/hls/movie.mp4`);

  // A stream whose source asks for custom headers is not relayed.
  const gated = body.streams[3]!;
  assert.equal(gated.url, `${base}/hls/media.m3u8`);
  assert.match(String(gated.description), /asks for custom headers/);

  assert.equal(response.headers.get("x-tidb-lookup"), "fresh");
  assert.equal(response.headers.get("x-tidb-windows"), "2");
  assert.equal(response.headers.get("x-tidb-source"), new URL(base).host);
});

test("a stream list is a menu: nothing is cut, probed or packaged for it", async () => {
  // The list is fetched moments before a playback and again every time the menu is opened, so
  // work started here is work done for streams nobody chose -- and a list that waits on a source
  // is a list that fails when that source is slow. The work belongs to the playback.
  const scheduled: string[] = [];
  const probed: string[] = [];
  const engine = new PackageEngine(testSettings());
  const realSchedule = engine.schedule.bind(engine);
  engine.schedule = ((url: string, ...rest: Parameters<typeof realSchedule> extends never ? never : unknown[]) => {
    scheduled.push(url);
    return (realSchedule as (...args: unknown[]) => unknown)(url, ...rest);
  }) as typeof engine.schedule;
  const realDuration = engine.rememberDuration.bind(engine);
  engine.rememberDuration = ((key: string, target: string) => {
    probed.push(target);
    return realDuration(key, target);
  }) as typeof engine.rememberDuration;

  const response = await call(`/${amplified}/stream/series/tt0903747:1:1.json`, testSettings(), undefined, engine);
  assert.equal(response.status, 200, "the list is served");
  const body = (await response.json()) as { streams: unknown[] };
  assert.ok(body.streams.length > 0, "with the sources on it");
  assert.deepEqual(scheduled, [], "and no package started for any of them");
  assert.deepEqual(probed, [], "and no source probed either");
});

test("a cut is keyed on the stream, not on the source's rotating link", async () => {
  // Comet mints a fresh /playback/<token> for every stream list, so a cut keyed on the
  // URL is never found again -- which is exactly how a ready cut got missed and the
  // intro played a second time. The identity that rides on the play URL has to survive.
  const config = encodeConfig({ src: [`${base}/rotating`], types: ["intro"] as SegmentType[] });

  const first = (await (await call(`/${config}/stream/series/tt0903747:1:1.json`)).json()) as {
    streams: Array<{ url: string }>;
  };
  const second = (await (await call(`/${config}/stream/series/tt0903747:1:1.json`)).json()) as {
    streams: Array<{ url: string }>;
  };

  const target = (stream: { url: string }) => new URL(stream.url).searchParams.get("u");
  const key = (stream: { url: string }) => new URL(stream.url).searchParams.get("k");

  assert.notEqual(target(first.streams[0]!), target(second.streams[0]!), "the source re-minted the link");
  assert.equal(key(first.streams[0]!), key(second.streams[0]!), "and the cut identity is unchanged");
  assert.ok(key(first.streams[0]!), "the play URL carries the identity");

  // Two different releases of the same episode are two different cuts.
  assert.notEqual(key(first.streams[0]!), key(first.streams[1]!));

  // And what the player is handed off the first list is what the second list agrees
  // with, so the warmed cut is found: the engine's key derives from the identity.
  const cuts = new PackageEngine(testSettings());
  const windows = [{ type: "intro" as const, startMs: 0, endMs: 30_000 }];
  assert.equal(
    cuts.keyFor(target(first.streams[0]!)!, windows, key(first.streams[0]!)),
    cuts.keyFor(target(second.streams[0]!)!, windows, key(second.streams[0]!)),
  );
});

test("the title TheIntroDB has no timings for is passed through untouched", async () => {
  relaying = false; // a PROXY=off deployment, not this one's default
  const response = await call(`/${amplified}/stream/series/tt0000001:1:1.json`);
  const body = (await response.json()) as { streams: Array<Record<string, unknown>> };
  assert.equal(body.streams.length, 4);
  assert.equal(body.streams[0]!.url, `${base}/hls/master.m3u8`);
  assert.equal(body.streams[1]!.url, "/hls/movie.mp4", "an untouched stream keeps what the source sent");
  assert.equal(body.streams[0]!.name, "StubSource");
  assert.equal(response.headers.get("x-tidb-lookup"), "media_not_found");
  assert.equal(response.headers.get("x-tidb-windows"), "0");
});

test("the API is told who is asking", async () => {
  // A proxy in front of the API blocks an empty user agent first, and cannot be told
  // to allow a client it cannot name.
  resetMemoryCache(); // this title may already have been looked up by an earlier test
  apiUserAgents = [];
  await call(`/${amplified}/stream/movie/tt0111161.json`);
  assert.ok(apiUserAgents.length > 0, "the lookup happened");
  for (const agent of apiUserAgents) {
    assert.match(agent, /^TIDB-stremio-skip\//);
  }
});

test("with proxying on, a title with no timings is still relayed", async () => {
  // Relay is about reachability, not cutting: a source that binds its link to the
  // requesting address stops working completely if the stream is handed over raw, so a
  // lookup that finds nothing (or fails) must cost the cut, not the playback.
  const relayed = (await (await call(`/${proxyConfig}/stream/series/tt0000001:1:1.json`)).json()) as {
    streams: Array<{ url: string; description?: string }>;
  };
  assert.equal(new URL(relayed.streams[0]!.url).origin, "https://worker.example");
  assert.match(String(relayed.streams[0]!.description), /relayed but not cut/);

  // Without proxying, a title with no timings is still handed over untouched.
  const direct = (await (
    await call(`/${amplified}/stream/series/tt0000001:1:1.json`, testSettings({ proxy: false }))
  ).json()) as {
    streams: Array<{ url: string }>;
  };
  assert.equal(direct.streams[0]!.url, `${base}/hls/master.m3u8`);
});

test("a lookup the API refuses is reported on /health", async () => {
  const blocked = await call(`/${amplified}/stream/series/tt0000003:1:1.json`);
  assert.equal(blocked.headers.get("x-tidb-lookup"), "http_403", "the header names it");

  const health = (await (await call("/health")).json()) as {
    lastLookupFailure: { reason: string; at: string } | null;
  };
  assert.equal(health.lastLookupFailure?.reason, "http_403", "/health says why nothing is being cut");
  assert.ok(health.lastLookupFailure?.at);

  // A title TheIntroDB simply has nothing for is not a failure.
  await call(`/${amplified}/stream/series/tt0000001:1:1.json`);
  const after = (await (await call("/health")).json()) as { lastLookupFailure: { reason: string } | null };
  assert.equal(after.lastLookupFailure?.reason, "http_403", "a missing title does not overwrite it");
});

test("a rate-limited lookup is passed through too, never guessed at", async () => {
  relaying = false; // a PROXY=off deployment, not this one's default
  const response = await call(`/${amplified}/stream/series/tt0000002:1:1.json`);
  const body = (await response.json()) as { streams: Array<Record<string, unknown>> };
  assert.equal(body.streams[0]!.url, `${base}/hls/master.m3u8`);
  assert.match(String(response.headers.get("x-tidb-lookup")), /^rate_limited/);
});

test("a master playlist sends its variants back through the addon", async () => {
  const response = await call(playPath(`${base}/hls/master.m3u8`, "tt0903747:1:1"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/vnd.apple.mpegurl");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(response.headers.get("x-tidb-play"), "master");

  const text = await response.text();
  const routed = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("https://worker.example"));
  assert.equal(routed.length, 1, "the variant is a bare URI line");

  // Every playlist URI in the master -- the variant, the audio rendition and the
  // trick-play playlist -- comes back to this Worker with the media id.
  const playUrls = [...text.matchAll(/https:\/\/worker\.example\/[^"\s]+/g)].map(
    (match) => new URL(match[0]),
  );
  assert.equal(playUrls.length, 3);
  assert.deepEqual(
    playUrls.map((url) => url.searchParams.get("u")).sort(),
    [
      `${base}/hls/720p/video.m3u8`,
      `${base}/hls/720p/iframe.m3u8`,
      `${base}/hls/audio/eng.m3u8`,
    ].sort(),
  );
  for (const url of playUrls) {
    assert.equal(url.pathname, `/${amplified}/play`);
    assert.equal(url.searchParams.get("id"), "tt0903747:1:1");
  }
});

test("a media playlist comes back with the intro and the credits gone", async () => {
  relaying = false; // a PROXY=off deployment, not this one's default
  const response = await call(playPath(`${base}/hls/media.m3u8`, "tt0903747:1:1"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-tidb-play"), "spliced");
  assert.equal(response.headers.get("x-tidb-cuts"), "intro 3:48-4:06, credits 57:12-end");
  assert.equal(response.headers.get("x-tidb-dropped-segments"), "32");
  assert.equal(response.headers.get("x-tidb-dropped-ms"), "192000");
  assert.equal(response.headers.get("x-tidb-duration-ms"), String(LONG_PLAYLIST_SEGMENTS * SEGMENT_SECONDS * 1000));

  const text = await response.text();
  const kept = segmentNumbers(text);

  // intro [228.665, 246.498] covers segments 38-41; credits [3432.884, end] covers 572-599.
  assert.equal(kept.length, LONG_PLAYLIST_SEGMENTS - 32);
  assert.deepEqual(kept.slice(0, 4), [0, 1, 2, 3]);
  assert.deepEqual(kept.slice(36, 42), [36, 37, 42, 43, 44, 45]);
  assert.equal(kept[kept.length - 1], 571);
  // One jump where the intro was cut; the credits cut runs to the end of the file,
  // so there is nothing after it to mark.
  assert.equal(text.split("#EXT-X-DISCONTINUITY").length - 1, 1);

  // Header, key and init segment survive, resolved to the origin.
  assert.ok(text.startsWith("#EXTM3U\n"));
  assert.ok(text.includes('#EXT-X-MAP:URI="' + base + '/hls/init.mp4"'));
  assert.ok(text.includes('#EXT-X-KEY:METHOD=AES-128,URI="' + base + '/hls/key.bin"'));
  assert.ok(text.includes("#EXT-X-ENDLIST"));
  assert.ok(text.includes(`#EXTINF:${SEGMENT_SECONDS}.000,`));
  // The segments are addressed directly: no Worker bandwidth is spent on video.
  assert.ok(!text.includes("/seg?u="));
});

test("the lookup is cached, so a second playback does not ask TheIntroDB again", async () => {
  await call(`/${amplified}/stream/series/tt0903747:1:1.json`);
  const first = await call(playPath(`${base}/hls/media.m3u8`, "tt0903747:1:1"));
  await first.text();
  const second = await call(playPath(`${base}/hls/media.m3u8`, "tt0903747:1:1"));
  await second.text();

  assert.equal(apiCalls.get("tt0903747:1:1"), 1);
  assert.equal(second.headers.get("x-tidb-lookup"), "cache_hit");
});

test("timings that do not fit the file are not applied", async () => {
  relaying = false; // a PROXY=off deployment, not this one's default
  // The movie answer has an intro inside this 3-minute playlist and credits at
  // 2:18:20, far past its end. Only the intro may be cut.
  const response = await call(playPath(`${base}/hls/media-short.m3u8`, "tt0111161"));
  const text = await response.text();
  const kept = segmentNumbers(text);

  assert.equal(response.headers.get("x-tidb-play"), "spliced");
  assert.equal(response.headers.get("x-tidb-cuts"), "intro 1:00-1:30");
  assert.equal(response.headers.get("x-tidb-dropped-segments"), "5");
  assert.equal(kept.length, SHORT_PLAYLIST_SEGMENTS - 5);
  assert.deepEqual(kept.slice(8, 12), [8, 9, 15, 16]);
  assert.equal(kept[kept.length - 1], SHORT_PLAYLIST_SEGMENTS - 1);
});

test("an install can choose its own cutting mode", async () => {
  // The choice rides in the install URL, so one deployment can serve an install that
  // always cuts and another that copies nothing.
  // A real wait window, so the assertion can see that the install's choice was used
  // (the stub's target is not a video, so generation fails fast and the wait ends).
  const settings = testSettings({ precutSources: 0, cutWaitSeconds: 5 });

  const waiting = new PackageEngine(settings);
  const waits: number[] = [];
  const realWait = waiting.waitForFirstSegment.bind(waiting);
  waiting.waitForFirstSegment = ((key: string, ms: number) => {
    waits.push(ms);
    return realWait(key, ms);
  }) as typeof waiting.waitForFirstSegment;
  const always = encodeConfig({
    src: [`${base}/upstream`],
    types: ["intro"] as SegmentType[],
    cuts: "mkv",
  });
  await call(playPath(`${base}/hls/movie.mp4`, "tt0903747:1:1", always), settings, undefined, waiting);
  assert.ok(waits.length > 0, "this install's link says cut files, so the play waited for a segment");
  assert.equal(waits[0], 5000, "and it waited the deployment's window, not zero");

  const never = new PackageEngine(settings);
  let asked = 0;
  const realSchedule = never.schedule.bind(never);
  never.schedule = ((url: string, windows: Parameters<typeof realSchedule>[1], id?: string) => {
    asked += 1;
    return realSchedule(url, windows, id);
  }) as typeof never.schedule;
  const off = encodeConfig({
    src: [`${base}/upstream`],
    types: ["intro"] as SegmentType[],
    cuts: "hls",
  });
  const response = await call(playPath(`${base}/hls/movie.mp4`, "tt0903747:1:1", off), settings, undefined, never);
  assert.equal(asked, 0, "an install that turned cutting off does not copy anything");
  assert.equal(response.headers.get("x-tidb-play"), "proxied_file");
});

test("a link that says nothing about cutting gets the default: files are cut too", async () => {
  // There is no deployment-wide mode any more, so the fallback lives in one place
  // (`DEFAULT_CUT_MODE`). A hand-built link without `cuts` has to behave like the default
  // the configuration page writes, or the two disagree about what "unset" means.
  const settings = testSettings({ precutSources: 0 });
  const engine = new PackageEngine(settings);
  const scheduled: string[] = [];
  const realSchedule = engine.schedule.bind(engine);
  engine.schedule = ((url: string, windows: Parameters<typeof realSchedule>[1], id?: string) => {
    scheduled.push(url);
    return realSchedule(url, windows, id);
  }) as typeof engine.schedule;

  const bare = encodeConfig({ src: [`${base}/upstream`], types: ["intro"] as SegmentType[] });
  await call(playPath(`${base}/hls/movie.mp4`, "tt0903747:1:1", bare), settings, undefined, engine);
  assert.equal(scheduled.length, 1, "an unset mode means cut, which is what the page's first option is");
});

test("a proxied file waits for its first segment instead of streaming the original", async () => {
  // With proxying on the streamed original used to go out immediately whatever the cutting
  // mode said, so the promise "an install that cuts files pays for it up front" was quietly
  // broken -- which looks exactly like "the intro was still there".
  const settings = testSettings({ precutSources: 0 });
  const engine = new PackageEngine(settings);
  const scheduled: string[] = [];
  const realSchedule = engine.schedule.bind(engine);
  engine.schedule = ((url: string, windows: Parameters<typeof realSchedule>[1], id?: string) => {
    scheduled.push(url);
    return realSchedule(url, windows, id);
  }) as typeof engine.schedule;

  const response = await call(
    playPath(`${base}/hls/movie.mp4`, "tt0903747:1:1", cutConfig),
    settings,
    undefined,
    engine,
  );
  assert.equal(new Set(scheduled).size, 1, "one package was asked for, once");
  assert.ok(scheduled.length >= 1, "and the ask happened before the response");
  // The stub's target is not a video, so no segment can be made: the fallback is the
  // original, proxied, and both what happened and why are visible from the headers.
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-tidb-play"), "proxied_file");
  assert.equal(response.headers.get("x-tidb-fallback"), "package_slow");
});

test("with proxying on, files are streamed through this service", async () => {
  // A source that mints a link for the address that asked for it (ElfHosted Comet,
  // any debrid) cannot be reached by the player directly: every fetch has to come from
  // here, files included.
  const file = await call(playPath(`${base}/hls/movie.mp4`, "tt0903747:1:1", proxyConfig));
  assert.equal(file.status, 200);
  assert.equal(file.headers.get("x-tidb-play"), "proxied_file");
  assert.equal(file.headers.get("x-tidb-proxy"), "streamed");
  assert.equal(file.headers.get("x-tidb-upstream-status"), "200");
  assert.equal(file.headers.get("cache-control"), "no-store", "a token-bound stream is not cacheable");
  assert.match(await file.text(), /^NOT-A-PLAYLIST-AT-ALL/);

  // A URL with no extension is what a debrid playback link looks like: still sniffed
  // (it could have been a playlist), and proxied once it is known not to be one.
  const blob = await call(playPath(`${base}/blob`, "tt0903747:1:1", proxyConfig));
  assert.equal(blob.headers.get("x-tidb-play"), "proxied_file");
  assert.match(await blob.text(), /^NOT-A-PLAYLIST-AT-ALL/);

  // A HEAD probe and a range request are answered here too, so nothing the player
  // does sends it to the source on its own address.
  const head = await call(playPath(`${base}/hls/movie.mp4`, "tt0903747:1:1", proxyConfig), testSettings(), {
    method: "HEAD",
  });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");

  const ranged = await call(playPath(`${base}/echo`, "tt0903747:1:1", proxyConfig), testSettings(), {
    headers: { range: "bytes=100-200" },
  });
  assert.equal(await ranged.text(), "range=bytes=100-200", "the range is relayed to the source");

  // The same file without proxying is still handed to the player untouched.
  const direct = await call(
    playPath(`${base}/hls/movie.mp4`, "tt0903747:1:1"),
    testSettings({ proxy: false }),
  );
  assert.equal(direct.status, 302);
  assert.equal(direct.headers.get("x-tidb-play"), "not_hls");
});

test("a progressive file is handed straight to the source", async () => {
  relaying = false; // a PROXY=off deployment, not this one's default
  const response = await call(playPath(`${base}/hls/movie.mp4`, "tt0111161"));
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), `${base}/hls/movie.mp4`);
  assert.equal(response.headers.get("x-tidb-play"), "not_hls");
});

test("a body is sniffed when its content type does not say 'playlist'", async () => {
  relaying = false; // a PROXY=off deployment, not this one's default
  const response = await call(playPath(`${base}/hls/odd`, "tt0903747:1:1"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-tidb-play"), "spliced");
  const text = await response.text();
  assert.equal(segmentNumbers(text).length, LONG_PLAYLIST_SEGMENTS - 32);
});

test("a body that is not a playlist is not served as one", async () => {
  relaying = false; // a PROXY=off deployment, not this one's default
  const response = await call(playPath(`${base}/blob`, "tt0903747:1:1"));
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("x-tidb-play"), "not_a_playlist");
  assert.equal(response.headers.get("location"), `${base}/blob`);
});

test("a target that is not a playlist is sniffed once, then remembered", async () => {
  relaying = false; // a PROXY=off deployment, not this one's default
  // Players re-request a progressive file constantly (seeks, ranges), so the
  // verdict is cached instead of re-sniffing the origin each time.
  const first = await call(playPath(`${base}/blob`, "tt0903747:1:1"));
  const second = await call(playPath(`${base}/blob`, "tt0903747:1:1"));
  assert.equal(first.headers.get("x-tidb-play"), "not_a_playlist");
  assert.equal(second.headers.get("x-tidb-play"), "not_a_playlist_cached");
  assert.equal(hits.get("/blob"), 1, "the origin was only asked once");
});

test("a range request goes straight to the origin, without a sniff", async () => {
  relaying = false; // a PROXY=off deployment, not this one's default
  const response = await call(playPath(`${base}/hls/media.m3u8`, "tt0903747:1:1"), testSettings(), {
    headers: { range: "bytes=0-1023" },
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("x-tidb-play"), "range_request");
  assert.equal(response.headers.get("location"), `${base}/hls/media.m3u8`);
  assert.equal(hits.get("/hls/media.m3u8"), undefined, "the playlist was not fetched");
});

test("with segment proxying on, the segments point at the Worker", async () => {
  const response = await call(playPath(`${base}/hls/media.m3u8`, "tt0903747:1:1", proxyConfig));
  const text = await response.text();
  assert.ok(text.includes(`/${proxyConfig}/seg?u=`) || text.includes(`/${proxyConfig}%2Fseg`));
  assert.ok(text.includes(encodeURIComponent(`${base}/hls/seg42.ts`)));
  assert.ok(text.includes(encodeURIComponent(`${base}/hls/key.bin`)));

  const segment = await call(`/${proxyConfig}/seg?u=${encodeURIComponent(`${base}/hls/seg42.ts`)}`);
  assert.equal(segment.status, 200);
  assert.equal(segment.headers.get("content-type"), "video/mp2t");
  assert.equal(segment.headers.get("access-control-allow-origin"), "*");
  assert.equal(await segment.text(), "SEGMENT-BYTES");
});

test("a private target is refused unless the deployment allows it", async () => {
  const strict = testSettings({ ALLOW_PRIVATE_HOSTS: "" });
  const refused = await call(playPath("http://192.168.1.10/secret.m3u8", "tt0903747:1:1"), strict);
  assert.equal(refused.status, 400);
  assert.match(await refused.text(), /private address/);

  const refusedSeg = await call(
    `/${amplified}/seg?u=${encodeURIComponent("http://169.254.169.254/latest/meta-data/")}`,
    strict,
  );
  assert.equal(refusedSeg.status, 400);

  const allowed = await call(playPath(`${base}/hls/media.m3u8`, "tt0903747:1:1"), testSettings());
  assert.equal(allowed.status, 200);
});

test("a deployment with no API key refuses to look anything up", async () => {
  const keyless = testSettings({ TIDB_API_KEY: "" });

  const refused = await call(`/${amplified}/stream/series/tt0903747:1:1.json`, keyless);
  assert.equal(refused.status, 403);
  const body = (await refused.json()) as { code: string; error: string };
  assert.equal(body.code, "missing_api_key");
  assert.match(body.error, /TIDB_API_KEY/);

  // With a key in the install config it works again.
  const withKey = encodeConfig({ src: [`${base}/upstream`], types: ["intro"], key: "from-url" });
  const ok = await call(`/${withKey}/stream/series/tt0903747:1:1.json`, keyless);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("x-tidb-lookup"), "fresh");
});

test("bad ids, bad configs and unknown routes are refused with a reason", async () => {
  const noEpisode = await call(`/${amplified}/stream/series/tt0903747.json`);
  assert.equal(noEpisode.status, 400);
  assert.equal(((await noEpisode.json()) as { code: string }).code, "missing_episode");

  const notImdb = await call(`/${amplified}/stream/series/kitsu:1234:1.json`);
  assert.equal(((await notImdb.json()) as { code: string }).code, "unsupported_id");

  const badType = await call(`/${amplified}/stream/anime/tt0903747:1:1.json`);
  assert.equal(((await badType.json()) as { code: string }).code, "unsupported_type");

  const badConfig = await call("/notbase64!!/manifest.json");
  assert.equal(badConfig.status, 404, "an unparseable path segment is just not a route");

  const badConfig2 = await call("/aGVsbG8/manifest.json");
  assert.equal(badConfig2.status, 400);
  assert.equal(((await badConfig2.json()) as { code: string }).code, "invalid_config");

  const missingTarget = await call(`/${amplified}/play`);
  assert.equal(missingTarget.status, 400);

  const unknown = await call("/nothing/here.json");
  assert.equal(unknown.status, 404);
  const unknownPage = await call("/nothing/here");
  assert.equal(unknownPage.status, 404);
  assert.match(await unknownPage.text(), /build an install link/);
});

test("a bare manifest and an unconfigured stream request behave predictably", async () => {
  const bareStream = await call("/stream/movie/tt0111161.json");
  assert.equal(bareStream.status, 404);
});

test("OPTIONS is answered for cross-origin players", async () => {
  const response = await call(`/${amplified}/manifest.json`, testSettings(), { method: "OPTIONS" });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
});

test("a package that is ready is served as a seekable playlist", async () => {
  // The end state of the whole feature: the playlist a player is handed for a file, and
  // the segments it points at, served from this service's own cache.
  const cacheDir = await mkdtemp(path.join(tmpdir(), "tidb-package-http-"));
  const settings = testSettings({ cacheDir, precutSources: 0 });
  const engine = new PackageEngine(settings);
  const url = playPath(`${base}/hls/movie.mp4`, "tt0903747:1:1", cutConfig);

  // The key is the identity of the source plus its windows, which is what the play URL
  // resolves to; asking the engine for it is exactly what the handler does.
  const windows = [
    { type: "intro" as const, startMs: 228665, endMs: 246498 },
    { type: "credits" as const, startMs: 3432884, endMs: null },
  ];
  const key = engine.keyFor(`${base}/hls/movie.mp4`, windows, null);
  const dir = path.join(cacheDir, "hls", key);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "plan.json"),
    JSON.stringify({
      key,
      windows: [],
      ranges: [
        { startMs: 0, endMs: 20_000 },
        { startMs: 40_000, endMs: 60_000 },
      ],
      createdAt: Date.now(),
    }),
  );
  // What ffmpeg's segment muxer reports: name, start, end, seconds into that stretch.
  // The third segment starts past the end of the first stretch, so it must not be
  // offered -- that is the over-run into the dropped window.
  await writeFile(
    path.join(dir, "pass-0.csv"),
    "seg00000.ts,0.000000,10.000000\nseg00001.ts,10.000000,20.000000\nseg00002.ts,20.000000,26.000000\n",
  );
  await writeFile(path.join(dir, "pass-1.csv"), "seg00003.ts,0.000000,6.000000\n");
  await writeFile(path.join(dir, "done"), "");
  for (const name of ["seg00000.ts", "seg00001.ts", "seg00002.ts", "seg00003.ts"]) {
    await writeFile(path.join(dir, name), "TS-BYTES");
  }

  const response = await call(url, settings, undefined, engine);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/vnd.apple.mpegurl");
  assert.equal(response.headers.get("x-tidb-play"), "package_vod");
  assert.equal(response.headers.get("x-tidb-package"), key);
  assert.equal(response.headers.get("x-tidb-segments"), "3");
  assert.equal(response.headers.get("x-tidb-content-ms"), "26000");

  const body = await response.text();
  assert.ok(body.includes("#EXT-X-PLAYLIST-TYPE:VOD"));
  assert.ok(body.includes("#EXT-X-ENDLIST"), "a finished package is a plain VOD playlist");
  assert.equal((body.match(/^#EXT-X-DISCONTINUITY$/gm) ?? []).length, 1, "one jump, where the gap is");
  assert.ok(body.includes("#EXTINF:10.000,"));
  assert.ok(body.includes(`seg?f=${key}/seg00000.ts`), "a relative URI, so it comes back here");
  assert.ok(!body.includes("seg00002.ts"), "a segment past the end of its stretch is not offered");

  // And the segment itself: served from the cache, typed as MPEG-TS, ranged.
  const segment = await call(`/${amplified}/seg?f=${key}/seg00000.ts`, settings, undefined, engine);
  assert.equal(segment.status, 200);
  assert.equal(segment.headers.get("content-type"), "video/mp2t");
  assert.equal(segment.headers.get("accept-ranges"), "bytes");
  assert.equal(await segment.text(), "TS-BYTES");

  // A name that is not one of ours is refused rather than read.
  const traversal = await call(`/${amplified}/seg?f=${key}/../../plan.json`, settings, undefined, engine);
  assert.equal(traversal.status, 400);
});

test("the deployment's margin trims every window, and an install can override it", async () => {
  // A cut can only land on a keyframe and the timings describe one release, so the last
  // seconds of an intro are where dialogue goes missing. The margin skips less; the
  // install's own number wins over the deployment's.
  const trimmed = await call(
    playPath(`${base}/hls/media.m3u8`, "tt0903747:1:1"),
    testSettings({ skipMarginSeconds: 3 }),
  );
  assert.equal(trimmed.headers.get("x-tidb-cuts"), "intro 3:51-4:03, credits 57:15-end");

  const untrimmed = await call(
    playPath(`${base}/hls/media.m3u8`, "tt0903747:1:1"),
    testSettings({ skipMarginSeconds: 0 }),
  );
  assert.equal(untrimmed.headers.get("x-tidb-cuts"), "intro 3:48-4:06, credits 57:12-end");

  const dropped = (response: Response): number => Number(response.headers.get("x-tidb-dropped-segments"));
  assert.ok(
    dropped(trimmed) < dropped(untrimmed),
    `a margin drops fewer segments (${dropped(trimmed)} < ${dropped(untrimmed)})`,
  );

  // An install carrying its own margin, on a deployment set to a different one.
  const own = encodeConfig({
    src: [`${base}/upstream`],
    types: ["intro"] as SegmentType[],
    margin: 8,
  });
  const wider = await call(
    playPath(`${base}/hls/media.m3u8`, "tt0903747:1:1", own),
    testSettings({ skipMarginSeconds: 3 }),
  );
  assert.equal(wider.headers.get("x-tidb-cuts"), "intro 3:56-3:58", "8s off both ends of a 17.8s intro");
});
