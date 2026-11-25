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
`credits`, `preview` (see `SEGMENT_TYPES` in `src/types.ts`).

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

Whether a file is opened at all is the **install's** choice, carried in its link (`cuts`): `mkv`
packages a `.mkv`/`.mp4` source as HLS on demand, `hls` only splices playlists and copies nothing.
There is no deployment-wide setting for it, so the engine is probed at boot on every deployment — a
broken ffmpeg shows up in the boot log and as `cutsStatus.available` on `/health` rather than being
discovered by the first person who plays a file.

### The processing card

A file cut takes time to produce. Until the first segment of the cut is ready, the addon serves a
short placeholder stream — the **processing card** — so the player does not sit on a blank screen,
and, crucially, so it does not conclude the episode has ended. Starting playback too early on a
growing playlist is what makes Stremio mark an episode watched and jump to the next one.

`PREROLL_SECONDS` controls how much of the episode must be ready before playback starts on it
(default 10).

### Margin

`SKIP_MARGIN_SECONDS` (default 2) is the number of seconds left alone at each end of every skip
window: the skip starts this many seconds after the reported start and ends this many seconds before
the reported end. TheIntroDB's timings describe *a* release of a title rather than necessarily the one
being watched, so the first and last seconds of an intro are where dialogue can go missing. `0` cuts
exactly what is reported. The config page offers 0–5 seconds per install; the environment variable
accepts 0–30 (`MAX_MARGIN_SECONDS` in `src/types.ts`).

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

| Variable | Default | Notes |
|---|---|---|
| `TIDB_API_KEY` | *(none)* | **Optional.** One TheIntroDB API key for the whole deployment. Leave it empty and a key comes from the configuration page instead, riding in that install's link. Without a key in either place, stream requests answer `403 missing_api_key`. |
| `PORT` | `8787` | Port to listen on. |
| `SKIP_MARGIN_SECONDS` | `2` | Seconds left alone at each end of every window. Env accepts 0–30; the config page offers 0–5. |
| `SUBTITLES` | `on` | Whether to generate subtitles (see [Subtitles](#subtitles)). `off` never loads them. |
| `SUBTITLES_LANGUAGE` | `en` | Language to recognize and refine. Align only refines some languages; others keep raw timings. |
| `SUBTITLES_TTL_HOURS` | `24` | How long a generated track is kept (1–720). |
| `SUBTITLES_CHUNK_SECONDS` | `30` | How much audio is transcribed in one go, and therefore how long each subtitle segment is. The clamp starts at the default (30, one recogniser window — `DEFAULT_SUBTITLES_CHUNK_SECONDS` in `src/env.ts`) and ends at 900 as a typo guard, so it can never lift the default off its documented value. |
| `PROXY` | `on` | Relay every stream through this service. `off` only for a source the player can reach directly. |
| `PREROLL_SECONDS` | `10` | Seconds of the episode that must be ready before playback starts (0–60). |
| `SPLASH` | `on` | Whether a cold playback shows the processing card (see [The processing card](#the-processing-card)) instead of being held until the first segment is written. |
| `CACHE_DIR` | `./cache` | Where package segments are cached. |
| `CACHE_MAX_GB` | `50` | How much disk the cache may use before the oldest segment is evicted. |
| `CUT_WAIT_SECONDS` | `120` | How long a play request waits for the first segment of a file being packaged. |
| `CUT_CONCURRENCY` | `2` | Concurrent ffmpeg processes. |
| `PRECUT_SOURCES` | `2` | When a title's stream list is fetched, start packaging this many of its sources in the background so the first playback lands on a ready playlist. `0` disables it. |
| `FFMPEG_PATH` | `ffmpeg` | Override if ffmpeg is not on PATH. |
| `FFPROBE_PATH` | `ffprobe` | Override if ffprobe is not on PATH. |
| `ALLOW_PRIVATE_HOSTS` | *(unset)* | **Development only.** Allow fetching a source addon on a private/loopback address. Leave unset in production. |

### The install URL

Per-install settings are carried in the Stremio addon URL itself, as a base64url-encoded JSON object
(`AddonConfig` in `src/types.ts`): `src` (source URL(s)), `types` (segment kinds), `key` (optional per-config API key), `cuts` (per-install cutting mode), `margin` (per-install margin), `name` (addon name), and `subtitles` (per-install subtitle request). The deployment's environment is the default for everything except `cuts` — whether a file is packaged is the install's own choice, and a link that says nothing gets `DEFAULT_CUT_MODE` (`mkv`, in `src/types.ts`). There is no `CUTS` environment variable; legacy link values (`blocking`, `on`, `off`, …) are still decoded by `parseCutMode` so old installs keep working. **The install URL is effectively a credential** — it can carry an API key — so keep it private.

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
npm run typecheck   # tsc --noEmit
npm test            # node --import tsx --test test/*.test.ts
npm run build       # tsc -p tsconfig.build.json
npm run check       # typecheck + test together
```

`npm run dev` runs the server in watch mode (`tsx watch src/server.ts`).

### Tests

Tests are plain Node test files in `test/`, run with `node --import tsx --test test/*.test.ts`. There is
no test runner config to maintain — just add `test/<name>.test.ts` and it is picked up.

### Source layout

All source is in `src/`. One file per concern:

- `server.ts` — the HTTP server and route wiring.
- `index.ts` — entry point.
- `env.ts` — loads and validates environment variables (`loadSettings`).
- `types.ts` — shared types (`CutMode`, `SegmentType`, `AddonConfig`, `SkipWindow`, `IntroDbMediaResponse`, …) and the parsers (`parseCutMode`, `parseMarginSeconds`).
- `config.ts` — the install URL (decode/encode the `AddonConfig`).
- `page.ts` — the configuration page (the HTML form that builds the install link).
- `upstream.ts` — asks the source addon for streams; tries configured URLs in order.
- `streaminfo.ts` — extracts `imdb_id`/`season`/`episode` from a stream.
- `introdb.ts` — talks to TheIntroDB's API to fetch timings.
- `hls.ts` — splices HLS playlists.
- `files.ts` / `ffmpeg.ts` — remux progressive files with ffmpeg.
- `packages.ts` — packages and caches cut output.
- `cache.ts` — the segment cache and eviction.
- `play.ts` — playback orchestration (processing card, preroll).
- `splash.ts` — the placeholder stream served before the cut is ready.
- `subtitles.ts` / `transcribe.ts` — subtitle generation and transcription.
- `cues.ts` / `stretches.ts` / `format.ts` / `constants.ts` — segment-window and formatting helpers.
- `http.ts` / `urls.ts` / `manifest.ts` / `diagnostics.ts` — HTTP plumbing, URL building, manifest, health.

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
- The README stays short and human-facing. When a detail grows, put it here in AGENTS.md.
