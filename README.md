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

A Stremio addon that automatically skips/removes **intros, recaps, credits and previews** from your movies and tv shows using timings from [TheIntroDB](https://theintrodb.org). It uses HLS proxying to rewrite `.mkv` videos to HLS and cuts out the segments you choose.

This addon does **not add skip buttons to Stremio**, it removes the segments from the stream *before* it gets to your device. Try the official [Stremio Enhanced Plugin](https://github.com/TheIntroDB/stremio-enhanced-plugin) if you want buttons instead.

---

## Run your own

Requirements: **Docker** (or Node 22 plus **ffmpeg**), and an address Stremio can reach over HTTPS.

> **Run it on your own network, not on a cloud platform.** Debrid sources (ElfHosted's Comet, and most others) block most cloud hosting platforms, your mileage may vary.

### Docker (recommended)

```bash
curl github.com/TheIntroDB/stremio-skip-addon
cd stremio-skip-addon
cp .env.example .env      # optional: only for the settings you want to change
docker compose up -d
```

That is `docker-compose.yml` in this repository: it builds the image, publishes `:8787`, and keeps the segment cache in a named volume. Nothing has to be filled in first — the API key can be pasted on the configuration page instead (see [API key](#api-key)). **Keep the cache mounted** — without the volume, packages live in the container's writable layer and are lost when it is recreated.
> A prebuilt docker image is also available

### Node, without Docker

```bash
git clone https://github.com/TheIntroDB/stremio-skip-addon.git
cd stremio-skip-addon
npm ci
npm run build
node dist/server.js
```

No key is needed on the command line: open `http://localhost:8787/`, paste your key there, and install from the link it gives you. Setting `TIDB_API_KEY` in the environment still works if you would rather the service hold one for every install.

It listens on `:8787`. Put it behind HTTPS before installing it in Stremio — Stremio fetches the manifest from the URL you give it, and a plain-HTTP address only works when the player is on the same machine.

---

## Configure and install

Open the deployment's URL in a browser. The page builds your install link:

1. **Paste your stream addon URL(s)** — AIOStreams, Torrentio, Comet, MediaFusion, anything that serves Stremio streams. One per line; they are tried in order and the first that answers with streams is used, so a second URL is a fallback.
2. **Pick the segments to cut.** Intro, recap and credits are on by default; preview is off.
3. **Pick the cutting mode** — *cut .mkv files too* (default, also splices HLS) or *only cut HLS playlists* (never copies a file). It lives in the install link, so each install can differ.
4. **Set the margin** — the seconds left alone at each end of every window (0–5, 2 by default). If an intro cut feels too aggressive, this is the dial.
5. **The API key** — paste yours here unless the service already holds one in its environment; the field is marked *optional* when it does, and *required* when it does not. See [API key](#api-key).
6. **Install** — the `stremio://` link opens the desktop or mobile app; *Open in Stremio Web* handles the browser player.

Your settings live in the install URL itself (a base64url-encoded JSON object) — the only place a Stremio addon can keep per-user settings. **Keep that URL private:** anyone who has it can use your deployment.

To edit an existing install, open its URL in a browser — the page comes back with that install already filled in. Change what you need and install again.

---

## What this cannot do

Worth reading before installing, because these are properties of the approach rather than bugs:

- **HLS cuts land on segment boundaries** (2–10 s). A cut removes every segment that touches the window, so up to one segment of the footage next to it goes with it.
- **File cuts land on keyframes.** A second or two of the intro can survive, and a second or two around it can go.
- **A file cut costs bandwidth and disk.** The first playback of a 6 GB episode copies 6 GB through this service. HLS sources never do — they cost a few kilobytes of playlists.
- **ffmpeg must be present for file cuts.** The Docker image has it; a bare install without it passes files through while HLS still works.
- **Torrent streams are not relaid.** A stream that is an `infoHash` has no URL to rewrite, so it is passed through with a note.
- **Sources that need custom headers are not relaid.** They are passed through untouched.
- **Series numbering is the default order.** If your library follows another order, the wrong episode's timings can apply.
- **Relaying is what makes a debrid source work, and it costs bandwidth.** It is on by default (`PROXY`); turn it off only for a source the player can reach directly.
- **The install URL carries your settings** (and your API key if you pasted one there). Anyone with it can use your deployment.
- **This is not a Stremio `skip` API.** Stremio has no addon API for skip buttons; segments are removed from the stream instead, which is why it works on every platform.

---

## Development

`npm ci`, then `npm run typecheck`, `npm test`, and `npm run build`. The full configuration table, the development and testing notes and the source structure live in [AGENTS.md](AGENTS.md).

---

## License

**GNU General Public License v3.0 or later** (`GPL-3.0-or-later`) — see [LICENSE](LICENSE) for the full text.

---

<p align="center">
  <a href="https://theintrodb.org"><img src="https://raw.githubusercontent.com/TheIntroDB/theintrodb-assets/main/badge.png" alt="TheIntroDB" width="44" height="44"></a>
  <br><br>
  <sub><b>TheIntroDB</b> · community-submitted intro, recap, credits and preview timestamps for your media server<br>
  <a href="https://theintrodb.org">theintrodb.org</a> · <a href="https://github.com/TheIntroDB">GitHub</a> · <a href="https://discord.com/channels/1457550295742812307/1457550298255200380">Discord</a></sub>
</p>
