// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * The addon manifest.
 *
 * A stream addon is all this is: Stremio asks for streams, the addon answers with
 * streams. There is no catalog and no meta, and the ids it accepts are IMDb ids
 * because that is what Stremio hands a stream addon and what TheIntroDB accepts.
 */

import { configIdSuffix } from "./config.js";
import type { AddonConfig } from "./types.js";

export const ADDON_VERSION = "1.0.0";
export const ADDON_LOGO =
  "https://raw.githubusercontent.com/TheIntroDB/.github/main/integrations/stremio.png";
const REPO_URL = "https://github.com/TheIntroDB/stremio-skip-addon";

const DESCRIPTION =
  "Cuts intro, recap, credits and preview segments out of HLS streams using community " +
  "timings from TheIntroDB (theintrodb.org). Streams are relayed from the source addon you " +
  "configure; when TheIntroDB has no timings for an episode, the stream is passed through " +
  "untouched.";

export interface ManifestShape {
  id: string;
  version: string;
  name: string;
  description: string;
  logo: string;
  resources: string[];
  types: string[];
  idPrefixes: string[];
  catalogs: unknown[];
  behaviorHints: Record<string, unknown>;
}

/** `config === null` builds the manifest for a bare, unconfigured install. */
export function buildManifest(config: AddonConfig | null, encodedConfig?: string): ManifestShape {
  const configured = config !== null && Boolean(encodedConfig);
  const extra = configured
    ? {
        "Skip:": config!.types.length > 0 ? config!.types.join(", ") : "nothing (no segment type selected)",
        "Source:": config!.src.map((url) => url.replace(/^https?:\/\//, "")).join(", "),
        "Docs:": REPO_URL,
      }
    : { "Configure this addon first:": `${REPO_URL}#configure` };

  const description = [DESCRIPTION, "", ...Object.entries(extra).map(([k, v]) => `${k} ${v}`)].join(
    "\n",
  );

  return {
    id: configured ? `org.theintrodb.stremio.skip.${configIdSuffix(encodedConfig!)}` : "org.theintrodb.stremio.skip",
    version: ADDON_VERSION,
    name: config?.name || "TheIntroDB Skip",
    description,
    logo: ADDON_LOGO,
    resources: ["stream"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs: [],
    behaviorHints: {
      configurable: true,
      // A bare install has nowhere to get streams from, so it must be configured.
      configurationRequired: !configured,
    },
  };
}
