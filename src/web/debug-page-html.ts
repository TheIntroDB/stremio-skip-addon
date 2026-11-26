// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * The `/debug` document: markup and the drain button's client script.
 *
 * Kept apart from `debug-page.ts`, which assembles the tables and the last error.
 * Nothing here reads process state; it receives the already-rendered sections.
 */

import { escapeHtml } from "./escape-html.js";
import { TAILWIND_CSS } from "./styles.generated.js";

export interface DebugPageView {
  version: string;
  origin: string;
  drainProtected: boolean;
  /** The "drained" paragraph, when this page followed a drain. */
  drainedHtml: string;
  /** The cache table, including its empty state. */
  cacheHtml: string;
  /** Human-readable total of the cache table. */
  cacheTotal: string;
  /** The subtitles table, including its progress rows. */
  subtitlesHtml: string;
  /** The packaging table. */
  packagingHtml: string;
  /** The last-error block, or the "nothing failed" message. */
  lastErrorHtml: string;
}

/** The drain button: confirm, optionally ask for the secret, then reload. */
function drainScript(drainProtected: boolean): string {
  return `
(function () {
  var button = document.getElementById("drain");
  var result = document.getElementById("result");
  var drainProtected = ${drainProtected ? "true" : "false"};

  button.addEventListener("click", function () {
    if (!window.confirm("Stop everything and delete the packages and subtitle tracks on disk?")) return;
    var secret = "";
    if (drainProtected) {
      secret = window.prompt("Drain secret");
      if (secret === null) return;
    }
    button.disabled = true;
    result.textContent = "Draining…";
    fetch("/drain", { method: "POST", headers: { "x-tidb-drain": "1", "x-tidb-drain-secret": secret } })
      .then(function (response) { return response.json().then(function (body) { return { ok: response.ok, body: body }; }); })
      .then(function (outcome) {
        if (!outcome.ok) throw new Error(outcome.body.message || outcome.body.error || "drain refused");
        result.textContent = "Stopped " + outcome.body.stopped.jobs + " job(s) and " +
          outcome.body.stopped.packages + " package(s); deleted " +
          (outcome.body.purged.human || outcome.body.purged.bytes + " bytes") + ".";
        setTimeout(function () { window.location.href = "/debug"; }, 600);
      })
      .catch(function (error) {
        result.textContent = "Failed: " + error.message;
        button.disabled = false;
      });
  });
})();
`;
}

export function debugPageHtml(view: DebugPageView): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>TheIntroDB Skip — debug</title>
<style>${TAILWIND_CSS}</style>
</head>
<body>
<main class="mx-auto max-w-215 px-5 pt-10 pb-20">
  <h1 class="m-0 mb-1 text-[22px] tracking-[-0.01em]">TheIntroDB Skip — debug</h1>
  <p class="mb-6 text-sm text-muted">v${escapeHtml(view.version)} · <a href="${escapeHtml(view.origin)}/health">/health</a> · <a href="${escapeHtml(view.origin)}/">configure</a></p>

  <section class="mb-4.5 rounded-xl border border-line bg-panel p-5">
    <h2 class="mb-3.5 text-[13px] font-semibold uppercase tracking-[0.08em] text-muted">Drain</h2>
    <p>Stops every ffmpeg and every subtitle job this process is running, then deletes the two
    working directories — packages and generated tracks — so the next playback starts from
    nothing. The speech models are kept; re-downloading them is minutes of network for no reason.
    Use it before testing a new stream.</p>
    <div class="flex flex-wrap items-center gap-3">
      <button class="cursor-pointer rounded-lg border border-danger bg-danger px-4 py-2.5 font-semibold text-white disabled:cursor-progress disabled:opacity-50" id="drain">Drain and wipe the cache</button>
      <span class="min-h-[1.55em] text-sm" id="result">${view.drainProtected ? '<span class="text-warn">This deployment requires the drain secret.</span>' : ""}</span>
    </div>
    ${view.drainedHtml}
    <p class="mt-2.5 text-[13px] text-muted">Running this while a player is watching interrupts that playback: the segments
    it had are deleted, and it will ask for a package that no longer exists.</p>
  </section>

  <section class="mb-4.5 rounded-xl border border-line bg-panel p-5">
    <h2 class="mb-3.5 text-[13px] font-semibold uppercase tracking-[0.08em] text-muted">Cache</h2>
    ${view.cacheHtml}
    <p class="mt-2.5 text-[13px] text-muted">Total ${view.cacheTotal}.</p>
  </section>

  <section class="mb-4.5 rounded-xl border border-line bg-panel p-5">
    <h2 class="mb-3.5 text-[13px] font-semibold uppercase tracking-[0.08em] text-muted">Subtitles</h2>
    ${view.subtitlesHtml}
  </section>

  <section class="mb-4.5 rounded-xl border border-line bg-panel p-5">
    <h2 class="mb-3.5 text-[13px] font-semibold uppercase tracking-[0.08em] text-muted">Packaging</h2>
    ${view.packagingHtml}
  </section>

  <section class="mb-4.5 rounded-xl border border-line bg-panel p-5">
    <h2 class="mb-3.5 text-[13px] font-semibold uppercase tracking-[0.08em] text-muted">Last error</h2>
    ${view.lastErrorHtml}
  </section>
</main>
<script>${drainScript(view.drainProtected)}</script>
</body>
</html>
`;
}
