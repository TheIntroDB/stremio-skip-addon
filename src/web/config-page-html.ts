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
    box.hidden = false;
    box.classList.toggle("border-red-900", Boolean(isError));
    box.classList.toggle("text-red-400", Boolean(isError));
    box.classList.toggle("border-line", !isError);
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
    if (config.audioLang) document.getElementById("audio-lang").value = config.audioLang;

    notice("You are editing an install. Change what you need and install again — the new link replaces the old one, and the old one keeps working. Source URLs are shown without their /manifest.json, which the addon fetches for you. Keep this page's address private: it is the configuration, and it carries the API key if you put one in it.");
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
      <p class="m-0 mb-7 text-muted">A self-hosted Stremio addon that removes intros, recaps, credits and previews from your streams, using community timings from <a href="https://theintrodb.org">TheIntroDB</a>.</p>
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
      <p class="mt-1.5 text-[13px] text-muted">One per line, tried in order. The first one that answers with streams is used, so a second URL is a fallback. Any Stremio <span class="font-mono text-[13px]">stream</span> addon works: AIOStreams, Torrentio, Comet, MediaFusion…</p>
    </div>

    <div class="mb-4.5">
      <label class="mb-1.5 block font-semibold">Segments to cut</label>
      <div class="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-2.5">
        <label class="flex items-center gap-2 rounded-lg border border-line bg-panel-2 px-3 py-2.5 font-medium"><input class="size-4 accent-accent" type="checkbox" id="type-intro" checked> Intro</label>
        <label class="flex items-center gap-2 rounded-lg border border-line bg-panel-2 px-3 py-2.5 font-medium"><input class="size-4 accent-accent" type="checkbox" id="type-recap" checked> Recap</label>
        <label class="flex items-center gap-2 rounded-lg border border-line bg-panel-2 px-3 py-2.5 font-medium"><input class="size-4 accent-accent" type="checkbox" id="type-credits" checked> Credits</label>
        <label class="flex items-center gap-2 rounded-lg border border-line bg-panel-2 px-3 py-2.5 font-medium"><input class="size-4 accent-accent" type="checkbox" id="type-preview"> Preview</label>
      </div>
      <p class="mt-1.5 text-[13px] text-muted">A cut is a real cut: the segments are removed from the playlist, so nothing plays and nothing has to be pressed. Credits and previews are off by default because their timings run to the end of the file.</p>
    </div>

    <div class="mb-4.5">
      <label class="mb-1.5 block font-semibold" for="cuts">Cutting</label>
      <select id="cuts" class="w-full rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-fg">
        <option value="mkv">Cut .mkv files too — the processing card, then the title without its intro</option>
        <option value="hls">Only cut HLS playlists — leave .mkv/.mp4 files alone</option>
      </select>
      <p class="mt-1.5 text-[13px] text-muted">A file with no playlist of its own (a debrid <span class="font-mono text-[13px]">.mkv</span>) is packaged as HLS on demand: the stretches that survive are copied into segments as the video is streamed. <b>Cut .mkv files too</b> shows the processing card while the first ten seconds of the cut file are made, and then plays the title with the intro already gone — that buffered start is what stops a player reaching the end of a growing playlist and deciding the episode is over. <b>Only cut HLS</b> never touches a <span class="font-mono text-[13px]">.mkv</span>: playlists are still spliced, nothing is copied and no disk is used. This choice is stored in your install link, so it can differ per install.</p>
    </div>

    <div class="mb-4.5">
      <label class="mb-1.5 block font-semibold" for="margin">Margin on every cut</label>
      <select id="margin" class="w-full rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-fg"></select>
      <p class="mt-1.5 text-[13px] text-muted">How much of each window's edges to leave alone. A cut can only land on a keyframe, and TheIntroDB's timings describe <i>a</i> release of a title rather than necessarily yours, so the first and last seconds of an intro are where dialogue goes missing. With a margin of 2, the skip starts two seconds after the reported start and ends two seconds before the reported end — it never skips more than the timings ask for. 0 cuts exactly what TheIntroDB reports.</p>
    </div>

    <div class="mb-4.5">
      <label class="mb-1.5 block font-semibold" for="audio-lang">Audio track</label>
      <select id="audio-lang" class="w-full rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-fg"></select>
      <p class="mt-1.5 text-[13px] text-muted">Which audio track of the file is kept and served. A release with dubs often marks one of them as its default track, and ffmpeg then keeps that one — so an English viewer gets the dub. The language chosen here is preferred; if the file has no track in it, English is used; if there is no English either, the file's own default track is. Files with one audio track are unaffected.</p>
    </div>

    <div class="mb-4.5">
      <label class="mb-1.5 block font-semibold">Subtitles</label>
      <p class="mt-1.5 text-[13px] text-muted">Cutting removes stretches, so a subtitle track recorded against the original timeline would drift behind the picture. When the file already carries text subtitles (subrip, ASS, WebVTT — most releases do), they are <b>cut and re-timed to match</b> and offered to the player as its own track, called TheIntroDB. It costs one pass over the file and no CPU worth measuring, and it needs nothing from you.</p>
      <p class="mt-1.5 text-[13px] text-muted">Recognising speech to make a track where the file has none is <b>turned off</b> in this build: it is minutes of CPU per episode on the host, which is not worth the stall.</p>
    </div>

    <div class="mb-4.5">
      <label class="mb-1.5 block font-semibold" for="key">TheIntroDB API key <span class="inline-block rounded-full border border-line px-2 py-0.5 text-xs text-muted" id="key-badge">required</span></label>
      <input type="password" id="key" class="w-full rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-fg" spellcheck="false" autocomplete="off" placeholder="paste your key here, or leave it empty if this service has one">
      <p class="mt-1.5 text-[13px] text-muted" id="key-hint"></p>
    </div>

    <p class="mt-1.5 text-[13px] text-muted">Streams are relayed through this service. Most sources bind a link to the address that asked for it (ElfHosted Comet and other debrid setups do), so the player would otherwise be refused with &quot;this stream link only works on the internet connection that requested it&quot;. It is a deployment setting (<span class="font-mono text-[13px]">PROXY</span>), on by default because the sources people actually use are debrid files.</p>

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
    <p class="mt-1.5 text-[13px] text-muted">Your settings live in this URL, so keep it private: anyone who has it can use this Worker. Re-run the form and install again to change anything — Stremio replaces the addon when the id matches.</p>
  </section>

  <section class="mb-4.5 rounded-xl border border-line bg-panel p-5">
    <h2 class="mb-4 text-sm font-semibold uppercase tracking-[0.08em] text-muted">How it works</h2>
    <ul class="mt-2 list-disc pl-5 text-muted">
      <li class="mb-1.5">Stremio asks this service for streams. It asks your source addon and returns what it finds.</li>
      <li class="mb-1.5">For the title being played, timings are read from TheIntroDB (<span class="font-mono text-[13px]">/v4/media</span>) by IMDb id, plus season and episode.</li>
      <li class="mb-1.5"><b>HLS sources</b> (an <span class="font-mono text-[13px]">.m3u8</span>): the playlists are fetched, the segments covering those ranges are dropped and <span class="font-mono text-[13px]">#EXT-X-DISCONTINUITY</span> marks the jump. No video passes through this service at all.</li>
      <li class="mb-1.5"><b>Files</b> (a debrid <span class="font-mono text-[13px]">.mkv</span>/<span class="font-mono text-[13px]">.mp4</span>, no playlist to rewrite): each stretch that survives the windows is copied into MPEG-TS segments with ffmpeg (<span class="font-mono text-[13px]">-c copy</span>, no re-encode), and a playlist is written from <i>exactly the segments that are complete</i>. The player is handed that playlist after the first segment — a couple of seconds — and it grows while they watch, so playback never waits for the file. The dropped stretches are never generated: the playlist jumps over them with <span class="font-mono text-[13px]">#EXT-X-DISCONTINUITY</span>, and a finished package is an ordinary seekable VOD playlist. The segments the player pulls are the cache, so nothing is fetched twice.</li>
      <li class="mb-1.5">When TheIntroDB has no timings — or the source cannot be cut — the stream is passed through untouched.</li>
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
      <li class="mb-1.5">Cuts land on a keyframe for a file and on a segment boundary for HLS. Nothing is ever re-encoded, so the cut is only as precise as the keyframe grid and a moment of the skipped window can be kept — <i>never</i> the other way round: footage you should hear is not dropped.</li>
      <li class="mb-1.5">For a file, only the stretches that survive are fetched, in the order they are watched: an episode is read once, as it plays, and the segments are kept for the next playback. Pick <span class="font-mono text-[13px]">Only cut HLS playlists</span> above to relay only HLS and never touch video.</li>
      <li class="mb-1.5">Segments are kept per title and evicted oldest-first once <span class="font-mono text-[13px]">CACHE_MAX_GB</span> is reached, so a large library settles into a cache of what you actually watch.</li>
      <li class="mb-1.5">Sources that need custom headers are not relayed, and a source that is a torrent (<span class="font-mono text-[13px]">infoHash</span>) has no URL to cut — both are passed through.</li>
      <li class="mb-1.5">Timings come from TheIntroDB only. There is no chapter detection and no second skip database.</li>
      <li class="mb-1.5">Series numbering is the default order. If your library follows another order (streaming rips, absolute-numbered anime), the wrong episode's timings can apply.</li>
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
