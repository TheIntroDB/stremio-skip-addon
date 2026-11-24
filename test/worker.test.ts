// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * End-to-end tests: the real Worker entry point, driven over HTTP, against a stub
 * source addon, a stub HLS origin and a stub TheIntroDB API that answers with the
 * figures measured from the live API for Breaking Bad S1E1 (2026-11-24:
 * intro 228665-246498, credits 3432884 to the end of the file).
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

import { resetMemoryCache } from "../src/cache.js";
import { encodeConfig } from "../src/config.js";
import { INTRODB_API_BASE } from "../src/constants.js";
import { handleRequest } from "../src/index.js";
import type { Env, SegmentType } from "../src/types.js";

let server: Server;
let base = "";
let amplified = "";
let proxyConfig = "";
const apiCalls = new Map<string, number>();

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

    if (path === "/api/v4/media") {
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
  const config = { src: [`${base}/upstream`], types: ["intro", "recap", "credits"] as SegmentType[] };
  amplified = encodeConfig(config);
  proxyConfig = encodeConfig({ ...config, proxy: true });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  resetMemoryCache();
  apiCalls.clear();
});

const testEnv = (overrides: Partial<Env> = {}): Env => ({
  TIDB_API_KEY: "test-key",
  ALLOW_PRIVATE_HOSTS: "1",
  CACHE_MODE: "memory",
  ...overrides,
});

async function call(path: string, env: Env = testEnv(), init?: RequestInit): Promise<Response> {
  return handleRequest(new Request(`https://worker.example${path}`, init), env);
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
  assert.deepEqual(await health.json(), {
    status: "ok",
    name: "TheIntroDB Skip",
    version: "1.0.0",
    api: "https://api.theintrodb.org/v4/media",
    site: "https://theintrodb.org",
    apiKeyConfigured: true,
  });

  // The page knows whether this deployment has a key, and says so.
  assert.ok(body.includes('"serverKeyConfigured":true'));
  const keylessPage = await call("/", testEnv({ TIDB_API_KEY: "" }));
  assert.ok((await keylessPage.text()).includes('"serverKeyConfigured":false'));

  const bare = await call("/manifest.json");
  const manifest = (await bare.json()) as { behaviorHints: Record<string, unknown>; id: string };
  assert.equal(manifest.behaviorHints.configurationRequired, true);
  assert.equal(manifest.id, "org.theintrodb.stremio.skip");

  const robots = await call("/robots.txt");
  assert.equal(await robots.text(), "User-agent: *\nDisallow: /\n");
});

test("a configured manifest is a stream addon keyed by config", async () => {
  const response = await call(`/${amplified}/manifest.json`);
  const manifest = (await response.json()) as Record<string, unknown> & {
    behaviorHints: Record<string, unknown>;
  };
  assert.deepEqual(manifest.resources, ["stream"]);
  assert.deepEqual(manifest.types, ["movie", "series"]);
  assert.deepEqual(manifest.idPrefixes, ["tt"]);
  assert.equal(manifest.behaviorHints.configurationRequired, false);
  assert.ok(String(manifest.id).startsWith("org.theintrodb.stremio.skip."));
  assert.ok(String(manifest.description).includes("intro, recap, credits"));
  assert.ok(String(manifest.description).includes("127.0.0.1"));
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

test("the title TheIntroDB has no timings for is passed through untouched", async () => {
  const response = await call(`/${amplified}/stream/series/tt0000001:1:1.json`);
  const body = (await response.json()) as { streams: Array<Record<string, unknown>> };
  assert.equal(body.streams.length, 4);
  assert.equal(body.streams[0]!.url, `${base}/hls/master.m3u8`);
  assert.equal(body.streams[1]!.url, "/hls/movie.mp4", "an untouched stream keeps what the source sent");
  assert.equal(body.streams[0]!.name, "StubSource");
  assert.equal(response.headers.get("x-tidb-lookup"), "media_not_found");
  assert.equal(response.headers.get("x-tidb-windows"), "0");
});

test("a rate-limited lookup is passed through too, never guessed at", async () => {
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

test("a progressive file is handed straight to the source", async () => {
  const response = await call(playPath(`${base}/hls/movie.mp4`, "tt0111161"));
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), `${base}/hls/movie.mp4`);
  assert.equal(response.headers.get("x-tidb-play"), "not_hls");
});

test("a body is sniffed when its content type does not say 'playlist'", async () => {
  const response = await call(playPath(`${base}/hls/odd`, "tt0903747:1:1"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-tidb-play"), "spliced");
  const text = await response.text();
  assert.equal(segmentNumbers(text).length, LONG_PLAYLIST_SEGMENTS - 32);
});

test("a body that is not a playlist is not served as one", async () => {
  const response = await call(playPath(`${base}/blob`, "tt0903747:1:1"));
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("x-tidb-play"), "not_a_playlist");
  assert.equal(response.headers.get("location"), `${base}/blob`);
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
  const strict = testEnv({ ALLOW_PRIVATE_HOSTS: "" });
  const refused = await call(playPath("http://192.168.1.10/secret.m3u8", "tt0903747:1:1"), strict);
  assert.equal(refused.status, 400);
  assert.match(await refused.text(), /private address/);

  const refusedSeg = await call(
    `/${amplified}/seg?u=${encodeURIComponent("http://169.254.169.254/latest/meta-data/")}`,
    strict,
  );
  assert.equal(refusedSeg.status, 400);

  const allowed = await call(playPath(`${base}/hls/media.m3u8`, "tt0903747:1:1"), testEnv());
  assert.equal(allowed.status, 200);
});

test("a deployment with no API key refuses to look anything up", async () => {
  const keyless = testEnv({ TIDB_API_KEY: "" });

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
  const response = await call(`/${amplified}/manifest.json`, testEnv(), { method: "OPTIONS" });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
});
