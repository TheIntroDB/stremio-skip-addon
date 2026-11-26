// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * One version, two places — and they have to agree.
 *
 * `ADDON_VERSION` is what a deployment *reports* (the manifest, `/health`, and the update check);
 * `package.json`'s `version` is what npm *publishes* and what the registry's `latest` answers with. A
 * bump that touches one and not the other publishes a package that claims to be older than itself, so
 * every deployment built from it sits behind for ever.
 *
 * The release workflow compares the tag with `package.json`; this is the third leg, and it runs on
 * `main` where a mismatch is cheapest to fix.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ADDON_VERSION } from "../src/addon/manifest.js";

test("the runtime version is the published version", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version?: string };
  assert.equal(
    ADDON_VERSION,
    manifest.version,
    "src/addon/manifest.ts ADDON_VERSION and package.json version must be bumped together",
  );
});
