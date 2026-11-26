// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * The configuration page's document: markup and the browser-side form.
 *
 * Kept apart from `config-page.ts` so the page reads as a document rather than as code.
 * Nothing here knows where the data came from; it receives a view model and renders it.
 * The utilities come from `app.css`, compiled into `styles.generated.ts` and inlined below.
 */

import { TAILWIND_CSS } from "./styles.generated.js";

/** The form is generated entirely in the browser; the server only supplies the data. */
const CONFIG_PAGE_SCRIPT = `
(function () {
  "use strict";
  var data = JSON.parse(document.getElementById("config-data").textContent);
  var SEGMENTS = ["intro", "recap", "credits", "preview"];

  function b64url(text) {
    var bytes = new TextEncoder().encode(text);
    var binary = "";
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
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
    box.hidden = !message;
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
    var audioLang = document.getElementById("audio-lang").value;
    if (audioLang) config.audioLang = audioLang;
    if (key) config.key = key;
    var name = document.getElementById("name").value.trim();
    if (name) config.name = name;

    var manifest = data.origin + "/" + b64url(JSON.stringify(config)) + "/manifest.json";
    document.getElementById("manifest-url").textContent = manifest;
    document.getElementById("install-desktop").href = manifest.replace(/^https?:\\/\\//, "stremio://");
    document.getElementById("install-web").href = "https://web.stremio.com/#/addons?addon=" + encodeURIComponent(manifest);
    document.getElementById("output").hidden = false;
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

  var AUDIO_LANGUAGES = [
    ["en", "English"], ["es", "Spanish"], ["fr", "French"], ["de", "German"], ["it", "Italian"],
    ["pt", "Portuguese"], ["nl", "Dutch"], ["pl", "Polish"], ["ru", "Russian"],
    ["uk", "Ukrainian"], ["cs", "Czech"], ["el", "Greek"], ["hu", "Hungarian"],
    ["ro", "Romanian"], ["sv", "Swedish"], ["da", "Danish"], ["no", "Norwegian"],
    ["fi", "Finnish"], ["tr", "Turkish"], ["ar", "Arabic"], ["he", "Hebrew"],
    ["hi", "Hindi"], ["ja", "Japanese"], ["ko", "Korean"], ["zh", "Chinese"],
    ["th", "Thai"], ["vi", "Vietnamese"], ["id", "Indonesian"], ["ca", "Catalan"]
  ];
  var audioSelect = document.getElementById("audio-lang");
  var defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = "Server default" + (data.audioLanguage ? " (" + data.audioLanguage + ")" : "");
  audioSelect.appendChild(defaultOption);
  AUDIO_LANGUAGES.forEach(function (pair) {
    var option = document.createElement("option");
    option.value = pair[0];
    option.textContent = pair[1];
    audioSelect.appendChild(option);
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

  // Which audio track to recognise. English first, because that is what the model is trained on;
  // the empty value means "whatever this deployment defaults to", so a link stays valid if the
  // deployment's default changes.
  document.getElementById("cuts-mode").textContent =
    cuts.available === false
      ? "cannot be cut here — ffmpeg is missing, so files play as they came"
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
    keyHint.textContent = "This service already has a key, so this can stay empty. A pasted key is embedded in your install link and stored by Stremio.";
  } else {
    keyBadge.textContent = "required";
    keyHint.textContent = "This service has no key, so one goes here; it is embedded in your install link and stored by Stremio. Anonymous lookups are rate-limited per IP. Get one at theintrodb.org/docs.";
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
    box.hidden = false;
    box.classList.toggle("border-red-900", Boolean(isError));
    box.classList.toggle("text-red-400", Boolean(isError));
    box.classList.toggle("border-line", !isError);
    document.getElementById("editing").hidden = false;
  }

  function restore() {
    if (data.configError) {
      notice(data.configError + " Nothing below was changed, so you can still build a new install.", true);
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
    if (config.audioLang) document.getElementById("audio-lang").value = config.audioLang;

    notice("You are editing an install. Change what you need and install again — the new link replaces the old one, which keeps working. Source URLs are shown without their /manifest.json. Keep this page private: it carries the API key if you added one.");
    generate();
  }

  restore();
}());
`;

export interface ConfigPageView {
  /** The install/health data, already JSON-encoded and safe to inline in a script tag. */
  data: string;
  /** The project's source URL, for the footer. */
  repo: string;
}

export function configPageHtml(view: ConfigPageView): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>TheIntroDB Skip — Stremio addon</title>
<style>${TAILWIND_CSS}</style>
</head>
<body>
<main class="mx-auto max-w-190 px-5 pt-10 pb-20">
  <header class="mb-2 flex items-center gap-3.5">
    <img class="size-14" src="https://raw.githubusercontent.com/TheIntroDB/theintrodb-assets/main/badge.png" alt="TheIntroDB">
    <div>
      <h1 class="m-0 text-[22px] tracking-[-0.01em]">TheIntroDB Skip</h1>
      <p class="m-0 mb-7 text-muted">A self-hosted Stremio addon that cuts intros, recaps, credits and previews, using timings from <a href="https://theintrodb.org">TheIntroDB</a>.</p>
    </div>
  </header>

  <section id="editing" class="mb-4.5 rounded-xl border border-line bg-panel p-5" hidden>
    <p id="notice" class="mb-4.5 rounded-lg border border-line bg-panel-2 px-3.5 py-3 text-sm" hidden></p>
  </section>

  <section class="mb-4.5 rounded-xl border border-line bg-panel p-5">
    <h2 class="mb-4 text-sm font-semibold uppercase tracking-[0.08em] text-muted">Configure</h2>
    <p id="error" class="mb-3.5 text-red-400" hidden></p>
    <div class="mb-4.5">
      <label class="mb-1.5 block font-semibold" for="sources">Your stream addon URL(s)</label>
      <textarea id="sources" class="min-h-19 w-full resize-y rounded-lg border border-line bg-panel-2 px-3 py-2.5 font-mono text-[13px] text-fg" spellcheck="false" placeholder="https://your-aiostreams.example.com/manifest.json"></textarea>
      <p class="mt-1.5 text-[13px] text-muted">One per line, tried in order; the first to answer is used, so a second is a fallback. Any Stremio <span class="font-mono text-[13px]">stream</span> addon works: AIOStreams, Torrentio, Comet…</p>
    </div>

    <div class="mb-4.5">
      <label class="mb-1.5 block font-semibold">Segments to cut</label>
      <div class="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-2.5">
        <label class="flex items-center gap-2 rounded-lg border border-line bg-panel-2 px-3 py-2.5 font-medium"><input class="size-4 accent-accent" type="checkbox" id="type-intro" checked> Intro</label>
        <label class="flex items-center gap-2 rounded-lg border border-line bg-panel-2 px-3 py-2.5 font-medium"><input class="size-4 accent-accent" type="checkbox" id="type-recap" checked> Recap</label>
        <label class="flex items-center gap-2 rounded-lg border border-line bg-panel-2 px-3 py-2.5 font-medium"><input class="size-4 accent-accent" type="checkbox" id="type-credits" checked> Credits</label>
        <label class="flex items-center gap-2 rounded-lg border border-line bg-panel-2 px-3 py-2.5 font-medium"><input class="size-4 accent-accent" type="checkbox" id="type-preview"> Preview</label>
      </div>
      <p class="mt-1.5 text-[13px] text-muted">Segments are removed from the playlist, so nothing plays and nothing has to be pressed. Credits and previews are off by default because their timings run to the end of the file.</p>
    </div>

    <div class="mb-4.5">
      <label class="mb-1.5 block font-semibold" for="cuts">Cutting</label>
      <select id="cuts" class="w-full rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-fg">
        <option value="mkv">Cut .mkv files too — processing card, then the title without its intro</option>
        <option value="hls">Only cut HLS playlists — leave files alone</option>
      </select>
      <p class="mt-1.5 text-[13px] text-muted">A debrid <span class="font-mono text-[13px]">.mkv</span> has no playlist, so it is packaged as HLS on demand: surviving stretches are copied into segments as it streams. <b>Cut .mkv files too</b> shows the processing card while the first ten seconds are made, then plays with the intro already gone; that buffered start stops the player treating a growing playlist as the end of the episode. <b>Only cut HLS</b> splices playlists and copies nothing. The choice is stored in your install link, so it can differ per install.</p>
    </div>

    <div class="mb-4.5">
      <label class="mb-1.5 block font-semibold" for="margin">Margin on every cut</label>
      <select id="margin" class="w-full rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-fg"></select>
      <p class="mt-1.5 text-[13px] text-muted">How much of each window's edges to leave alone. Cuts land on keyframes and TheIntroDB's timings may describe a different release, so the edges are where dialogue goes missing. A margin of 2 starts the skip two seconds late and ends it two seconds early; it never skips more than the timings ask. 0 cuts exactly what is reported.</p>
    </div>

    <div class="mb-4.5">
      <label class="mb-1.5 block font-semibold" for="audio-lang">Audio track</label>
      <select id="audio-lang" class="w-full rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-fg"></select>
      <p class="mt-1.5 text-[13px] text-muted">Which audio track is kept. Dubbed releases often mark a dub as default, so this language is preferred; otherwise English, then the file's own default. Files with one track are unaffected.</p>
    </div>

    <div class="mb-4.5">
      <label class="mb-1.5 block font-semibold">Subtitles</label>
      <p class="mt-1.5 text-[13px] text-muted">Cutting shifts the timeline, so existing text subtitles (subrip, ASS, WebVTT) are <b>cut and re-timed to match</b>, then offered as a track called TheIntroDB. It costs no CPU worth measuring and needs nothing from you.</p>
    </div>

    <div class="mb-4.5">
      <label class="mb-1.5 block font-semibold" for="key">TheIntroDB API key <span class="inline-block rounded-full border border-line px-2 py-0.5 text-xs text-muted" id="key-badge">required</span></label>
      <input type="password" id="key" class="w-full rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-fg" spellcheck="false" autocomplete="off" placeholder="paste your key here, or leave it empty if this service has one">
      <p class="mt-1.5 text-[13px] text-muted" id="key-hint"></p>
    </div>

    <p class="mt-1.5 text-[13px] text-muted">Streams are relayed through this service because most debrid sources bind a link to the address that asked for it; the player would otherwise be refused. Deployment setting (<span class="font-mono text-[13px]">PROXY</span>), on by default.</p>

    <div class="mb-4.5">
      <label class="mb-1.5 block font-semibold" for="name">Addon name <span class="inline-block rounded-full border border-line px-2 py-0.5 text-xs text-muted">optional</span></label>
      <input type="text" id="name" class="w-full rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-fg" spellcheck="false" maxlength="40" placeholder="TheIntroDB Skip">
    </div>

    <div class="flex flex-wrap items-center gap-2.5">
      <button id="generate" class="cursor-pointer rounded-lg bg-accent px-4.5 py-2.75 font-bold text-[#05110a] disabled:cursor-default disabled:opacity-50" type="button">Generate install link</button>
      <span class="text-[13px] text-muted">Runs entirely in your browser.</span>
    </div>
  </section>

  <section id="output" class="mb-4.5 rounded-xl border border-line bg-panel p-5" hidden>
    <h2 class="mb-4 text-sm font-semibold uppercase tracking-[0.08em] text-muted">Install</h2>
    <code id="manifest-url" class="mb-3 block break-all rounded-lg border border-line bg-panel-2 p-3 font-mono text-[13px]"></code>
    <div class="mb-4 flex flex-wrap gap-2.5">
      <a id="install-desktop" class="rounded-lg border border-line bg-panel-2 px-3.5 py-2.5 font-semibold text-fg no-underline" href="#">Open in Stremio</a>
      <a id="install-web" class="rounded-lg border border-line bg-panel-2 px-3.5 py-2.5 font-semibold text-fg no-underline" href="#">Open in Stremio Web</a>
      <button class="rounded-lg border border-line bg-panel-2 px-3.5 py-2.5 font-semibold text-fg" id="copy" type="button">Copy manifest URL</button>
    </div>
    <p class="mt-1.5 text-[13px] text-muted">Your settings live in this URL, so keep it private. Re-run the form to change anything; Stremio replaces the addon when the id matches.</p>
  </section>

  <section class="mb-4.5 rounded-xl border border-line bg-panel p-5">
    <h2 class="mb-4 text-sm font-semibold uppercase tracking-[0.08em] text-muted">How it works</h2>
    <ul class="mt-2 list-disc pl-5 text-muted">
      <li class="mb-1.5">Stremio asks this service for streams; it asks your source addon and returns what it finds.</li>
      <li class="mb-1.5">Timings come from TheIntroDB (<span class="font-mono text-[13px]">/v4/media</span>) by IMDb id, season and episode.</li>
      <li class="mb-1.5"><b>HLS sources</b> (an <span class="font-mono text-[13px]">.m3u8</span>): playlists are fetched, segments inside the windows dropped, and <span class="font-mono text-[13px]">#EXT-X-DISCONTINUITY</span> marks the jump. No video passes through this service.</li>
      <li class="mb-1.5"><b>Files</b> (a debrid <span class="font-mono text-[13px]">.mkv</span>/<span class="font-mono text-[13px]">.mp4</span>): each surviving stretch is copied into MPEG-TS segments with ffmpeg (<span class="font-mono text-[13px]">-c copy</span>, no re-encode), and the playlist lists only complete segments. Playback starts after the first segment and the playlist grows while you watch; dropped stretches are never generated, and the segments double as the cache.</li>
      <li class="mb-1.5">When TheIntroDB has no timings — or the source cannot be cut — the stream passes through untouched.</li>
    </ul>
  </section>

  <section class="mb-4.5 rounded-xl border border-line bg-panel p-5">
    <h2 class="mb-4 text-sm font-semibold uppercase tracking-[0.08em] text-muted">This instance</h2>
    <ul class="mt-2 list-disc pl-5 text-muted">
      <li class="mb-1.5">Files: <span class="font-mono text-[13px]" id="cuts-mode"></span></li>
      <li class="mb-1.5">Relaying streams: <span class="font-mono text-[13px]" id="proxy-relay"></span></li>
      <li class="mb-1.5">Margin on each cut: <span class="font-mono text-[13px]" id="cuts-margin"></span></li>
      <li class="mb-1.5">Segment cache: <span class="font-mono text-[13px]" id="cuts-cache"></span></li>
      <li class="mb-1.5">ffmpeg: <span class="font-mono text-[13px]" id="cuts-ffmpeg"></span></li>
      <li class="mb-1.5">Reading timings from <span class="font-mono text-[13px]" id="api"></span> — instance <span class="font-mono text-[13px]" id="origin"></span></li>
    </ul>
  </section>

  <section class="mb-4.5 rounded-xl border border-line bg-panel p-5">
    <h2 class="mb-4 text-sm font-semibold uppercase tracking-[0.08em] text-muted">Know before you install</h2>
    <ul class="mt-2 list-disc pl-5 text-muted">
      <li class="mb-1.5">Cuts land on keyframes (files) or segment boundaries (HLS). Nothing is re-encoded, so a moment of the skipped window can be kept — <i>never</i> footage you should hear.</li>
      <li class="mb-1.5">For a file, only surviving stretches are fetched, in playback order; the segments are kept for the next playback. Pick <span class="font-mono text-[13px]">Only cut HLS playlists</span> above to never touch video.</li>
      <li class="mb-1.5">Segments are evicted oldest-first once <span class="font-mono text-[13px]">CACHE_MAX_GB</span> is reached, so the cache settles on what you actually watch.</li>
      <li class="mb-1.5">Sources needing custom headers, and torrents (<span class="font-mono text-[13px]">infoHash</span>), are passed through.</li>
      <li class="mb-1.5">Timings come from TheIntroDB only — no chapter detection, no second database.</li>
      <li class="mb-1.5">Series numbering is the default order; another order (absolute-numbered anime) can apply the wrong episode's timings.</li>
    </ul>
  </section>

  <footer class="text-center text-[13px] text-muted">
    <p><span class="inline-block rounded-full border border-line px-2 py-0.5 text-xs text-muted" id="version"></span> · <a href="${view.repo}">Source</a> · GPL-3.0-or-later · built on <a href="https://theintrodb.org">TheIntroDB</a></p>
  </footer>
</main>
<script id="config-data" type="application/json">${view.data}</script>
<script>${CONFIG_PAGE_SCRIPT}</script>
</body>
</html>
`;
}
