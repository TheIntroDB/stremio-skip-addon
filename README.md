<img align="right" width="88" src="https://raw.githubusercontent.com/TheIntroDB/.github/main/integrations/stremio.png" alt="Stremio">

[![License](https://img.shields.io/github/license/TheIntroDB/stremio-skip-addon?style=flat-square&logo=gnu&logoColor=4ade80&label=License&labelColor=0d0d0d&color=038939)](https://github.com/TheIntroDB/stremio-skip-addon/blob/main/LICENSE)
[![Deploy to Cloudflare](https://img.shields.io/badge/Deploy%20to-Cloudflare-F38020?style=flat-square&logo=cloudflare&logoColor=4ade80&labelColor=0d0d0d)](https://deploy.workers.cloudflare.com/?url=https://github.com/TheIntroDB/stremio-skip-addon)

[![Stars](https://img.shields.io/github/stars/TheIntroDB/stremio-skip-addon?style=flat-square&logo=github&logoColor=4ade80&label=Stars&labelColor=0d0d0d&color=038939)](https://github.com/TheIntroDB/stremio-skip-addon/stargazers)
[![Issues](https://img.shields.io/github/issues/TheIntroDB/stremio-skip-addon?style=flat-square&logo=github&logoColor=4ade80&label=Issues&labelColor=0d0d0d&color=038939)](https://github.com/TheIntroDB/stremio-skip-addon/issues)
[![Last commit](https://img.shields.io/github/last-commit/TheIntroDB/stremio-skip-addon?style=flat-square&logo=git&logoColor=4ade80&label=Last%20commit&labelColor=0d0d0d&color=038939)](https://github.com/TheIntroDB/stremio-skip-addon/commits)
[![Discord](https://img.shields.io/discord/1457550295742812307?style=flat-square&logo=discord&logoColor=4ade80&label=Discord&labelColor=0d0d0d&color=038939)](https://discord.com/channels/1457550295742812307/1457550298255200380)

### TheIntroDB – Stremio Skip Addon

---

A Stremio stream addon you deploy to your own Cloudflare Worker. Stremio has no skip API for addons, so this addon does the only thing that works without one: it removes the segments from the HLS playlists before the player ever sees them, using timings from **[TheIntroDB](https://theintrodb.org)**.

Intros, recaps, credits and previews are gone from the timeline, on every platform, with nothing to press.

**TheIntroDB is the only source of timings.** No chapter detection, no second skip database.

---

## Deploy your own

Nobody hosts this for you: the addon runs on your Cloudflare account, on the free plan.

### Option A: the button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/TheIntroDB/stremio-skip-addon)

Cloudflare clones the repository into your GitHub account, builds it with Workers Builds and deploys it. It will ask for one secret, `TIDB_API_KEY`, which is **required** — see [API key](#api-key) below.

> **The button needs a public repository** — a Cloudflare limitation, not a setting: *"Repositories must be public in order for others to successfully use your Deploy to Cloudflare button."* While this repository is private, use Option B; making it public is what a shareable button needs anyway.

### Option B: from a clone

```bash
git clone https://github.com/TheIntroDB/stremio-skip-addon.git
cd stremio-skip-addon
npm install
npx wrangler login
npx wrangler secret put TIDB_API_KEY   # required, see below
npx wrangler deploy
```

That prints your Worker URL, for example `https://tidb-stremio-skip.<your-subdomain>.workers.dev`.

---

## Configure and install

Open the Worker URL in a browser. The page builds your install link:

1. **Paste your stream addon URL** — AIOStreams, Torrentio, Comet, MediaFusion, anything that serves Stremio streams (the `manifest.json` URL). One per line; they are tried in order and the first that answers with streams is used, so a second URL is a fallback.
2. **Pick the segments to cut.** Intro, recap and credits are on; previews are off. Credits and previews run to the end of the file when TheIntroDB does not close them, so they are the destructive ones.
3. **The API key** is already handled if you set the Worker secret; paste one here only if you would rather carry it in the install URL. See [API key](#api-key).
4. **Install** — the `stremio://` link opens the desktop or mobile app; *Open in Stremio Web* handles the browser player.

Your settings live in the install URL itself (base64url of a small JSON object), which is the only place a Stremio addon can keep per-user settings. **Keep that URL private:** anyone who has it can use your Worker.

### API key

A TheIntroDB API key is **required**, not optional. Lookups are rate limited *per IP*, and every Cloudflare Worker shares Cloudflare's egress addresses — so a Worker without a key of its own is limited by everyone else's traffic, and it would look like an add-on that silently never cuts anything. Without a key this addon does no lookups at all: the config page will not give you an install link, and a stream request answers `403 missing_api_key` instead of pretending.

Get a key at [theintrodb.org/docs](https://theintrodb.org/docs), then set it as a Worker secret so it stays out of your install URL:

```bash
npx wrangler secret put TIDB_API_KEY
```

The Deploy to Cloudflare flow asks for it too. A key can also be pasted into the config page, in which case it is embedded in the install URL and stored by Stremio — useful if you want a different key than the deployment's own, or if someone else is borrowing your Worker.

`GET /health` reports `apiKeyConfigured`, so it is one request to check.

---

## How it works

Stremio asks this Worker for streams. The Worker asks your source addon, and for each stream it knows the media id (`tt0111161`, or `tt0903747:1:1`), so it reads the timings from TheIntroDB:

```
GET https://api.theintrodb.org/v4/media?imdb_id=tt0903747&season=1&episode=1

{"tvdb_id":81189,"type":"tv","season":1,"episode":1,
 "intro":[{"start_ms":228665,"end_ms":246498}],
 "credits":[{"start_ms":3432884,"end_ms":null}]}
```

With timings in hand, the stream offered to Stremio points at `/play` on this Worker. When the player asks for it:

- **Master playlist** → every variant, audio rendition and trick-play playlist is re-pointed at `/play`, so each one gets cut in turn.
- **Media playlist** → the segments whose time range overlaps a skip window are dropped, `#EXT-X-DISCONTINUITY` marks the jump, and a re-declared `#EXT-X-MAP` keeps fragmented-MP4 streams decodable. Byte-range playlists keep pointing at the same bytes.
- **Anything else** (`302`) → the player is sent to the origin untouched.

Measured on Apple's own fragmented-MP4 test stream (`img_bipbop_adv_example_fmp4`, 100 segments / 600s) with the Breaking Bad S1E1 timings:

```
$ curl -sD - "$WORKER/$CONFIG/play?u=$MASTER&id=tt0903747:1:1"
x-tidb-play: spliced
x-tidb-cuts: intro 3:48-4:06
x-tidb-dropped-segments: 4
x-tidb-dropped-ms: 24000
x-tidb-duration-ms: 600000
```

`#EXTINF` count 100 → 96, and the cut lands as:

```
#EXT-X-BYTERANGE:1504052@55684453
.../v5/main.mp4
#EXT-X-DISCONTINUITY
#EXT-X-MAP:URI=".../v5/main.mp4",BYTERANGE="719@0"
#EXTINF:6.00000,
#EXT-X-BYTERANGE:1503513@63207656
```

**No video data passes through the Worker** unless you turn on segment proxying: segment URLs are handed to the player as absolute origin URLs, so playback costs no Worker requests and no Worker bandwidth. The Worker only handles playlists — a few kilobytes each — and TheIntroDB lookups, cached on the edge for six hours (fifteen minutes for a miss).

When TheIntroDB has no timings for a title, or answers `429`, **the stream is returned exactly as your source addon sent it**: no wrapping, no relay, no cost.

### Response headers

Every `/play` response says what it did, which is the fastest way to see whether a title is being cut:

| Header | Meaning |
| --- | --- |
| `x-tidb-play` | `spliced`, `master`, `unchanged`, `rewritten_uris` (proxy mode), `not_hls`, `not_a_playlist`, `degenerate_windows`, `pass_through`, `upstream_<status>` |
| `x-tidb-lookup` | `fresh`, `cache_hit`, `media_not_found`, `episode_not_found`, `missing_api_key`, `rate_limited…`, `request_failed…` |
| `x-tidb-cuts` | The windows that applied, e.g. `intro 3:48-4:06, credits 57:12-end` |
| `x-tidb-dropped-segments`, `x-tidb-dropped-ms`, `x-tidb-duration-ms` | What was removed, and the playlist's length |

`/health` reports the version, which API it talks to, and whether the deployment has a key.

---

## What this cannot do

Worth reading before installing, because these are properties of the approach rather than bugs:

- **HLS only.** A direct `.mkv` or `.mp4` cannot be cut in a Worker: there is no transcoder and no way to splice the container. Those streams are redirected to the origin and play in full. HLS sources (`index.m3u8`) are the ones that get cut.
- **Cuts land on segment boundaries.** Segments are 2-10 seconds long and nothing is re-encoded, so a cut removes every segment that touches the window: the intro is fully gone, and up to one segment of the footage next to it goes with it. Nothing is ever cut inside a segment.
- **Torrent streams are not relaid.** A stream that is an `infoHash` (Torrentio and friends without a debrid) has no URL to rewrite, so it is passed through with a note.
- **Sources that need custom headers are not relaid**, because the Worker does not carry them. They are passed through untouched.
- **Series numbering is the default order.** If your library follows another order — streaming rips, absolute-numbered anime, some specials — the lookup answers from the default numbering and the wrong episode's timings can apply. A Stremio stream request carries no episode-order hint, so this cannot be detected client-side.
- **Segment proxying is opt-in and often a bad idea.** Turn it on only for a source that needs the same headers or cookies on every segment. Debrid links are usually bound to the requesting IP, and a Cloudflare Worker is not your IP, so the source can refuse it.
- **The install URL is the credential-ish thing.** It contains your config (and your API key if you pasted one there). Anyone with it can use your Worker; the Worker refuses to relay to private addresses, but treat the URL as private.
- **This is not a Stremio `skip` API.** Stremio has no addon API for skip buttons; segments are removed from the stream instead, which is why it works on every platform.

---

## Development

```bash
npm install          # Node 22+ (wrangler 4 requires 22.12+)
npm run typecheck    # tsc --noEmit
npm test             # 58 tests: unit + end-to-end through the Worker entry point
TIDB_LIVE=1 TIDB_API_KEY=<key> npm test   # the 2 live tests hit api.theintrodb.org
npm run dev          # wrangler dev on http://127.0.0.1:8787 (put the key in .dev.vars)
```

The end-to-end tests drive the real `fetch` handler over HTTP against a stub source addon, a stub HLS origin and a stub TheIntroDB API whose answers are the figures measured from the live API (Breaking Bad S1E1: intro `228665-246498`, credits `3432884` to end of file). The API host is a constant, so the suite stands in front of `fetch` to answer it — nothing in `src/` has a test hook. The live tests assert shape only: they recompute the expected cut from whatever the API returns, so a new community submission cannot turn them red.

```
src/
  index.ts     the Worker entry point and router
  constants.ts the fixed API host, site and API version
  config.ts    the install config packed into the URL
  manifest.ts  the addon manifest
  introdb.ts   the /v4/media lookup, and timings -> skip windows
  hls.ts       playlist parsing and splicing
  play.ts      /play and /seg
  upstream.ts  the source addon relay
  page.ts      the configuration page
  http.ts      responses and CORS
  format.ts    time formatting
```

There are no tunables in `wrangler.jsonc`: the API host is fixed in `src/constants.ts`, and the API key is a secret (`wrangler secret put TIDB_API_KEY`), never a value in the repo.

---

## Contributing

Pull requests are welcome! For major changes, please open an issue first to discuss what you would like to change.

---

## License

**GNU General Public License v3.0 or later** (`GPL-3.0-or-later`) — see [LICENSE](LICENSE) for the full text.

> This program is free software: you can redistribute it and/or modify it under the
> terms of the GNU General Public License as published by the Free Software
> Foundation, either version 3 of the License, or (at your option) any later version.
>
> This program is distributed in the hope that it will be useful, but WITHOUT ANY
> WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
> PARTICULAR PURPOSE. See the GNU General Public License for more details.

Every source file carries `SPDX-License-Identifier: GPL-3.0-or-later`. The "or later" grant is deliberate: it lets the project adopt a future GPL version without re-licensing from every contributor.

---

<p align="center">
  <a href="https://theintrodb.org"><img src="https://raw.githubusercontent.com/TheIntroDB/theintrodb-assets/main/badge.png" alt="TheIntroDB" width="44" height="44"></a>
  <br><br>
  <sub><b>TheIntroDB</b> · community-submitted intro, recap, credits and preview timestamps for your media server<br>
  <a href="https://theintrodb.org">theintrodb.org</a> · <a href="https://github.com/TheIntroDB">GitHub</a> · <a href="https://discord.com/channels/1457550295742812307/1457550298255200380">Discord</a></sub>
</p>
