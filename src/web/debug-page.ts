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
 *
 * The document itself lives in `debug-page-html.ts`; this module builds its tables.
 */

import { type CacheEntry, formatBytes } from "../ops/drain.js";
import { debugPageHtml } from "./debug-page-html.js";
import { escapeHtml } from "./escape-html.js";

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

const TH =
  "w-[38%] border-b border-line py-1.5 pr-2.5 text-left align-top font-semibold text-muted";
const TD = "border-b border-line py-1.5 pr-2.5 align-top";
const CODE = "font-mono text-[13px]";
const BADGE =
  "inline-block rounded-full border px-1.5 py-px text-[11px] uppercase tracking-[0.06em]";

/** JSON rendered as table rows, one level deep: the shapes here are flat records. */
function rows(record: Record<string, unknown>): string {
  return Object.entries(record)
    .map(([name, value]) => {
      const shown =
        value === null || value === undefined
          ? '<span class="text-muted">—</span>'
          : typeof value === "object"
            ? `<code class="${CODE}">${escapeHtml(JSON.stringify(value))}</code>`
            : `<code class="${CODE}">${escapeHtml(String(value))}</code>`;
      return `<tr><th class="${TH}">${escapeHtml(name)}</th><td class="${TD}">${shown}</td></tr>`;
    })
    .join("");
}

/** JSON rendered as a table, one level deep. */
function table(record: Record<string, unknown>): string {
  return `<table class="w-full border-collapse text-sm">${rows(record)}</table>`;
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
        `<tr><th class="${TH}">${escapeHtml(entry.name)}</th><td class="${TD} tabular-nums">${entry.entries} ${
          entry.name === "hls" ? "packages" : entry.name === "subs" ? "tracks" : "files"
        } · ${formatBytes(entry.bytes)} ${
          entry.cleared
            ? `<span class="${BADGE} border-warn text-warn">cleared by drain</span>`
            : `<span class="${BADGE} border-accent text-accent-strong">kept</span>`
        }</td></tr>`,
    )
    .join("");
  const cacheHtml = `<table class="w-full border-collapse text-sm">${
    cacheRows || `<tr><th class="${TH}">cache</th><td class="${TD} text-muted">empty</td></tr>`
  }</table>`;

  const progress = Array.isArray(subtitles.progress)
    ? (subtitles.progress as Array<Record<string, unknown>>)
    : [];
  const progressRows = progress.length
    ? progress
        .map(
          (job) =>
            `<tr><th class="${TH}">track</th><td class="${TD} tabular-nums">${job.done}/${job.chunks} chunks · ${job.cues} cues · ` +
            `audio <code class="${CODE}">${escapeHtml(String(job.audio ?? "default"))}</code>` +
            `${job.idle ? ' · <span class="text-warn">idle</span>' : ""}` +
            `${job.error ? ` · <span class="text-warn">${escapeHtml(String(job.error))}</span>` : ""}</td></tr>`,
        )
        .join("")
    : `<tr><th class="${TH}">track</th><td class="${TD} text-muted">none being made</td></tr>`;

  const subtitlesHtml =
    `<table class="w-full border-collapse text-sm">` +
    rows({
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
    }) +
    progressRows +
    `<tr><th class="${TH}">served</th><td class="${TD} tabular-nums"><code class="${CODE}">${escapeHtml(
      JSON.stringify(subtitles.served ?? {}),
    )}</code></td></tr>` +
    `</table>`;

  const packagingHtml = table({
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
  });

  const drainedHtml = options.drained
    ? `<p class="text-accent-strong">Drained: stopped ${options.drained.jobs} subtitle job(s) and ` +
      `${options.drained.packages} package(s), deleted ${formatBytes(options.drained.bytes)} ` +
      `from ${options.drained.dirs} director${options.drained.dirs === 1 ? "y" : "ies"}.</p>`
    : "";

  const lastErrorHtml = options.lastError
    ? `<p class="text-muted"><code class="${CODE}">${escapeHtml(options.lastError.at)}</code> · ` +
      `<code class="${CODE}">${escapeHtml(options.lastError.request)}</code></p>` +
      `<pre class="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-panel-2 p-3 font-mono text-[13px]">${escapeHtml(options.lastError.detail)}</pre>`
    : `<p class="text-muted">Nothing has failed since this process started.</p>`;

  return debugPageHtml({
    version: options.version,
    origin: options.origin,
    drainProtected: options.drainProtected,
    drainedHtml,
    cacheHtml,
    cacheTotal: formatBytes(cache.reduce((sum, entry) => sum + entry.bytes, 0)),
    subtitlesHtml,
    packagingHtml,
    lastErrorHtml,
  });
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
