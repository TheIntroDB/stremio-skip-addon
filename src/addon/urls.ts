// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/** URL shapes the addon hands back to the client. One place, so they cannot drift. */

export function manifestUrl(origin: string, encodedConfig?: string): string {
  return encodedConfig ? `${origin}/${encodedConfig}/manifest.json` : `${origin}/manifest.json`;
}

/**
 * Where the player should ask for a playlist, with the media id for the lookup.
 *
 * `streamIdentity` is the stable identity of the source (see `streamIdentity` in
 * upstream.ts). It rides along because the target URL itself cannot be one: a debrid
 * link carries a token that is re-minted for every stream list, and a cut keyed on
 * that would never be found again.
 */
export function playUrl(
  origin: string,
  encodedConfig: string,
  target: string,
  id: string,
  streamIdentity?: string,
): string {
  const url = new URL(`${origin}/${encodedConfig}/play`);
  url.searchParams.set("u", target);
  if (id) url.searchParams.set("id", id);
  if (streamIdentity) url.searchParams.set("k", streamIdentity);
  return url.toString();
}

/** Where the player should ask for one media resource (proxy mode only). */
export function segmentUrl(origin: string, encodedConfig: string, target: string): string {
  const url = new URL(`${origin}/${encodedConfig}/seg`);
  url.searchParams.set("u", target);
  return url.toString();
}
