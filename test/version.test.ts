// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

import assert from "node:assert/strict";
import test from "node:test";

import { isNewer, UpstreamVersion } from "../src/addon/version.js";

const repositorySays = (version: string, calls: string[] = []) =>
  (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ version }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

test("a bigger version in the repository is newer, whatever the digits are", () => {
  assert.equal(isNewer("0.2.0", "0.1.0"), true);
  assert.equal(isNewer("0.10.0", "0.9.0"), true, "ten is not less than nine");
  assert.equal(isNewer("1.0.0", "0.9.9"), true);
  assert.equal(isNewer("0.1.0", "0.1.0"), false, "the same version is not an update");
  assert.equal(isNewer("0.0.9", "0.1.0"), false, "nor is an older one");
  assert.equal(isNewer("v0.2.0", "0.1.0"), true, "a leading v is not a different version");
  // A prerelease on `main` is a mistake in the release, not an upgrade.
  assert.equal(isNewer("0.2.0-rc.1", "0.1.0"), false);
  // Anything unparseable answers no: a wrong "out of date" is worse than none.
  assert.equal(isNewer("nightly", "0.1.0"), false);
  assert.equal(isNewer(undefined as unknown as string, "0.1.0"), false);
});

test("the notice appears only when the repository is ahead", async () => {
  const calls: string[] = [];
  const version = new UpstreamVersion(
    "0.1.0",
    "https://example.test/package.json",
    repositorySays("0.2.0", calls),
  );
  assert.equal(version.notice, null, "nothing is known before the first check");
  await version.refresh();
  assert.equal(version.upstream, "0.2.0");
  assert.equal(version.behind, true);
  assert.equal(version.notice, "This addon is out of date — v0.2.0 is available");
  assert.equal(calls.length, 1);
  assert.equal(calls[0], "https://example.test/package.json");

  const current = new UpstreamVersion(
    "0.2.0",
    "https://example.test/package.json",
    repositorySays("0.2.0"),
  );
  await current.refresh();
  assert.equal(current.notice, null, "a deployment that is current says nothing");
});

test("a repository that cannot be read is not an update, and is asked again later", async () => {
  const version = new UpstreamVersion("0.1.0", "https://example.test/package.json", (async () => {
    throw new Error("getaddrinfo ENOTFOUND raw.githubusercontent.com");
  }) as unknown as typeof fetch);
  await version.refresh();
  assert.equal(version.upstream, null);
  assert.equal(version.notice, null, "offline is not 'out of date'");
});

test("a fresh answer is not asked for twice", async () => {
  const calls: string[] = [];
  const version = new UpstreamVersion(
    "0.1.0",
    "https://example.test/package.json",
    repositorySays("0.2.0", calls),
  );
  await version.refresh();
  await version.refresh();
  await version.refresh();
  assert.equal(calls.length, 1, "the answer is trusted for an hour");
});
