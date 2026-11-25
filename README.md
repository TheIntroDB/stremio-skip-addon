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

Stremio has no skip API for addons, so this addon does the only thing that works without one: it takes the stream **before** the player sees it and removes the parts you asked it to remove — by dropping HLS segments, or by packaging a file into a playlist that skips them. Nothing is re-encoded, so the video itself is untouched.

Intros, recaps, credits and previews are gone from the timeline, on every platform, with nothing to press.

**TheIntroDB is the only source of timings.** No chapter detection, no second skip database.

---

## Run your own

Nobody hosts this for you. It is a small Node service that relays streams from a source addon you already have, so it runs where your bandwidth is: a NAS, a home server, a VPS, or any Docker host.

You need three things: **Docker** (or Node 22 plus **ffmpeg**, if you would rather not containerise), a **TheIntroDB API key**, and an address Stremio can reach over HTTPS.

> **Run it on your own network, not on a cloud platform.** Two things break otherwise, and both are properties of the sources rather than of this addon:
>
> - A debrid source (ElfHosted's Comet, and most others) mints a link for **the address that requested it**. On your own connection, the addon and the player share that address, so the link is valid for both. On a cloud host the addon's egress address is a *different* one — and it can change on every deploy — so links minted before a restart stop working, and anything that has to be fetched by the player rather than the addon is refused outright.
> - A cloud host's address is a datacenter address in a shared range, which is exactly what a proxy in front of an API blocks first. TheIntroDB's own API answers `403` to some of those ranges, and then there are no timings to cut with.
>
> Self-hosting on your own network avoids both. Running it remotely works too, as long as the machine has a **stable address** you control — a VPS with its own IP, or a tunnel back to your network.

### Docker (recommended)

### Docker, from a clone of this repository

One command, from a clone of this repository:

```bash
cp .env.example .env      # put TIDB_API_KEY in it
docker compose up -d
```

That is `docker-compose.yml` in this repository: it builds the image, publishes `:8787`, and keeps the segment cache in a named volume.

If the host cannot build — a resolver that will not answer for Docker Hub's CDN, no BuildKit, a locked-down server — use the published image instead, which only needs a pull:

```bash
docker login ghcr.io          # the package is private while this repo is
docker compose -f docker-compose.image.yml up -d
```

`docker-compose.image.yml` is the same service with `image:` and no `build:`. Pointing a deployment platform at that file is the way to deploy this without a builder.

Without compose (Node 22 plus ffmpeg in the image, about 200 MB):

```bash
docker build -t tidb-skip .
docker run -d --name tidb-skip \
  -p 8787:8787 \
  -e TIDB_API_KEY=<your key> \
  -v tidb-cut-cache:/cache \
  tidb-skip
```

**Mount `/cache`.** The image creates it, but without a volume your packages live in the container's writable layer and are lost when it is recreated — you would fetch the same episode again on every update. Any of `-v tidb-cut-cache:/cache` (named volume), `-v ./cache:/cache` (a directory on the host) or `-v /mnt/media/tidb-cache:/cache` (a NAS share) works.

An image is published to `ghcr.io/theintrodb/stremio-skip-addon` (`latest` from `main`,
plus `x.y.z` for a release tag) for `linux/amd64` and `linux/arm64`. While this
repository is private that package is private too, so pulling it needs
`docker login ghcr.io` with a token that can read packages — building from the
Dockerfile needs nothing but the source.

> Mount the cache as a directory you own. The image runs as the `node` user, so a root-owned bind mount will not be writable — `docker run --user "$(id -u):$(id -g)"` fixes that, or let Docker manage the volume as above.

### Node, without Docker

```bash
git clone https://github.com/TheIntroDB/stremio-skip-addon.git
cd stremio-skip-addon
npm ci
npm run build
TIDB_API_KEY=<your key> CUTS=blocking node dist/server.js
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
3. **Pick the cutting mode** — *always cut* (the default: the first play waits a couple of seconds for the first segment, so the intro is gone from the start), *start playing first* (the source plays immediately and the cut applies from the next playback), or *never cut files* (playlists only, nothing copied). It lives in the install link, so your installs can differ.
4. **Set the margin** below it — the seconds left alone at each end of every window (2 by default). If an intro cut feels too aggressive, this is the dial.
5. **The API key** is already handled if the service has one in its environment; paste one here only if you would rather carry it in the install URL. See [API key](#api-key).
6. **Install** — the `stremio://` link opens the desktop or mobile app; *Open in Stremio Web* handles the browser player.

Your settings live in the install URL itself (base64url of a small JSON object), which is the only place a Stremio addon can keep per-user settings. **Keep that URL private:** anyone who has it can use your deployment.

### Editing an existing install

The install URL *is* the record, so open it in a browser — `…/<config>/` or `…/<config>` — and the page comes back with that install in it: the source addon URLs are in the form, the segment types you chose are ticked, the key is filled in, and the manifest and install links are already built. Change what you need and install again; the new link replaces the old one, and the old one keeps working.

There is no account, no database and nothing to look up server-side: the page is rendered from the URL you arrived with, and that response is marked `no-store` so it is never cached — it holds your configuration, including the API key if you put one there. A link that has lost a character says so and leaves the blank form below it, so you can always build a fresh install; a path that is not an install link at all is still a plain 404.

### API key

A TheIntroDB API key is **required**, not optional. Anonymous lookups are rate limited *per IP*, and a self-hosted deployment is not alone on its address — a home connection or a VPS shares it with everything else that runs there. Without a key this addon does no lookups at all: the config page will not give you an install link, and a stream request answers `403 missing_api_key` instead of pretending.

Get one at [theintrodb.org/docs](https://theintrodb.org/docs), then set it in the environment so it stays out of your install URL:

```bash
TIDB_API_KEY=...        # docker run -e TIDB_API_KEY=...   (or a .env next to docker-compose.yml)
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
- **A file** (`.mkv`, `.mp4`, what a debrid link usually is) → the stretches that survive are copied into MPEG-TS segments with ffmpeg (`-c copy`: no re-encode, no quality loss) and served from here as a playlist that grows while you watch, so playback starts after the first segment instead of after the file — see [Cutting a file](#cutting-a-file).
- **Anything else** (`302`) → the player is sent to the origin untouched. With relaying on (the default) that case disappears: the file is streamed through the addon instead, which is what a source that binds the link to the requesting address needs.

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

A progressive file has no playlist to rewrite, and copying the whole 6 GB before the player may start is what makes players give up. So a file is **packaged as HLS instead of copied**:

- The source is probed once (`ffprobe`) for its duration, and the windows are turned into **keep ranges** — the pieces before, between and after them.
- For each keep range, ffmpeg stream-copies *that stretch only* into MPEG-TS segments (`-f segment -c copy`, no re-encode) and reports each finished segment in a CSV as it closes.
- This service writes the playlist from those CSVs, so **only complete segments are ever listed** — a player asking for a segment that is still being written would fail. The playlist is therefore served a couple of seconds into the job, and it grows while the player watches it: `#EXT-X-PLAYLIST-TYPE:EVENT` tells the player to keep re-reading it, and `#EXT-X-ENDLIST` at the end turns it into an ordinary seekable VOD playlist.
- The dropped stretches are **never generated**. The playlist jumps from one keep range to the next with `#EXT-X-DISCONTINUITY`, so nothing of the intro is fetched, buffered or played.
- The segments the player pulls *are* the cache: one read of the source, in the order the video is watched, and the next playback of that item is served from disk. Segments are kept per title and evicted oldest-first once `CACHE_MAX_GB` is reached.
- A package is keyed on the **stream**, not on its URL: the episode, the source host and the release labels. That matters because a debrid source mints a fresh link (`/playback/<token>`, with a new token) for every stream list, so a key made from the URL would never be found again. `x-tidb-package` in the response says which package was served, and two playbacks of the same release report the same one.

Nothing is re-encoded, so a cut can only be as precise as the keyframe grid, and cannot start inside a GOP. **The error is always in the safe direction:** a stretch is copied until the first keyframe *after* the end of the window, so a moment of the *window* can be kept (up to one GOP), and playback always resumes at the keyframe at or before the window's end — the addon never skips past a window and never drops footage you should be hearing. Segments that begin after the end of a stretch are dropped, and those contain window footage only.

Both ends of that: with a 2-second keyframe grid a 17.8 s window lost 17.3 s of itself, and with a 10-second grid up to 10 s of the window can remain.

### The processing card

A file is packaged on demand, so a cold playback has nothing of the episode to play for a moment. Rather than leave the player with a spinner — or hold the request until enough exists — it is handed a **processing card**: a black 1280×720 slide with the badge, `Processing…`, `TheIntroDB is currently cutting the segments from your stream`, how many segments are being cut, which windows those are, and `Go to theintrodb.org to submit or report incorrect segments`. The count is the number of windows — the segments the card is listing — and the line under it carries a ticker that advances as segments are written, so the card moves while the work happens.

**The playlist declares the whole episode from its first response.** A player that reaches the end of a playlist decides the title is over — Stremio marks the episode watched and jumps to the next one — and a playlist holding only what has been packaged so far ends after a few seconds. So the source's length is probed once per title (`rememberDuration`), the declared length is the source minus the windows being cut, and the part that has not been packaged yet is filled with **placeholder entries pointing at the card**: the player sees "Processing…" if it ever reaches them, and the length is right from the start. As real segments arrive they replace the placeholder from the tail, so the declared length stays the episode's.

**Playback starts once there is a buffer to watch.** The card is played until `PREROLL_SECONDS` (default **10**) of the *episode's own* video is ready — never less than one segment — and then stops: a player already holding that playlist walks off the end of the card into the film, and the rest is packaged behind it. (Earlier, the card was drawn for as long as the package was incomplete, which put "Processing…" in front of the film until the whole file had been cut.)

Placeholder entries are one segment's worth each (~6 s) rather than one enormous one, because a player's reload cadence comes from `#EXT-X-TARGETDURATION`: a two-hour target would mean waiting two hours to notice the episode had arrived. A two-hour episode is ~1200 entries with or without placeholders, so the playlist stays the size a playlist normally is.

- Everybody gets the card; it is not a setting on the setup page. An operator can turn it off for the whole deployment with `SPLASH=off`, and the play request is then held until the first segment exists instead.
- It needs a font and the badge. The image installs `fonts-dejavu-core` and vendors `assets/badge.png`; a deployment without them logs the reason at boot, reports it in `/health` (`cutsStatus.splashError`) and simply skips the card.
- The text is passed to ffmpeg as files, not as filter arguments: a colon (`Intro 3:50-4:04`) cannot be passed through a filter graph at all — `\:` does not survive the graph parser and quoting the value does not either, both of which were measured against the ffmpeg in the image.

### Margin

Because the cut is keyframe-limited, and because TheIntroDB's timings describe *a* release of a title rather than necessarily the one being watched, the first and last seconds of an intro are exactly where dialogue can go missing. Every window is therefore **shrunk before it is used**: the skip starts `SKIP_MARGIN_SECONDS` (default **2**) after the reported start, and ends that many seconds before the reported end — on every segment type, and in both cut paths. It can only ever remove *less* than the timings ask for, never more.

- `SKIP_MARGIN_SECONDS=0` cuts exactly what TheIntroDB reports. The configuration page offers 0–5 seconds as a dropdown.
- It is a control on the configuration page too, stored in the install link, so one install can be cautious while another is literal. Changing it makes a different package (the windows are part of the key), so the next playback packages afresh.
- A window the margin would empty is dropped outright rather than cut at zero length, so a very short segment simply keeps playing.

If a cut still lands in the wrong place, it is the timings that differ from your file rather than the skipping: `/v4/media` can answer from the release cluster nearest the file when the caller sends its `duration_ms`, which this addon does not do yet. A larger margin is the blunt but effective answer until then.

The first playback is a question of policy. `CUTS` sets the deployment's default and **the configuration page lets each install choose its own**, so one service can serve an install that always cuts and another that copies nothing:

| mode | First playback | Later playbacks |
| --- | --- | --- |
| `blocking` (default) | Waits for the **first segment** — a couple of seconds, not the length of the file — and plays it cut | Cut, from the cache |
| `on` | Plays the original immediately while the package is built behind it | Cut, from the cache |
| `off` | Uncut, always | Uncut — only HLS playlists are spliced, nothing is copied |

The stream list is also fetched moments before playback, so a package for the first one or two sources on the list is started then, as a head start: by the time a stream is picked, the playlist is usually already there.

**Two things a package cannot carry.** MPEG-TS holds video and audio, so a subtitle track embedded in the file is not in the playlist — players fetch subtitles from their own addon, and Stremio's OpenSubtitles addon is the usual answer. And a package is served as a playlist, so a player that only accepts a direct file link (some TVs) should be given the source: turn `CUTS` off for that install.

### Disk

Segments live in `CACHE_DIR` (default `/cache` in the container) and whole packages are evicted oldest-first once they exceed `CACHE_MAX_GB`. The kept stretches are what is stored — the intro is never downloaded — so a package is smaller than the file it came from. Evicting a package that is being watched is safe: the response already being served reads from an open file, and segments are immutable, so a player that re-requests one gets it from the page cache or a fresh copy — it is simply packaged again next time.

A package is only started when the source's own reported size fits with a tenth of the disk still free, because filling the volume takes the whole service down with it; the refusal shows up in `/health` as a failed package with the reason. A source that streams in chunks (many debrid links) reports no size, so it is attempted — those are the sources that need the feature most.

Unlike the file copy it replaced, packaging reads the source **once**: the segments written are the segments served, so proxying and cutting do not each fetch the video.

Setting `CUTS=off` means no disk use at all and no video through the service — except that with proxying on the video does still flow through, it is just never cut (so a file keeps its intro).

### Playback fails with "this stream link only works on the internet connection that requested it"

Your source binds the link to the address that asked for it, and ElfHosted's Comet says so with a page naming two IPs: the one it expected, and yours. The expected one is this service's — it fetched the stream list, so the debrid link was minted for it — and the player then opened the link from your own connection, which the source refuses.

It is handled for you: streams are relayed through this service by default, because almost every source people use is a debrid file. It is the deployment setting **`PROXY`** (`on` by default; `off` only for a source the player can reach directly), not an install option — so nothing to configure per install:

- with it on, the player asks *this service* for the playlists, the segments and the file itself, and every one of those fetches to the source comes from the same address the link was minted for;
- with it off, the addon only relays the stream list and the playlists, and hands the video URL to the player, which is exactly the address mismatch above.

Check it with `x-tidb-play: proxied_file` (or `proxied` on a segment) in the response headers, and `x-tidb-proxy: streamed`. The service's own address is whatever its host gives it, and `/health` does not report it, so read it from a source that echoes it — `/<config>/seg?u=https://api.ipify.org/?format=json`.

Note that the video now flows through your deployment (see [Disk](#disk) for what that costs).

### Response headers

Every `/play` response says what it did, which is the fastest way to see whether a title is being cut:

| Header | Meaning |
| --- | --- |
| `x-tidb-play` | `spliced`, `master`, `unchanged`, `rewritten_uris` (proxy mode), `package_live` (a playlist still being built), `package_vod` (a finished package), `package_segment` (one segment of one), `proxied_file`, `not_hls`, `not_a_playlist`, `not_a_playlist_cached`, `range_request`, `degenerate_windows`, `pass_through`, `upstream_<status>` |
| `x-tidb-fallback` | Why a package was not served and the original was used instead: `package_warming` (`on` mode), `package_slow` (no segment inside `CUT_WAIT_SECONDS`), `not_hls`, `not_a_playlist`, `not_a_playlist_cached` |
| `x-tidb-package` | Which package was served; the same release reports the same key across playbacks |
| `x-tidb-segments` | How many segments the served playlist lists |
| `x-tidb-content-ms` | How much video it holds — smaller than the file when a window is gone |
| `x-tidb-proxy` | `streamed` when the bytes came through this service, `unreachable` when the source could not be fetched |
| `x-tidb-upstream-status` | The status the source answered with, when the bytes were relayed |
| `x-tidb-seg` | `streamed` on a proxied segment (`/seg`) |
| `x-tidb-lookup` | `fresh`, `cache_hit`, `media_not_found`, `episode_not_found`, `missing_api_key`, `rate_limited…`, `request_failed…` |
| `x-tidb-cuts` | The windows that applied to a playlist, e.g. `intro 3:48-4:06, credits 57:12-end` |
| `x-tidb-dropped-segments`, `x-tidb-dropped-ms`, `x-tidb-duration-ms` | What was removed from a playlist, and its length |

`/health` reports the version, which API it talks to, whether the deployment has a key, the cutting mode and cache directory, and how many packages are queued, being built, finished or failed (`cutsStatus.segments`, `cutsStatus.bytes` and `cutsStatus.packages`).

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
- **Relaying is what makes a debrid source work, and it costs bandwidth.** The player fetches playlists, segments and files from this service, which is the address the source minted the link for — without it a debrid link is opened from the player's own connection and refused. It is on by default and is the deployment's `PROXY` setting: off is fine (and cheaper) for a source the player can reach directly. See [above](#playback-fails-with-this-stream-link-only-works-on-the-internet-connection-that-requested-it).
- **The install URL is the credential-ish thing.** It contains your config (and your API key if you pasted one there). Anyone with it can use your deployment; the service refuses to relay to private addresses, but treat the URL as private.
- **This is not a Stremio `skip` API.** Stremio has no addon API for skip buttons; segments are removed from the stream instead, which is why it works on every platform.

---

## Configuration

Everything is an environment variable; there is nothing to edit in the image.

| Variable | Default | Meaning |
| --- | --- | --- |
| `TIDB_API_KEY` | *(none)* | **Required.** TheIntroDB API key. Without it, lookups refuse with `403`. |
| `PORT` | `8787` | Port to listen on. |
| `CUTS` | `blocking` | `blocking`, `on` or `off` — the deployment's default; an install link can override it. See [Cutting a file](#cutting-a-file). |
| `CACHE_DIR` | `./cache` (`/cache` in the image) | Where package segments are kept. |
| `CACHE_MAX_GB` | `50` | Disk budget for packages, evicted oldest-first. |
| `CUT_WAIT_SECONDS` | `120` | `blocking` mode only: how long a play request waits for the first segment. A couple of seconds is the normal answer; the bound only matters when a source is slow. |
| `PROXY` | `on` | Whether the player fetches everything from this service. Off only suits a source the player can reach directly; debrid links need it on. |
| `PREROLL_SECONDS` | `10` | How much of an episode must be packaged before playback starts on it. The card covers the gap. |
| `SPLASH` | `on` | Draw the processing card for a cold playback. `off` holds the play request until the first segment exists instead. Everybody gets the card; this is an operator's switch, not an install's. |
| `SKIP_MARGIN_SECONDS` | `2` | Seconds left alone at each end of every window, so a cut never removes more than the timings ask for. A control on the configuration page sets it per install. |
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
npm run verify:package -- 'https://…/episode.mkv'        # skips 60-90s and reports
npm run verify:package -- 'https://…/episode.mkv' 735 765 # skips 735-765s
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
  packages.ts  packaging a file into a playlist that skips, and serving its segments
  files.ts     serving a file with Range support
  upstream.ts  the source addon relay
  page.ts      the configuration page
  http.ts      responses and CORS
  format.ts    time formatting
scripts/
  verify-package.ts  package a source of your own and report it (npm run verify:package)
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
