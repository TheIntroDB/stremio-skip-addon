<img align="right" width="88" src="https://raw.githubusercontent.com/TheIntroDB/.github/main/integrations/stremio.png" alt="Stremio">

[![License](https://img.shields.io/github/license/TheIntroDB/stremio-skip-addon?style=flat-square&logo=gnu&logoColor=4ade80&label=License&labelColor=0d0d0d&color=038939)](https://github.com/TheIntroDB/stremio-skip-addon/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/Node-22-038939?style=flat-square&logo=nodedotjs&logoColor=4ade80&labelColor=0d0d0d)](https://nodejs.org)
[![FFmpeg](https://img.shields.io/badge/ffmpeg-7-038939?style=flat-square&logo=ffmpeg&logoColor=4ade80&labelColor=0d0d0d)](https://ffmpeg.org)

[![Stars](https://img.shields.io/github/stars/TheIntroDB/stremio-skip-addon?style=flat-square&logo=github&logoColor=4ade80&label=Stars&labelColor=0d0d0d&color=038939)](https://github.com/TheIntroDB/stremio-skip-addon/stargazers)
[![Issues](https://img.shields.io/github/issues/TheIntroDB/stremio-skip-addon?style=flat-square&logo=github&logoColor=4ade80&label=Issues&labelColor=0d0d0d&color=038939)](https://github.com/TheIntroDB/stremio-skip-addon/issues)
[![Last commit](https://img.shields.io/github/last-commit/TheIntroDB/stremio-skip-addon?style=flat-square&logo=git&logoColor=4ade80&label=Last%20commit&labelColor=0d0d0d&color=038939)](https://github.com/TheIntroDB/stremio-skip-addon/commits)
[![Discord](https://img.shields.io/discord/1457550295742812307?style=flat-square&logo=discord&logoColor=4ade80&label=Discord&labelColor=0d0d0d&color=038939)](https://discord.com/channels/1457550295742812307/1457550298255200380)

### TheIntroDB – Stremio Skip Addon

---

A Stremio addon you run yourself that removes intros, recaps, credits and previews from your streams, using timings from **[TheIntroDB](https://theintrodb.org)**.

Stremio has no skip API for addons, so this addon does the only thing that works without one: it takes the stream **before** the player sees it and removes the parts you asked it to remove — by dropping HLS segments, or by remuxing a progressive file. Nothing is re-encoded, so the video itself is untouched.

Intros, recaps, credits and previews are gone from the timeline, on every platform, with nothing to press.

**TheIntroDB is the only source of timings.** No chapter detection, no second skip database.

---

## Run your own

Nobody hosts this for you. It is a small Node service that relays streams from a source addon you already have, so you run it where your bandwidth is: a Railway project, a VPS, a NAS, or Docker anywhere.

You need three things: **Node 22** (or Docker), **ffmpeg** on the host (only used to cut progressive files), and a **TheIntroDB API key**.

### Option A — Railway

Railway builds the Dockerfile in this repository, gives you a public HTTPS domain, and keeps the cut cache on a volume. Two ways in:

**From the dashboard:** *New Project → Deploy from GitHub repo* → pick this repository. This works with the repository private, as long as you have access to it. Then:

- **Variables** → add `TIDB_API_KEY` (required, see [API key](#api-key)). `CUTS` is `on` by default.
- **Volumes** → add a Railway Volume with the mount path `/cache`, sized for a few films' worth of cuts (see [Disk](#disk)). Railway Volumes are the only kind of persistent storage here: the Dockerfile deliberately has **no `VOLUME` instruction**, because Railway rejects one (`docker VOLUME … is not supported, use Railway Volumes`).

**From the CLI:**

```bash
npm i -g @railway/cli
railway login
railway init                                  # or: railway link
railway up
railway variable set TIDB_API_KEY=<your key>
railway volume add --mount-path /cache         # persistent cut cache
railway domain                                 # prints your public URL
```

Notes for a metered or small plan:

- **The port is the platform's.** Railway injects `PORT`; the service reads it and binds to it, so the image's `8787` default only applies to a plain `docker run`. `railway.json` asks Railway to healthcheck `/health` before it routes traffic.
- **Watch disk and egress.** A file cut copies the whole source once and then serves it, so a 4 GB episode is 4 GB of volume and 4 GB out. `CUTS=off` removes both entirely and still cuts HLS sources (which is a text rewrite — a few kilobytes of playlists). `CACHE_MAX_GB` bounds the volume, and `PRECUT_SOURCES=0` stops the head-start cuts when a stream list is fetched.
- **If `/health` says the cache is unusable** (`cutsStatus.available: false`), the volume is mounted with an owner the `node` user cannot write to. Either set the service's *User* to `root` in Railway's settings, or point `CACHE_DIR` at a directory you can write. Nothing else breaks meanwhile: HLS sources keep being cut.

> **A "Deploy on Railway" button needs a published template.** Railway's button points at a *template code* (`https://railway.com/new/template/<code>`), not at a repository, so the owner of this project has to publish this repo as a template once from their own Railway account (dashboard: the project → *Share* → publish as template). After that the badge for this repository is:
>
> ```md
> [![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/<template-code>)
> ```
>
> `railway.json` in this repository is already written for it: Dockerfile build, `/health` healthcheck, restart on failure.

### Option B — Docker (your own stack)

One command, from a clone of this repository:

```bash
cp .env.example .env      # put TIDB_API_KEY in it
docker compose up -d
```

That is `docker-compose.yml` in this repository: it builds the image (or pulls `ghcr.io/theintrodb/stremio-skip-addon:latest` if you remove `build:`), publishes `:8787`, and keeps the cut cache in a named volume.

Without compose (Node 22 plus ffmpeg in the image, about 200 MB):

```bash
docker build -t tidb-skip .
docker run -d --name tidb-skip \
  -p 8787:8787 \
  -e TIDB_API_KEY=<your key> \
  -v tidb-cut-cache:/cache \
  tidb-skip
```

**Mount `/cache`.** The image creates it, but without a volume your cuts live in the container's writable layer and are lost when it is recreated — you would cut the same episode again on every update. Any of `-v tidb-cut-cache:/cache` (named volume), `-v ./cache:/cache` (a directory on the host) or `-v /mnt/media/tidb-cache:/cache` (a NAS share) works.

An image is published to `ghcr.io/theintrodb/stremio-skip-addon` (`latest` from `main`,
plus `x.y.z` for a release tag) for `linux/amd64` and `linux/arm64`. While this
repository is private that package is private too, so pulling it needs
`docker login ghcr.io` with a token that can read packages — building from the
Dockerfile needs nothing but the source.

> Mount the cache as a directory you own. The image runs as the `node` user, so a root-owned bind mount will not be writable — `docker run --user "$(id -u):$(id -g)"` fixes that, or let Docker manage the volume as above.

### Option C — from a clone

```bash
git clone https://github.com/TheIntroDB/stremio-skip-addon.git
cd stremio-skip-addon
npm ci
npm run build
TIDB_API_KEY=<your key> CUTS=on node dist/server.js
```

It listens on `:8787` and prints its own configuration on boot, including whether ffmpeg was found:

```
TheIntroDB Stremio addon v1.0.0
  listening      http://localhost:8787
  config page    http://localhost:8787/
  api key        configured
  cuts           on (./cache, max 50 GB, 2 at a time)
  ffmpeg         ffmpeg version 7.1.5-0+deb13u1 -> ./cache
```

Put it behind HTTPS before you install it in Stremio. Stremio fetches the manifest from wherever the URL points, and a plain-HTTP address only works if the player is on the same machine.

---

## Configure and install

Open your deployment's URL in a browser. The page builds your install link:

1. **Paste your stream addon URL** — AIOStreams, Torrentio, Comet, MediaFusion, anything that serves Stremio streams (the `manifest.json` URL). One per line; they are tried in order and the first that answers with streams is used, so a second URL is a fallback.
2. **Pick the segments to cut.** Intro, recap and credits are on; previews are off. Credits and previews run to the end of the file when TheIntroDB does not close them, so they are the destructive ones.
3. **The API key** is already handled if the service has one in its environment; paste one here only if you would rather carry it in the install URL. See [API key](#api-key).
4. **Install** — the `stremio://` link opens the desktop or mobile app; *Open in Stremio Web* handles the browser player.

Your settings live in the install URL itself (base64url of a small JSON object), which is the only place a Stremio addon can keep per-user settings. **Keep that URL private:** anyone who has it can use your deployment.

### API key

A TheIntroDB API key is **required**, not optional. Anonymous lookups are rate limited *per IP*, and a self-hosted deployment is not alone on its address — a home connection, a VPS or a Railway egress all share it with strangers. Without a key this addon does no lookups at all: the config page will not give you an install link, and a stream request answers `403 missing_api_key` instead of pretending.

Get one at [theintrodb.org/docs](https://theintrodb.org/docs), then set it in the environment so it stays out of your install URL:

```bash
TIDB_API_KEY=...        # Docker: -e TIDB_API_KEY=...  ·  Railway: Variables tab
```

A key can also be pasted into the config page, in which case it is embedded in the install URL and stored by Stremio — useful if you want a different key than the deployment's own, or if you are sharing one deployment between accounts.

`GET /health` reports `apiKeyConfigured`, so it is one request to check.

---

## How it works

Stremio asks this service for streams. It asks your source addon, and for each stream it knows the media id (`tt0111161`, or `tt0903747:1:1`), so it reads the timings from TheIntroDB:

```
GET https://api.theintrodb.org/v4/media?imdb_id=tt0903747&season=1&episode=1

{"tvdb_id":81189,"type":"tv","season":1,"episode":1,
 "intro":[{"start_ms":228665,"end_ms":246498}],
 "credits":[{"start_ms":3432884,"end_ms":null}]}
```

With timings in hand, the stream offered to Stremio points at `/play` on this service. When the player asks for it:

- **HLS master playlist** → every variant, audio rendition and trick-play playlist is re-pointed at `/play`, so each one gets cut in turn.
- **HLS media playlist** → the segments whose time range overlaps a skip window are dropped, `#EXT-X-DISCONTINUITY` marks the jump, and a re-declared `#EXT-X-MAP` keeps fragmented-MP4 streams decodable. Byte-range playlists keep pointing at the same bytes. **No video passes through this service on this path** — the player still fetches every segment from your source.
- **A progressive file** (`.mkv`, `.mp4`, what a debrid link usually is) → the ranges that survive are copied into a new file with ffmpeg (`-c copy`: no re-encode, no quality loss) and served from here with byte-range support, so seeking works normally.
- **Anything else** (`302`) → the player is sent to the origin untouched.

Measured on Apple's own fragmented-MP4 test stream (`img_bipbop_adv_example_fmp4`, 100 segments / 600s) with the Breaking Bad S1E1 timings:

```
$ curl -sD - "$BASE/$CONFIG/play?u=$MASTER&id=tt0903747:1:1"
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

When TheIntroDB has no timings for a title, or answers `429`, **the stream is returned exactly as your source addon sent it**: no wrapping, no relay, no cost.

A source that turns out not to be a playlist is also cheap: the verdict is remembered for an hour, and a byte-range request (what a player sends on every seek) is handed straight to the origin. The exception is a file that is being cut — a finished cut is served from here before any of that happens, because that is the only way a debrid `.mkv` can skip its intro at all.

Two request shapes are worth knowing about, because both are things Stremio does that a naive addon gets wrong:

- Stremio percent-encodes every path component, so a series request arrives as `/stream/series/tt0903747%3A1%3A1.json`. The id is decoded before it is parsed.
- Sources are asked with the plain id first, and retried with the percent-encoded form when that is refused — some addons only route the encoded shape.

### Cutting a file

A progressive file has no segments to drop, so the only way to remove 30 seconds from the middle of a 6 GB `.mkv` without re-encoding is to copy the ranges that survive into a new file. That is what ffmpeg does here:

- The source is probed once (`ffprobe`) for its duration, and the windows are turned into **keep ranges** — the pieces before, between and after them.
- Each keep range is copied (`ffmpeg -ss <start> -to <end> -c copy`), and the pieces are joined into one file. A copy can only start on a keyframe, so a cut is as precise as the source's keyframe grid (usually under a second to a few seconds).
- The result is cached on disk, keyed by the file's URL path plus the windows, and **served with `Range` support** — so the second and every later playback of that item is cut, immediately.

Because the copy takes as long as copying the file takes, the first playback is a question of policy (`CUTS`):

| `CUTS` | First playback | Later playbacks |
| --- | --- | --- |
| `on` (default) | Plays uncut while the cut is prepared in the background | Cut |
| `blocking` | Waits up to `CUT_WAIT_SECONDS` for the cut, then plays uncut if it is not ready | Cut |
| `off` | Uncut, always | Uncut — only HLS playlists are spliced |

The stream list is also fetched moments before playback, so a cut for the first one or two sources on the list is started then, as a head start.

### Disk

Cuts live in `CACHE_DIR` (default `/cache` in the container) and are evicted oldest-first once they exceed `CACHE_MAX_GB`. A two-hour 1080p episode is roughly 2-6 GB, so 50 GB is a reasonable starting point and a volume is worth attaching on Railway. Evicting a cut that is being watched is safe — the open file keeps streaming — it is simply cut again next time.

A copy is only started when the source's own reported size fits with a tenth of the disk still free, because a cut that fills the volume takes the whole service down with it; the refusal is reported as a `skipped` cut with the reason in `/health`. A source that streams in chunks (many debrid links) reports no size, so it is attempted — those are the sources that need cutting the most.

Setting `CUTS=off` means no disk use at all and no video through the service.

### Response headers

Every `/play` response says what it did, which is the fastest way to see whether a title is being cut:

| Header | Meaning |
| --- | --- |
| `x-tidb-play` | `spliced`, `master`, `unchanged`, `rewritten_uris` (proxy mode), `cut_file`, `not_hls`, `not_a_playlist`, `not_a_playlist_cached`, `range_request`, `degenerate_windows`, `pass_through`, `upstream_<status>` |
| `x-tidb-cut` | `ready` when the response is a cut file |
| `x-tidb-lookup` | `fresh`, `cache_hit`, `media_not_found`, `episode_not_found`, `missing_api_key`, `rate_limited…`, `request_failed…` |
| `x-tidb-cuts` | The windows that applied, e.g. `intro 3:48-4:06, credits 57:12-end` |
| `x-tidb-dropped-segments`, `x-tidb-dropped-ms`, `x-tidb-duration-ms` | What was removed from a playlist, and its length |
| `x-tidb-cut-bytes` | The size of a served cut |

`/health` reports the version, which API it talks to, whether the deployment has a key, the cut mode and directory, and how many cuts are queued, running and ready.

---

## What this cannot do

Worth reading before installing, because these are properties of the approach rather than bugs:

- **HLS cuts land on segment boundaries.** Segments are 2-10 seconds long and nothing is re-encoded, so a cut removes every segment that touches the window: the intro is fully gone, and up to one segment of the footage next to it goes with it.
- **File cuts land on keyframes.** Same idea, smaller grain: the copy starts at the keyframe at or before the window's edge, so a second or two of the intro can survive, and a second or two around it can go.
- **A file cut costs bandwidth and disk.** The first playback of a 6 GB episode copies 6 GB through this service. HLS sources never do this — they cost a few kilobytes of playlists.
- **ffmpeg has to be present for file cuts.** The Docker image has it. A bare install that does not will report it in `/health` and pass files through, HLS still working.
- **Torrent streams are not relaid.** A stream that is an `infoHash` (Torrentio and friends without a debrid) has no URL to rewrite, so it is passed through with a note.
- **Sources that need custom headers are not relaid**, because the relay does not carry them. They are passed through untouched.
- **Series numbering is the default order.** If your library follows another order — streaming rips, absolute-numbered anime, some specials — the lookup answers from the default numbering and the wrong episode's timings can apply. A Stremio stream request carries no episode-order hint, so this cannot be detected client-side.
- **Segment proxying is opt-in and often a bad idea.** Turn it on only for a source that needs the same headers or cookies on every segment. Debrid links are usually bound to the requesting IP, so a relay from another IP can be refused by the source.
- **The install URL is the credential-ish thing.** It contains your config (and your API key if you pasted one there). Anyone with it can use your deployment; the service refuses to relay to private addresses, but treat the URL as private.
- **This is not a Stremio `skip` API.** Stremio has no addon API for skip buttons; segments are removed from the stream instead, which is why it works on every platform.

---

## Configuration

Everything is an environment variable; there is nothing to edit in the image.

| Variable | Default | Meaning |
| --- | --- | --- |
| `TIDB_API_KEY` | *(none)* | **Required.** TheIntroDB API key. Without it, lookups refuse with `403`. |
| `PORT` | `8787` | Port to listen on. |
| `CUTS` | `on` | `on`, `blocking` or `off` — see [Cutting a file](#cutting-a-file). |
| `CACHE_DIR` | `./cache` (`/cache` in the image) | Where cut files are kept. |
| `CACHE_MAX_GB` | `50` | Disk budget for cuts, evicted oldest-first. |
| `CUT_WAIT_SECONDS` | `120` | `blocking` mode only: how long a play request waits for ffmpeg. |
| `CUT_CONCURRENCY` | `2` | Concurrent ffmpeg processes. |
| `PRECUT_SOURCES` | `2` | Sources to start cutting when a stream list is fetched (0 disables the head start). |
| `FFMPEG_PATH`, `FFPROBE_PATH` | `ffmpeg`, `ffprobe` | Override if they are not on `PATH`. |
| `ALLOW_PRIVATE_HOSTS` | *(unset)* | Development only: allow a source addon on a loopback/private address. |

The API host and the site URL are **not** configurable: they are constants in `src/constants.ts`. A deployment pointed somewhere else would be a different addon.

---

## Development

```bash
npm ci                # Node 22+
npm run typecheck     # tsc --noEmit
npm test              # 81 tests: unit, plus a real server and real ffmpeg
TIDB_LIVE=1 TIDB_API_KEY=<key> npm test   # the 2 live tests hit api.theintrodb.org
npm run build         # tsc -p tsconfig.build.json -> dist/
npm run dev           # tsx watch src/server.ts
```

The suite does not mock the things that matter: `test/cut.test.ts` generates a 30-second video, serves it over HTTP with range support and cuts it with the real ffmpeg; `test/server.test.ts` starts the real server on a port and talks to it with `fetch`. The addon tests drive the router over HTTP against a stub source addon, a stub HLS origin and a stub TheIntroDB API whose answers are the figures measured from the live API (Breaking Bad S1E1: intro `228665-246498`, credits `3432884` to end of file). The API host is a constant, so the suite stands in front of `fetch` to answer it — nothing in `src/` has a test hook. The live tests assert shape only: they recompute the expected cut from whatever the API returns, so a new community submission cannot turn them red.

To check the cutter against a source of your own (a debrid link, a direct file), which the fixtures cannot cover:

```bash
npm run verify:cut -- 'https://…/episode.mkv'      # keeps the first 60 seconds and reports
npm run verify:cut -- 'https://…/episode.mkv' 300  # keeps 300 seconds (a bigger copy)
```

```
src/
  server.ts    the Node entry point: HTTP -> Request/Response, graceful shutdown
  index.ts     the router
  env.ts       settings from the environment
  constants.ts the fixed API host, site and API version
  config.ts    the install config packed into the URL
  manifest.ts  the addon manifest
  introdb.ts   the /v4/media lookup, and timings -> skip windows
  hls.ts       playlist parsing and splicing
  play.ts      /play and /seg
  cut.ts       the ffmpeg cut engine and its disk cache
  files.ts     serving a cut file with Range support
  upstream.ts  the source addon relay
  page.ts      the configuration page
  http.ts      responses and CORS
  format.ts    time formatting
scripts/
  verify-cut.ts  run the cutter against a source of your own (npm run verify:cut)
```

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
