// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * Fixed endpoints. These are not configuration: the addon is TheIntroDB's, and a
 * deployment that pointed somewhere else would be a different addon. Nothing here
 * is read from the environment, so `wrangler.jsonc` cannot be edited into a state
 * where the addon talks to a host it was not written for.
 */

/** The public, read-only TheIntroDB API. */
export const INTRODB_API_BASE = "https://api.theintrodb.org";

/** The public site, for links. */
export const INTRODB_SITE = "https://theintrodb.org";

/** The API version these requests are written against. */
export const INTRODB_API_VERSION = "v4";
