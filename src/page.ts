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

export interface PageOptions {
  origin: string;
  siteUrl: string;
  serverKeyConfigured: boolean;
  /** Served over plain http on a local address. */
  insecure: boolean;
  /** What /health reports about the cut cache and ffmpeg. */
  cuts: Record<string, unknown>;
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
      <label for="key">TheIntroDB API key <span class="badge">required</span></label>
      <input type="password" id="key" spellcheck="false" autocomplete="off" placeholder="set TIDB_API_KEY in the environment, or paste a key here">
      <p class="hint" id="key-hint"></p>
    </div>

    <div class="field">
      <label class="check" style="max-width:420px"><input type="checkbox" id="proxy"> Proxy HLS segments through this Worker</label>
      <p class="hint">Off by default: only playlists pass through this service, and segment URLs are handed to the player as-is. Turn this on if your source needs the same headers or cookies for every segment. Debrid links are usually bound to the requesting IP, so a relay from another IP can be refused by the source.</p>
    </div>

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
      <li><b>Progressive sources</b> (a debrid <span class="mono">.mkv</span>/<span class="mono">.mp4</span>): the ranges that survive are copied into a new file with ffmpeg (<span class="mono">-c copy</span>, no re-encode) and cached on this server, which then serves it with range support. That cut is prepared in the background, so the <i>first</i> playback of an item may still show the intro — every playback after that is cut.</li>
      <li>When TheIntroDB has no timings — or the source cannot be cut — the stream is passed through untouched.</li>
    </ul>
  </section>

  <section>
    <h2>This instance</h2>
    <ul>
      <li>Cuts: <span class="mono" id="cuts-mode"></span></li>
      <li>Cut cache: <span class="mono" id="cuts-cache"></span></li>
      <li>ffmpeg: <span class="mono" id="cuts-ffmpeg"></span></li>
      <li>Reading timings from <span class="mono" id="api"></span> — instance <span class="mono" id="origin"></span></li>
    </ul>
  </section>

  <section>
    <h2>Know before you install</h2>
    <ul>
      <li>Cuts land on a keyframe for a progressive file and on a segment boundary for HLS. Nothing is ever re-encoded, so a cut can take up to a second or two of the adjacent footage with it.</li>
      <li>Progressive cuts are served from this server, so a 6 GB episode costs 6 GB of its bandwidth (and disk) on the first playback. Set <span class="mono">CUTS=off</span> to relay only HLS and never touch video.</li>
      <li>The cut cache is per file, and evicted oldest-first once <span class="mono">CACHE_MAX_GB</span> is reached.</li>
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
      return showError("This service has no TheIntroDB API key. Set TIDB_API_KEY in its environment, or paste a key above.");
    }
    var types = SEGMENTS.filter(function (type) {
      return document.getElementById("type-" + type).checked;
    });
    var config = { src: sources, types: types };
    if (key) config.key = key;
    if (document.getElementById("proxy").checked) config.proxy = true;
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
  document.getElementById("cuts-mode").textContent =
    cuts.mode === "off" ? "off — progressive files are passed through" : cuts.mode;
  document.getElementById("cuts-cache").textContent =
    cuts.mode === "off"
      ? "disabled"
      : cuts.cacheDir + " (max " + cuts.cacheMaxGb + " GB, " + cuts.cutConcurrency + " at a time)";
  document.getElementById("cuts-ffmpeg").textContent =
    cuts.available === true ? "available" : cuts.available === false ? "NOT available — cuts cannot run" : "unknown";

  var keyHint = document.getElementById("key-hint");
  if (data.serverKeyConfigured) {
    keyHint.textContent = "This service already has a key in its environment, so you can leave this empty. A key pasted here is embedded in your install link and stored by Stremio.";
  } else {
    keyHint.textContent = "This service has no key yet, and TheIntroDB lookups need one: anonymous lookups are limited per IP. Set TIDB_API_KEY in the environment, or paste a key here.";
  }
  if (data.insecure) {
    showError("This instance is served over plain http on a local address; Stremio will only install a server it can reach.");
  }
}());
</script>
</body>
</html>
`;
}
