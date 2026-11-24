// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/** URL shapes the addon hands back to the client. One place, so they cannot drift. */

export function manifestUrl(origin: string, encodedConfig?: string): string {
  return encodedConfig ? `${origin}/${encodedConfig}/manifest.json` : `${origin}/manifest.json`;
}

/** Where the player should ask for a playlist, with the media id for the lookup. */
export function playUrl(origin: string, encodedConfig: string, target: string, id: string): string {
  const url = new URL(`${origin}/${encodedConfig}/play`);
  url.searchParams.set("u", target);
  if (id) url.searchParams.set("id", id);
  return url.toString();
}

/** Where the player should ask for one media resource (proxy mode only). */
export function segmentUrl(origin: string, encodedConfig: string, target: string): string {
  const url = new URL(`${origin}/${encodedConfig}/seg`);
  url.searchParams.set("u", target);
  return url.toString();
}
