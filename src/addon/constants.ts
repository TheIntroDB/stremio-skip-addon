// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * The fixed API version. This is not configuration: the addon is TheIntroDB's, and a
 * deployment that talked to a different version would be a different addon. Nothing here
 * is read from the environment.
 */

/** The API version these requests are written against. */
export const INTRODB_API_VERSION = "v4";
