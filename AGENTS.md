# TheIntroDB – Stremio Skip Addon — agent notes

This file is the long-form reference for anyone (human or agent) working on the code in this
repository. The [README](README.md) is the short, human-facing page: what the addon is, how to run
it, and how to install it. Everything technical — how it works, the full configuration, development,
testing, and source layout — lives here.

## What this project is

A self-hosted Stremio `stream` addon. It relays streams from a source addon (the one the user already
uses — AIOStreams, Torrentio, Comet, MediaFusion, etc.) and removes **intro, recap, credits and
preview** segments from those streams, using timings from [TheIntroDB](https://theintrodb.org).

It is deliberately narrow:

- It is a **`stream` addon**, not a catalog addon. It does not list content; it only rewrites the
  stream a source already handed to the player.
- It **never re-encodes**. It either splices an HLS playlist or remuxes a progressive file with
  ffmpeg. The video itself is untouched.
- **TheIntroDB is the only source of timings.** There is no chapter detection and no second skip
  database. The addon asks TheIntroDB for the timings of a specific episode and does exactly what it
  says.

The four segment kinds TheIntroDB serves, and the only ones this addon cuts: `intro`, `recap`,
`credits`, `preview` (see `SEGMENT_TYPES` in `src/addon/types.ts`).

## How it works

Stremio has no `skip` API for addons — there is no endpoint an addon can call to say "remove the
first 90 seconds" — so this addon does the only thing that works without one: it sits in front of
the source addon and removes the segments from the stream before the player sees it.

For each stream request it:

1. **Asks the source addon for the stream.** It tries each configured source URL in order and uses
   the first one that returns streams (the others are fallbacks).
2. **Looks up TheIntroDB's timings** for that episode by `imdb_id` + `season` + `episode`. If
   TheIntroDB has no timings for the episode it returns the original stream untouched; if there is
   no API key anywhere it answers `403 missing_api_key` instead, because that is a configuration the
   user can fix in one step.
3. **Rewrites the stream**, depending on what the source returns:
   - **An HLS playlist** (a `.m3u8`): the playlist is **spliced** — the segments that fall inside a
     skip window are dropped, and a new playlist is returned. This is cheap: it only touches the
     playlist, not the video bytes.
   - **A progressive file** (a `.mkv` or `.mp4`, e.g. a debrid stream): the file is **remuxed** with
     ffmpeg, the skip windows are cut out, and the result is served. This is expensive — see
     [Cutting a file](#cutting-a-file).
   - **A torrent** (`infoHash`) or **a stream with custom headers**: it is passed through untouched,
     with a note, because there is no URL to rewrite and no headers to forward.

The stream it returns is what the player plays, so the cuts are visible on every platform that
supports the player — no per-platform code.

### Cutting a file

Progressive files are cut by remuxing with ffmpeg (no re-encode), so a cut can only land on a
**keyframe**. Consequences:

- A second or two of the intro can survive at the start of a cut, and a second or two around the cut
  boundary can go with it.
- The remux is a full pass over the file. The first playback of a 6 GB episode copies 6 GB through
  this service. The cut is cached (see [Disk](#disk)), so subsequent plays of the same episode do not
  copy it again.
- ffmpeg must be present. The Docker image has it; a bare install without it passes files through
  while HLS still works.
- A stretch is written as MPEG-TS, except an HEVC source, which is written as fragmented MP4 (fMP4):
  hls.js — every browser player — cannot demux HEVC out of MPEG-TS. Whatever the container, the
  playlist gains a segment as soon as the segment is closed, so playback starts a segment into the
  work rather than a stretch into it. An fMP4 pass has no `-segment_list`, so its record is the
  playlist ffmpeg is still appending to (see `passRows` in `packages.ts`).
- Everything a playlist lists is in the package's own container, including the placeholder at the end
  of an unfinished one: a TS piece inside an fMP4 playlist is a demux error rather than a wait.

Whether a file is opened at all is the **install's** choice, carried in its link (`cuts`): `mkv`
packages a `.mkv`/`.mp4` source as HLS on demand, `hls` only splices playlists and copies nothing.
There is no deployment-wide setting for it, so the engine is probed at boot on every deployment — a
broken ffmpeg shows up in the boot log and as `cutsStatus.available` on `/health` rather than being
discovered by the first person who plays a file.

### The processing card

A file cut takes time to produce, and the **processing card** is what a viewer watches while it
happens. It is part of the film, not a screen in front of it: the card's own length is the pre-roll,
the film starts at that offset, and it stays there for every later playback — so a seek back to zero
finds the card, and a resume lands where the film's clock says it should.

The length is **measured, not configured**. A play request waits a couple of seconds for the film
(`PREROLL_WAIT_MS`); if that much is not there, the card is served and one two-second piece of it is
drawn per request, so the card grows exactly as long as the viewer actually waits. `PREROLL_SECONDS`
(default 10) is what ends it: once that much of the _cut_ film is packaged the card is frozen at
however many pieces it has, and the film is appended after them. Growing it later would move the film
under a player that is already on it.

Once the film can play, the pieces are replaced — in place, at the same total length — by one
**finished card** (`done00000.ts`) that says what went and where the film begins ("Segments removed /
Video starts at 0:12"), so a viewer who seeks back to the start a week later is not told that an
episode cut days ago is still processing. The swap never changes the offset; it is drawn in the
background and listed from the poll after it exists.

The card is also a _subtitle_ offset: a rendition is fetched once per playback, so the master tells
it the card's length (`subs.m3u8?f=<track>&c=<seconds>`) and the rendition opens with the matching
card segment. Without that every cue sits one card late for the whole episode.

While a package is still being written the playlist ends in a **placeholder**: a plain piece in the
package's own container and codec, about twelve seconds of it (`PAD_HORIZON_MS`). That length is the
whole point. An `#EXT-X-PLAYLIST-TYPE:EVENT` playlist is joined at its **live edge** — three target
durations before the end, in hls.js (`liveSyncDurationCount`) and in AVFoundation — so a tail that
declares the _rest of the episode_ puts the place a player opens at inside the placeholder for the
entire packaging; and when the film finishes, that position is the end of the episode and the only
way out is to close the player. A short tail keeps the live edge inside the film that already exists,
and the placeholder is never the card for the same reason: a viewer who opens there is looking at
the film's own seconds, not at "Processing…".

A job that has _stopped_ has no card at all (see `manifest`), so a failure hands over the source
untouched instead of a screen that never changes.

**Every package is served as a multivariant playlist**, subtitles or not. The master is the only place
a player looks for `#EXT-X-START`, and it is what stops a live-edge join: without it a package with no
subtitle track had no master at all, so an `EVENT` playlist was joined three target durations before
its end and the first part of the film — everything just after the cut — was skipped. The variant is
the same URL with `m=1`.

An fMP4 (HEVC) package has no card: the card is a TS piece, and mixing containers inside one playlist
is exactly what players disagree about. It waits for its first segment instead, which is a segment's
worth of work rather than a stretch's.

### Margin

`SKIP_MARGIN_SECONDS` (default 2) is the number of seconds left alone at each end of every skip
window: the skip starts this many seconds after the reported start and ends this many seconds before
the reported end. TheIntroDB's timings describe _a_ release of a title rather than necessarily the one
being watched, so the first and last seconds of an intro are where dialogue can go missing. `0` cuts
exactly what is reported. The config page offers 0–5 seconds per install; the environment variable
accepts 0–30 (`MAX_MARGIN_SECONDS` in `src/addon/types.ts`).

### Disk

Package segments (the output of file cuts) are cached on disk and evicted when the cache exceeds
`CACHE_MAX_GB` (default 50), oldest first. Point `CACHE_DIR` at a volume you keep — without a volume,
packages live in the container's writable layer and are lost on every recreate.

### Proxy

`PROXY` (default `on`) relays every stream through this service. Sources people actually use are
debrid files, and a debrid link is bound to the address that asked for it, so the player has to fetch
from here. Set `PROXY=off` only for a source the player can reach directly. Relaying costs bandwidth —
it is the whole reason a debrid source works at all.

### Response headers

The addon forwards the source's stream headers to the player. It does not strip or rewrite the
`Content-Type`, so the player sees the same stream type it would have from the source. (This is the
surface where "sources that need custom headers" pass through untouched — the addon will not forward
arbitrary custom auth headers.)

## Configuration

The service reads its configuration from environment variables. See `.env.example` for the exact
defaults and comments. The full set:

| Variable                  | Default   | Notes                                                                                                                                                                                                                                                                                                       |
| ------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TIDB_API_KEY`            | _(none)_  | **Optional.** One TheIntroDB API key for the whole deployment. Leave it empty and a key comes from the configuration page instead, riding in that install's link. Without a key in either place, stream requests answer `403 missing_api_key`.                                                              |
| `PORT`                    | `8787`    | Port to listen on.                                                                                                                                                                                                                                                                                          |
| `SKIP_MARGIN_SECONDS`     | `2`       | Seconds left alone at each end of every window. Env accepts 0–30; the config page offers 0–5.                                                                                                                                                                                                               |
| `SUBTITLES`               | `on`      | Whether to generate subtitles (see [Subtitles](#subtitles)). `off` never loads them.                                                                                                                                                                                                                        |
| `SUBTITLES_LANGUAGE`      | `en`      | Language to recognize and refine. Align only refines some languages; others keep raw timings.                                                                                                                                                                                                               |
| `SUBTITLES_TTL_HOURS`     | `24`      | How long a generated track is kept (1–720).                                                                                                                                                                                                                                                                 |
| `SUBTITLES_CHUNK_SECONDS` | `30`      | How much audio is transcribed in one go, and therefore how long each subtitle segment is. The clamp starts at the default (30, one recogniser window — `DEFAULT_SUBTITLES_CHUNK_SECONDS` in `src/addon/env.ts`) and ends at 900 as a typo guard, so it can never lift the default off its documented value. |
| `PROXY`                   | `on`      | Relay every stream through this service. `off` only for a source the player can reach directly.                                                                                                                                                                                                             |
| `PREROLL_SECONDS`         | `10`      | Seconds of the **cut** film that must be packaged before playback starts on it (0–60). Also the length of a processing-card piece.                                                                                                                                                                          |
| `SPLASH`                  | `on`      | Whether a processing card may be drawn at all (see [The processing card](#the-processing-card)). Off means a play waits for the film itself, up to `CUT_WAIT_SECONDS`.                                                                                                                                      |
| `CACHE_DIR`               | `./cache` | Where package segments are cached.                                                                                                                                                                                                                                                                          |
| `CACHE_MAX_GB`            | `50`      | How much disk the cache may use before the oldest segment is evicted.                                                                                                                                                                                                                                       |
| `CUT_WAIT_SECONDS`        | `120`     | How long a play request waits for the first segment of a file being packaged.                                                                                                                                                                                                                               |
| `CUT_CONCURRENCY`         | `2`       | Concurrent ffmpeg processes.                                                                                                                                                                                                                                                                                |
| `PRECUT_SOURCES`          | `2`       | When a title's stream list is fetched, start packaging this many of its sources in the background so the first playback lands on a ready playlist. `0` disables it.                                                                                                                                         |
| `FFMPEG_PATH`             | `ffmpeg`  | Override if ffmpeg is not on PATH.                                                                                                                                                                                                                                                                          |
| `FFPROBE_PATH`            | `ffprobe` | Override if ffprobe is not on PATH.                                                                                                                                                                                                                                                                         |
| `ALLOW_PRIVATE_HOSTS`     | _(unset)_ | **Development only.** Allow fetching a source addon on a private/loopback address. Leave unset in production.                                                                                                                                                                                               |

### The install URL

Per-install settings are carried in the Stremio addon URL itself, as a base64url-encoded JSON object
(`AddonConfig` in `src/addon/types.ts`): `src` (source URL(s)), `types` (segment kinds), `key` (optional per-config API key), `cuts` (per-install cutting mode), `margin` (per-install margin), `name` (addon name), and `subtitles` (per-install subtitle request). The deployment's environment is the default for everything except `cuts` — whether a file is packaged is the install's own choice, and a link that says nothing gets `DEFAULT_CUT_MODE` (`mkv`, in `src/addon/types.ts`). There is no `CUTS` environment variable; legacy link values (`blocking`, `on`, `off`, …) are still decoded by `parseCutMode` so old installs keep working. **The install URL is effectively a credential** — it can carry an API key — so keep it private.

## Subtitles

Generated subtitles are an opt-in, per-install feature (on by default at the deployment level via
`SUBTITLES=on`). The speech models run **on this host** — nothing is sent anywhere — and their weights
download on first use. A finished track is tiny (under 100 KB for a 45-minute episode) and the audio
it was made from is deleted as it goes, so a day costs a few megabytes. Tracks are kept for
`SUBTITLES_TTL_HOURS` (default 24) and then dropped.

## Development

### Build, typecheck, test

```bash
npm ci
npm run build:css   # Tailwind -> src/web/styles.generated.ts (the scripts below run it too)
npm run lint        # biome check .
npm run format      # biome format --write .
npm run typecheck   # tsc --noEmit
npm test            # node --import tsx --test test/*.test.ts
npm run build       # build:css + tsc -p tsconfig.build.json
npm run check       # lint + typecheck + test together
```

`npm run dev` runs the server in watch mode (`tsx watch src/server.ts`). It compiles the stylesheet
once at startup; after changing a utility class in `src/web/*-html.ts`, run `npm run build:css` (or
restart `dev`) so the page picks it up.

### Styles and lint

The pages are marked up with Tailwind utilities. `src/web/app.css` is the entry: it imports
Tailwind, points the scanner at `src/web/*.ts` and defines the theme (`bg`, `panel`, `line`, `fg`,
`muted`, `accent`, `warn`, `danger`). `scripts/build-styles.ts` compiles it into
`src/web/styles.generated.ts`, which the page modules inline. The generated file is gitignored:
`typecheck`, `test`, `build` and `dev` all regenerate it first, so a fresh checkout never needs a
separate step.

Biome (`biome.json`) is the formatter and linter; `npm run lint` checks, `npm run lint:fix` applies
safe fixes, and CI runs `biome ci .`. `style/noNonNullAssertion` is off on purpose: the codebase
uses `!` after explicit bounds checks, and the rule's fix would trade those for runtime guards that
cannot fail.

### Tests

Tests are plain Node test files in `test/`, run with `node --import tsx --test test/*.test.ts`. There is
no test runner config to maintain — just add `test/<name>.test.ts` and it is picked up.

### Source layout

All source is in `src/`, grouped by concern. One file per concern:

```
src/
  server.ts        the HTTP server and route wiring (Node entry point)
  index.ts         the request router (entry point)
  addon/           Stremio protocol, install configuration and shared plumbing
    config.ts      the install URL (decode/encode the AddonConfig)
    constants.ts   fixed endpoints and limits
    env.ts         loads and validates environment variables (loadSettings)
    http.ts        response helpers and CORS
    manifest.ts    the addon manifest
    types.ts       shared types (CutMode, SegmentType, AddonConfig, SkipWindow, …) and parsers
    urls.ts        URL shapes handed back to the client
    cache.ts       the in-process cache for lookups and playlist verdicts
  streams/         source streams, cutting and playback
    upstream.ts    asks the source addon for streams; tries configured URLs in order
    streaminfo.ts  extracts imdb_id/season/episode from a stream, and probes its codecs
    hls.ts         splices HLS playlists
    play.ts        playback orchestration (processing card, preroll)
    splash.ts      the placeholder stream served before the cut is ready
    files.ts       serves a cut file with byte ranges
    ffmpeg.ts      shared ffmpeg plumbing (run, copy decisions, disk checks)
    packages.ts    packages and caches cut output
    known.ts       remembers what a release turned out to be between playbacks
    format.ts      time formatting for stream labels and debug headers
  subtitles/       generated subtitle tracks
    subtitles.ts   subtitle generation and the rendition playlist
    transcribe.ts  the speech models, behind one small interface
    transcribe-worker.ts  the models in a child process
    cues.ts        recognised words into cues, on the cut video's clock
    stretches.ts   what has to be transcribed, and where each piece lands
  theintrodb/
    theintrodb.ts  talks to TheIntroDB's API to fetch timings
  web/             the pages served to a browser
    app.css               the Tailwind entry and theme (compiled, not served directly)
    styles.generated.ts   generated by scripts/build-styles.ts; gitignored
    config-page.ts        the configuration page's view model and render entry
    config-page-html.ts   its markup and browser-side form
    debug-page.ts         the /debug page's tables and JSON
    debug-page-html.ts    its markup and drain script
    not-found-page.ts     the 404 page
    escape-html.ts        HTML escaping shared by the pages
  ops/             runtime observability and control
    diagnostics.ts the last failure, for the log and /health
    drain.ts       what /drain deletes
```

### Verify a package

`npm run verify:package` runs `scripts/verify-package.ts`, which validates a produced package.

## Verification commands

```bash
# Is the API key configured? (returns apiKeyConfigured: true/false)
curl -s http://localhost:8787/health

# A TheIntroDB lookup, for reference (note the & must be escaped in a shell):
# curl 'https://api.theintrodb.org/v4/media?imdb_id=tt0903747&season=1&episode=1'
```

## Conventions

- License header on every file: `// SPDX-License-Identifier: GPL-3.0-or-later` followed by
  `// Copyright (C) <year> TheIntroDB`. The license is `GPL-3.0-or-later`, and the "or later" grant is
  deliberate.
- Commit messages use Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, …).
- Run `npx biome check --write .` before committing; do not commit `src/web/styles.generated.ts`.
- The README stays short and human-facing. When a detail grows, put it here in AGENTS.md.
