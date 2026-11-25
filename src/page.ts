// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * The landing / configuration page.
 *
 * Everything the addon needs to know is packed into the addon URL, so this page
 * is just a builder for that URL: fill the form, get a manifest URL, install it.
 * No state is stored on the Worker and no account is involved.
 */

import { ADDON_VERSION } from "./manifest.js";
import type { AddonConfig } from "./types.js";

export interface PageOptions {
  origin: string;
  siteUrl: string;
  serverKeyConfigured: boolean;
  /** Served over plain http on a local address. */
  insecure: boolean;
  /** What /health reports about the cut cache and ffmpeg. */
  cuts: Record<string, unknown>;
  /** The configuration of the install URL this page was opened with, if any. */
  editing?: AddonConfig | null;
  /** Why that URL could not be read, so a mangled link gets an explanation. */
  configError?: string | null;
}

const REPO = "https://github.com/TheIntroDB/stremio-skip-addon";

export function renderConfigPage(options: PageOptions): string {
  const data = JSON.stringify({
    origin: options.origin,
    siteUrl: options.siteUrl,
    serverKeyConfigured: options.serverKeyConfigured,
    version: ADDON_VERSION,
    repo: REPO,
    insecure: options.insecure,
    cuts: options.cuts,
    config: options.editing ?? null,
    configError: options.configError ?? null,
  }).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>TheIntroDB Skip — Stremio addon</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0b0d0c;
    --panel: #121614;
    --panel-2: #171c19;
    --border: #232b27;
    --fg: #e7ece9;
    --muted: #93a09a;
    --accent: #16a34a;
    --accent-strong: #22c55e;
    --warn: #d9a12b;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  main { max-width: 760px; margin: 0 auto; padding: 40px 20px 80px; }
  header { display: flex; align-items: center; gap: 14px; margin-bottom: 8px; }
  header img { width: 56px; height: 56px; }
  h1 { font-size: 22px; margin: 0; letter-spacing: -0.01em; }
  .sub { color: var(--muted); margin: 0 0 28px; }
  .sub a, a { color: var(--accent-strong); }
  section {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 20px;
    margin-bottom: 18px;
  }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin: 0 0 16px; }
  label { display: block; font-weight: 600; margin-bottom: 6px; }
  .hint { color: var(--muted); font-size: 13px; margin: 6px 0 0; }
  select {
    width: 100%;
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--fg);
    padding: 10px 12px;
    font: inherit;
  }
  input[type="text"], input[type="password"], textarea {
    width: 100%;
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--fg);
    padding: 10px 12px;
    font: inherit;
  }
  textarea { min-height: 76px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  .field { margin-bottom: 18px; }
  .checks { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
  .check { display: flex; align-items: center; gap: 8px; background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; font-weight: 500; }
  .check input { accent-color: var(--accent); width: 16px; height: 16px; }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  button {
    background: var(--accent);
    color: #05110a;
    border: 0;
    border-radius: 8px;
    padding: 11px 18px;
    font: inherit;
    font-weight: 700;
    cursor: pointer;
  }
  button.secondary { background: var(--panel-2); color: var(--fg); border: 1px solid var(--border); font-weight: 600; }
  button:disabled { opacity: 0.5; cursor: default; }
  code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  #output { display: none; }
  #output.on { display: block; }
  #manifest-url { word-break: break-all; background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; padding: 12px; display: block; margin-bottom: 12px; }
  .install { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
  .install a {
    text-decoration: none;
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 14px;
    color: var(--fg);
    font-weight: 600;
  }
  ul { margin: 8px 0 0; padding-left: 20px; color: var(--muted); }
  li { margin-bottom: 6px; }
  .badge { display: inline-block; font-size: 12px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); }
  .warn { color: var(--warn); }
  #error { color: #f87171; display: none; margin: 0 0 14px; }
  #notice { display: none; margin: 0 0 18px; padding: 12px 14px; border-radius: 8px; font-size: 14px;
            border: 1px solid var(--border); background: var(--panel-2); }
  #notice.error { border-color: #7f1d1d; color: #f87171; }
  footer { color: var(--muted); font-size: 13px; text-align: center; }
</style>
</head>
<body>
<main>
  <header>
    <img src="https://raw.githubusercontent.com/TheIntroDB/theintrodb-assets/main/badge.png" alt="TheIntroDB">
    <div>
      <h1>TheIntroDB Skip</h1>
      <p class="sub">A self-hosted Stremio addon that removes intros, recaps, credits and previews from your streams, using community timings from <a href="https://theintrodb.org">TheIntroDB</a>.</p>
    </div>
  </header>

  <section id="editing" hidden>
    <p id="notice"></p>
  </section>

  <section>
    <h2>Configure</h2>
    <p id="error"></p>
    <div class="field">
      <label for="sources">Your stream addon URL(s)</label>
      <textarea id="sources" spellcheck="false" placeholder="https://your-aiostreams.example.com/manifest.json"></textarea>
      <p class="hint">One per line, tried in order. The first one that answers with streams is used, so a second URL is a fallback. Any Stremio <span class="mono">stream</span> addon works: AIOStreams, Torrentio, Comet, MediaFusion…</p>
    </div>

    <div class="field">
      <label>Segments to cut</label>
      <div class="checks">
        <label class="check"><input type="checkbox" id="type-intro" checked> Intro</label>
        <label class="check"><input type="checkbox" id="type-recap" checked> Recap</label>
        <label class="check"><input type="checkbox" id="type-credits" checked> Credits</label>
        <label class="check"><input type="checkbox" id="type-preview"> Preview</label>
      </div>
      <p class="hint">A cut is a real cut: the segments are removed from the playlist, so nothing plays and nothing has to be pressed. Credits and previews are off by default because their timings run to the end of the file.</p>
    </div>

    <div class="field">
      <label for="cuts">Cutting</label>
      <select id="cuts">
        <option value="mkv">Cut .mkv files too — the processing card, then the title without its intro</option>
        <option value="hls">Only cut HLS playlists — leave .mkv/.mp4 files alone</option>
      </select>
      <p class="hint">A file with no playlist of its own (a debrid <span class="mono">.mkv</span>) is packaged as HLS on demand: the stretches that survive are copied into segments as the video is streamed. <b>Cut .mkv files too</b> shows the processing card while the first ten seconds of the cut file are made, and then plays the title with the intro already gone — that buffered start is what stops a player reaching the end of a growing playlist and deciding the episode is over. <b>Only cut HLS</b> never touches a <span class="mono">.mkv</span>: playlists are still spliced, nothing is copied and no disk is used. This choice is stored in your install link, so it can differ per install.</p>
    </div>

    <div class="field">
      <label for="margin">Margin on every cut</label>
      <select id="margin"></select>
      <p class="hint">How much of each window's edges to leave alone. A cut can only land on a keyframe, and TheIntroDB's timings describe <i>a</i> release of a title rather than necessarily yours, so the first and last seconds of an intro are where dialogue goes missing. With a margin of 2, the skip starts two seconds after the reported start and ends two seconds before the reported end — it never skips more than the timings ask for. 0 cuts exactly what TheIntroDB reports.</p>
    </div>

    <div class="field">
      <label class="check" style="max-width:560px"><input type="checkbox" id="subtitles"> Generate subtitles for the cut video</label>
      <p class="hint">Cutting removes stretches, so a subtitle track recorded against the original timeline drifts behind the picture. With this on, the audio of the parts that are kept is transcribed on this server, and the track is re-timed to what is playing, so it lines up. It is delivered inside the stream — the player shows them as the video's own subtitle track, no menu involved — and appears as it is made, a chunk at a time. The speech models run here — nothing is sent anywhere — the first play of a title is what pays for it — a few minutes of CPU, once per title, measured at
        5–12× faster than realtime on CPU — and the finished track is then cached for a day.</p>
    </div>

    <div class="field">
      <label for="key">TheIntroDB API key <span class="badge" id="key-badge">required</span></label>
      <input type="password" id="key" spellcheck="false" autocomplete="off" placeholder="paste your key here, or leave it empty if this service has one">
      <p class="hint" id="key-hint"></p>
    </div>

    <p class="hint">Streams are relayed through this service. Most sources bind a link to the address that asked for it (ElfHosted Comet and other debrid setups do), so the player would otherwise be refused with &quot;this stream link only works on the internet connection that requested it&quot;. It is a deployment setting (<span class="mono">PROXY</span>), on by default because the sources people actually use are debrid files.</p>

    <div class="field">
      <label for="name">Addon name <span class="badge">optional</span></label>
      <input type="text" id="name" spellcheck="false" maxlength="40" placeholder="TheIntroDB Skip">
    </div>

    <div class="row">
      <button id="generate" type="button">Generate install link</button>
      <span class="hint">Runs entirely in your browser.</span>
    </div>
  </section>

  <section id="output">
    <h2>Install</h2>
    <code id="manifest-url"></code>
    <div class="install">
      <a id="install-desktop" href="#">Open in Stremio</a>
      <a id="install-web" href="#">Open in Stremio Web</a>
      <button class="secondary" id="copy" type="button">Copy manifest URL</button>
    </div>
    <p class="hint">Your settings live in this URL, so keep it private: anyone who has it can use this Worker. Re-run the form and install again to change anything — Stremio replaces the addon when the id matches.</p>
  </section>

  <section>
    <h2>How it works</h2>
    <ul>
      <li>Stremio asks this service for streams. It asks your source addon and returns what it finds.</li>
      <li>For the title being played, timings are read from TheIntroDB (<span class="mono">/v4/media</span>) by IMDb id, plus season and episode.</li>
      <li><b>HLS sources</b> (an <span class="mono">.m3u8</span>): the playlists are fetched, the segments covering those ranges are dropped and <span class="mono">#EXT-X-DISCONTINUITY</span> marks the jump. No video passes through this service at all.</li>
      <li><b>Files</b> (a debrid <span class="mono">.mkv</span>/<span class="mono">.mp4</span>, no playlist to rewrite): each stretch that survives the windows is copied into MPEG-TS segments with ffmpeg (<span class="mono">-c copy</span>, no re-encode), and a playlist is written from <i>exactly the segments that are complete</i>. The player is handed that playlist after the first segment — a couple of seconds — and it grows while they watch, so playback never waits for the file. The dropped stretches are never generated: the playlist jumps over them with <span class="mono">#EXT-X-DISCONTINUITY</span>, and a finished package is an ordinary seekable VOD playlist. The segments the player pulls are the cache, so nothing is fetched twice.</li>
      <li>When TheIntroDB has no timings — or the source cannot be cut — the stream is passed through untouched.</li>
    </ul>
  </section>

  <section>
    <h2>This instance</h2>
    <ul>
      <li>Files: <span class="mono" id="cuts-mode"></span></li>
      <li>Relaying streams: <span class="mono" id="proxy-relay"></span></li>
      <li>Margin on each cut: <span class="mono" id="cuts-margin"></span></li>
      <li>Segment cache: <span class="mono" id="cuts-cache"></span></li>
      <li>ffmpeg: <span class="mono" id="cuts-ffmpeg"></span></li>
      <li>Reading timings from <span class="mono" id="api"></span> — instance <span class="mono" id="origin"></span></li>
    </ul>
  </section>

  <section>
    <h2>Know before you install</h2>
    <ul>
      <li>Cuts land on a keyframe for a file and on a segment boundary for HLS. Nothing is ever re-encoded, so the cut is only as precise as the keyframe grid and a moment of the skipped window can be kept — <i>never</i> the other way round: footage you should hear is not dropped.</li>
      <li>For a file, only the stretches that survive are fetched, in the order they are watched: an episode is read once, as it plays, and the segments are kept for the next playback. Pick <span class="mono">Only cut HLS playlists</span> above to relay only HLS and never touch video.</li>
      <li>Segments are kept per title and evicted oldest-first once <span class="mono">CACHE_MAX_GB</span> is reached, so a large library settles into a cache of what you actually watch.</li>
      <li>Sources that need custom headers are not relayed, and a source that is a torrent (<span class="mono">infoHash</span>) has no URL to cut — both are passed through.</li>
      <li>Timings come from TheIntroDB only. There is no chapter detection and no second skip database.</li>
      <li>Series numbering is the default order. If your library follows another order (streaming rips, absolute-numbered anime), the wrong episode's timings can apply.</li>
    </ul>
  </section>

  <footer>
    <p><span class="badge" id="version"></span> · <a href="${REPO}">Source</a> · GPL-3.0-or-later · built on <a href="https://theintrodb.org">TheIntroDB</a></p>
  </footer>
</main>
<script id="config-data" type="application/json">${data}</script>
<script>
(function () {
  "use strict";
  var data = JSON.parse(document.getElementById("config-data").textContent);
  var SEGMENTS = ["intro", "recap", "credits", "preview"];

  function b64url(text) {
    var bytes = new TextEncoder().encode(text);
    var binary = "";
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  }

  function sourceList() {
    return (document.getElementById("sources").value || "")
      .split(/\\s+/)
      .map(function (value) { return value.trim(); })
      .filter(Boolean);
  }

  function showError(message) {
    var box = document.getElementById("error");
    box.textContent = message || "";
    box.style.display = message ? "block" : "none";
  }

  function generate() {
    var sources = sourceList();
    if (sources.length === 0) return showError("Add the manifest URL of the stream addon you already use.");
    for (var i = 0; i < sources.length; i++) {
      if (!/^https?:\\/\\//i.test(sources[i])) return showError("Source URLs must start with http:// or https://");
    }
    var key = document.getElementById("key").value.trim();
    if (!key && !data.serverKeyConfigured) {
      return showError("This service has no TheIntroDB API key of its own, so paste one above — it is stored in your install link.");
    }
    var types = SEGMENTS.filter(function (type) {
      return document.getElementById("type-" + type).checked;
    });
    var rawMargin = Number(document.getElementById("margin").value);
    if (!isFinite(rawMargin)) rawMargin = 0;
    var margin = Math.max(0, Math.min(5, Math.round(rawMargin)));
    var config = { src: sources, types: types, cuts: document.getElementById("cuts").value, margin: margin };
    if (document.getElementById("subtitles").checked) config.subtitles = true;
    if (key) config.key = key;
    var name = document.getElementById("name").value.trim();
    if (name) config.name = name;

    var manifest = data.origin + "/" + b64url(JSON.stringify(config)) + "/manifest.json";
    document.getElementById("manifest-url").textContent = manifest;
    document.getElementById("install-desktop").href = manifest.replace(/^https?:\\/\\//, "stremio://");
    document.getElementById("install-web").href = "https://web.stremio.com/#/addons?addon=" + encodeURIComponent(manifest);
    document.getElementById("output").className = "on";
    showError("");
  }

  document.getElementById("generate").addEventListener("click", generate);
  document.getElementById("sources").addEventListener("keydown", function (event) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) generate();
  });
  document.getElementById("copy").addEventListener("click", function () {
    var url = document.getElementById("manifest-url").textContent;
    if (navigator.clipboard) navigator.clipboard.writeText(url);
  });

  document.getElementById("origin").textContent = data.origin;
  document.getElementById("api").textContent = data.cuts.api;
  document.getElementById("version").textContent = "v" + data.version;

  var cuts = data.cuts;
  // No deployment-wide default: the first option is what a new install gets, and every link
  // this page builds carries the choice explicitly.
  // A fixed set of choices, built here rather than left to a number somebody has to guess.
  var marginSelect = document.getElementById("margin");
  for (var seconds = 0; seconds <= 5; seconds++) {
    var option = document.createElement("option");
    option.value = String(seconds);
    option.textContent =
      seconds === 0 ? "0 — cut exactly what TheIntroDB reports" : seconds + (seconds === 1 ? " second" : " seconds");
    marginSelect.appendChild(option);
  }
  marginSelect.value = String(
    cuts.skipMarginSeconds === undefined || cuts.skipMarginSeconds === null ? 2 : cuts.skipMarginSeconds
  );
  document.getElementById("cuts-mode").textContent =
    cuts.available === false
      ? "cannot be cut here — ffmpeg is not available, so files play exactly as they came"
      : "packaged as HLS on demand" +
        (cuts.segments ? " — " + cuts.segments + " segments (" + Math.round((cuts.bytes || 0) / 1048576) + " MB)" : "");
  document.getElementById("cuts-margin").textContent =
    (cuts.skipMarginSeconds || 0) + "s — the skip starts after, and ends before, the reported window";
  document.getElementById("cuts-cache").textContent =
    cuts.available === false
      ? "unused — files are passed through"
      : cuts.cacheDir + " (max " + cuts.cacheMaxGb + " GB, " + cuts.cutConcurrency + " packaging at a time)";
  document.getElementById("proxy-relay").textContent =
    cuts.proxy === false ? "off — the player fetches from the source" : "on — the player fetches from here";
  document.getElementById("cuts-ffmpeg").textContent =
    cuts.available === true ? "available" : cuts.available === false ? "NOT available — files cannot be cut" : "unknown";

  var keyHint = document.getElementById("key-hint");
  var keyBadge = document.getElementById("key-badge");
  if (data.serverKeyConfigured) {
    keyBadge.textContent = "optional";
    keyHint.textContent = "This service already has a key in its environment, so you can leave this empty. A key pasted here is embedded in your install link and stored by Stremio.";
  } else {
    keyBadge.textContent = "required";
    keyHint.textContent = "This service has no key of its own, so a key goes here: it is embedded in your install link and stored by Stremio. TheIntroDB lookups need one, because anonymous lookups are limited per IP. Get one at theintrodb.org/docs.";
  }
  if (data.insecure) {
    showError("This instance is served over plain http on a local address; Stremio will only install a server it can reach.");
  }

  /**
   * Opened with an install URL, this page comes back with that install in it.
   *
   * The configuration lives in the URL, so a URL like /<config>/ is a link back to
   * the settings that produced it: the form is filled in, the cuts it asked for are
   * ticked, and generate() runs so the manifest and install links are already there.
   * Changing something creates a new link; the old one keeps working.
   */
  function notice(message, isError) {
    var box = document.getElementById("notice");
    box.textContent = message;
    box.className = isError ? "error" : "";
    document.getElementById("editing").hidden = false;
  }

  function restore() {
    if (data.configError) {
      notice(data.configError + " Nothing was changed below, so you can still build a new install from scratch.", true);
      return;
    }
    var config = data.config;
    if (!config) return;

    document.getElementById("sources").value = (config.src || []).join("\\n");
    SEGMENTS.forEach(function (type) {
      document.getElementById("type-" + type).checked = (config.types || []).indexOf(type) >= 0;
    });
    if (config.key) document.getElementById("key").value = config.key;
    if (config.name) document.getElementById("name").value = config.name;
    if (config.cuts) document.getElementById("cuts").value = config.cuts;
    if (typeof config.margin === "number") document.getElementById("margin").value = String(config.margin);
    document.getElementById("subtitles").checked = config.subtitles === true;

    notice("You are editing an install. Change what you need and install again — the new link replaces the old one, and the old one keeps working. Source URLs are shown without their /manifest.json, which the addon fetches for you. Keep this page's address private: it is the configuration, and it carries the API key if you put one in it.");
    generate();
  }

  restore();
}());
</script>
</body>
</html>
`;
}
