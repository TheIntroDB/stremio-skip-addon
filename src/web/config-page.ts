// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * The landing / configuration page.
 *
 * Everything the addon needs to know is packed into the addon URL, so this page
 * is just a builder for that URL: fill the form, get a manifest URL, install it.
 * No state is stored on the Worker and no account is involved.
 *
 * The document itself lives in `config-page-html.ts`; this module only assembles
 * the view model it is given.
 */

import { ADDON_VERSION } from "../addon/manifest.js";
import type { AddonConfig } from "../addon/types.js";
import { configPageHtml } from "./config-page-html.js";

export interface PageOptions {
  /** The deployment's default audio language, shown as the "Server default" entry. */
  audioLanguage: string;
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
    audioLanguage: options.audioLanguage,
    siteUrl: options.siteUrl,
    serverKeyConfigured: options.serverKeyConfigured,
    version: ADDON_VERSION,
    repo: REPO,
    insecure: options.insecure,
    cuts: options.cuts,
    config: options.editing ?? null,
    configError: options.configError ?? null,
  }).replace(/</g, "\\u003c");

  return configPageHtml({ data, repo: REPO });
}
