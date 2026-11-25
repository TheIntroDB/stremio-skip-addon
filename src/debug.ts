// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * `/debug` -- what this process is doing, and one button that stops all of it.
 *
 * The page exists for the question "why is it still working?" and for the answer "stop, and start
 * again from nothing": a new stream test wants the cache empty and no ffmpeg or recognition job
 * left over from the last one. It reads the same state `/health` reports, renders it as text, and
 * polls `/debug.json` so a drain can be watched going quiet.
 *
 * Nothing secret is rendered: no API key, no source URL, no install config.
 */

import { formatBytes, type CacheEntry } from "./drain.js";

export interface DebugOptions {
  origin: string;
  version: string;
  /** Every setting /health reports, minus the key. */
  settings: Record<string, unknown>;
  subtitles: Record<string, unknown>;
  cuts: Record<string, unknown>;
  cache: CacheEntry[];
  /** The last failure, from `diagnostics`. */
  lastError: { at: string; request: string; detail: string } | null;
  /** Whether this deployment requires a secret to drain. */
  drainProtected: boolean;
  /** Why the page was opened, when it was a redirect after a drain. */
  drained?: { jobs: number; packages: number; dirs: number; bytes: number } | null;
}

const STYLE = `
  :root {
    color-scheme: dark;
    --bg: #0b0d0c; --panel: #121614; --panel-2: #171c19; --border: #232b27;
    --fg: #e7ece9; --muted: #93a09a; --accent: #16a34a; --accent-strong: #22c55e;
    --warn: #d9a12b; --danger: #dc2626;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg);
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 40px 20px 80px; }
  h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: -0.01em; }
  .sub { color: var(--muted); margin: 0 0 24px; font-size: 14px; }
  a { color: var(--accent-strong); }
  section { background: var(--panel); border: 1px solid var(--border); border-radius: 12px;
    padding: 20px; margin-bottom: 18px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted);
    margin: 0 0 14px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 6px 10px 6px 0; vertical-align: top;
    border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 600; width: 38%; }
  td.num { font-variant-numeric: tabular-nums; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  pre { background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px;
    padding: 12px; overflow: auto; max-height: 320px; white-space: pre-wrap; }
  .badge { display: inline-block; font-size: 11px; text-transform: uppercase;
    letter-spacing: 0.06em; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--border);
    color: var(--muted); }
  .badge.on { color: var(--accent-strong); border-color: var(--accent); }
  .badge.off { color: var(--warn); border-color: var(--warn); }
  button { font: inherit; font-weight: 600; border-radius: 8px; padding: 10px 16px;
    border: 1px solid var(--border); background: var(--panel-2); color: var(--fg); cursor: pointer; }
  button.drain { background: var(--danger); border-color: var(--danger); color: #fff; }
  button.drain:disabled { opacity: 0.5; cursor: progress; }
  .row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .hint { color: var(--muted); font-size: 13px; margin: 10px 0 0; }
  .muted { color: var(--muted); }
  .ok { color: var(--accent-strong); }
  .warn { color: var(--warn); }
  #result { font-size: 14px; min-height: 1.55em; }
`;

/** JSON rendered as a table, one level deep: the shapes here are flat records. */
function table(record: Record<string, unknown>): string {
  const rows = Object.entries(record)
    .map(([name, value]) => {
      const shown =
        value === null || value === undefined
          ? "<span class=\"muted\">—</span>"
          : typeof value === "object"
            ? `<code>${escapeHtml(JSON.stringify(value))}</code>`
            : `<code>${escapeHtml(String(value))}</code>`;
      return `<tr><th>${escapeHtml(name)}</th><td>${shown}</td></tr>`;
    })
    .join("");
  return `<table>${rows}</table>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The push a drain does, as JSON, for the page and for anything else that wants it. */
export interface DrainResult {
  stopped: { jobs: number; packages: number };
  purged: { dirs: number; bytes: number };
  at: string;
}

export function renderDebugPage(options: DebugOptions): string {
  const { subtitles, cuts, cache } = options;
  const cacheRows = cache
    .map(
      (entry) =>
        `<tr><th>${escapeHtml(entry.name)}</th><td class="num">${entry.entries} ${
          entry.name === "hls" ? "packages" : entry.name === "subs" ? "tracks" : "files"
        } · ${formatBytes(entry.bytes)} ${
          entry.cleared ? '<span class="badge off">cleared by drain</span>' : '<span class="badge on">kept</span>'
        }</td></tr>`,
    )
    .join("");

  const progress = Array.isArray(subtitles.progress)
    ? (subtitles.progress as Array<Record<string, unknown>>)
    : [];
  const progressRows = progress.length
    ? progress
        .map(
          (job) =>
            `<tr><th>track</th><td class="num">${job.done}/${job.chunks} chunks · ${job.cues} cues · ` +
            `audio <code>${escapeHtml(String(job.audio ?? "default"))}</code>` +
            `${job.idle ? ' · <span class="warn">idle</span>' : ""}` +
            `${job.error ? ` · <span class="warn">${escapeHtml(String(job.error))}</span>` : ""}</td></tr>`,
        )
        .join("")
    : `<tr><th>track</th><td class="muted">none being made</td></tr>`;

  const drained = options.drained
    ? `<p class="ok">Drained: stopped ${options.drained.jobs} subtitle job(s) and ` +
      `${options.drained.packages} package(s), deleted ${formatBytes(options.drained.bytes)} ` +
      `from ${options.drained.dirs} director${options.drained.dirs === 1 ? "y" : "ies"}.</p>`
    : "";

  const lastError = options.lastError
    ? `<p class="muted"><code>${escapeHtml(options.lastError.at)}</code> · ` +
      `<code>${escapeHtml(options.lastError.request)}</code></p>` +
      `<pre>${escapeHtml(options.lastError.detail)}</pre>`
    : `<p class="muted">Nothing has failed since this process started.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>TheIntroDB Skip — debug</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <h1>TheIntroDB Skip — debug</h1>
  <p class="sub">v${escapeHtml(options.version)} · <a href="${escapeHtml(options.origin)}/health">/health</a> · <a href="${escapeHtml(options.origin)}/">configure</a></p>

  <section>
    <h2>Drain</h2>
    <p>Stops every ffmpeg and every subtitle job this process is running, then deletes the two
    working directories — packages and generated tracks — so the next playback starts from
    nothing. The speech models are kept; re-downloading them is minutes of network for no reason.
    Use it before testing a new stream.</p>
    <div class="row">
      <button class="drain" id="drain">Drain and wipe the cache</button>
      <span id="result">${options.drainProtected ? '<span class="warn">This deployment requires the drain secret.</span>' : ""}</span>
    </div>
    ${drained}
    <p class="hint">Running this while a player is watching interrupts that playback: the segments
    it had are deleted, and it will ask for a package that no longer exists.</p>
  </section>

  <section>
    <h2>Cache</h2>
    <table>${cacheRows || '<tr><th>cache</th><td class="muted">empty</td></tr>'}</table>
    <p class="hint">Total ${formatBytes(cache.reduce((sum, entry) => sum + entry.bytes, 0))}.</p>
  </section>

  <section>
    <h2>Subtitles</h2>
    <table>
      ${table({
        enabled: subtitles.enabled,
        language: subtitles.language,
        audioTrack: options.settings.subtitlesAudioLanguage,
        idleSeconds: subtitles.idleSeconds,
        active: subtitles.active,
        queued: subtitles.queued,
        stopped: subtitles.stopped,
        ready: subtitles.tracks,
        models: subtitles.models,
        modelsError: subtitles.modelsError,
      })}
      ${progressRows}
      <tr><th>served</th><td class="num"><code>${escapeHtml(JSON.stringify(subtitles.served ?? {}))}</code></td></tr>
    </table>
  </section>

  <section>
    <h2>Packaging</h2>
    ${table({
      available: cuts.available,
      active: cuts.active,
      queued: cuts.queued,
      packages: cuts.packages,
      segments: cuts.segments,
      "card pieces": cuts.cardPieces,
      splash: cuts.splash,
      splashError: cuts.splashError,
      bytes: formatBytes(Number(cuts.bytes) || 0),
      lastError: cuts.lastError,
    })}
  </section>

  <section>
    <h2>Last error</h2>
    ${lastError}
  </section>
</main>
<script>
(function () {
  var button = document.getElementById("drain");
  var result = document.getElementById("result");
  var drainProtected = ${options.drainProtected ? "true" : "false"};

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
</script>
</body>
</html>
`;
}

/** The same snapshot the page renders, as JSON, so it can be polled without re-reading HTML. */
export function renderDebugJson(options: DebugOptions): Record<string, unknown> {
  return {
    version: options.version,
    settings: options.settings,
    subtitles: options.subtitles,
    cuts: options.cuts,
    cache: options.cache,
    lastError: options.lastError,
    drainProtected: options.drainProtected,
  };
}
