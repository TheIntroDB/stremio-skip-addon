// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

import assert from "node:assert/strict";
import test from "node:test";

import { isNewer, PACKAGE_NAME, UpdateChecker } from "../src/addon/updates.js";

const registrySays = (version: string, calls: string[] = []) =>
  (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ version }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

test("a bigger version is newer, whatever the digits are", () => {
  assert.equal(isNewer("0.2.0", "0.1.0"), true);
  assert.equal(isNewer("1.0.0", "0.9.9"), true);
  // The trap in every hand-written comparison: "0.10.0" is newer than "0.9.0", not older.
  assert.equal(isNewer("0.10.0", "0.9.0"), true);
  assert.equal(isNewer("0.9.0", "0.10.0"), false);
  assert.equal(isNewer("1.0.0", "1.0.0"), false, "the same version is not an update");
  assert.equal(isNewer("0.0.9", "0.1.0"), false, "and an older one is not either");
  assert.equal(isNewer("v1.2.0", "1.1.0"), true, "a leading v is not a different version");
  // A prerelease on `latest` is a mistake in the release, not an upgrade: stripping the suffix would
  // announce `0.2.0-rc.1` as `0.2.0` and send every deployment chasing a version that is not released.
  assert.equal(isNewer("0.2.0-rc.1", "0.1.0"), false, "a prerelease is never an update");
  assert.equal(isNewer("0.2.0-beta", "0.1.0"), false);
  assert.equal(isNewer("1.0.0-rc.1", "0.9.0"), false);
  // A tag nobody can parse is not something to tell a viewer about.
  assert.equal(isNewer("nightly", "0.1.0"), false);
  assert.equal(isNewer("1.0.0", "dev"), false);
});

test("the checker is behind only when the registry's latest is bigger", async () => {
  const calls: string[] = [];
  const checker = new UpdateChecker("0.1.0", true, registrySays("0.2.0", calls));
  assert.equal(checker.get().behind, false, "nothing has been asked yet");
  const status = await checker.check();
  assert.equal(status.current, "0.1.0");
  assert.equal(status.latest, "0.2.0");
  assert.equal(status.behind, true, "0.2.0 is bigger than 0.1.0");
  assert.equal(status.error, null);
  assert.ok(status.checkedAt, "and it says when it asked");
  assert.ok(
    decodeURIComponent(calls[0] ?? "").includes(PACKAGE_NAME),
    "from the package's own registry entry",
  );
});

test("a registry that is up to date, or down, never claims an update", async () => {
  const same = await new UpdateChecker("0.1.0", true, registrySays("0.1.0")).check();
  assert.equal(same.behind, false);
  assert.equal(same.latest, "0.1.0");

  const older = await new UpdateChecker("0.2.0", true, registrySays("0.1.0")).check();
  assert.equal(older.behind, false);

  const down = await new UpdateChecker("0.1.0", true, (async () => {
    throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
  }) as typeof fetch).check();
  assert.equal(down.behind, false, "a deployment with no route to npm has no opinion");
  assert.match(down.error ?? "", /ENOTFOUND/);

  const missing = await new UpdateChecker("0.1.0", true, (async () => {
    throw new Error("registry answered 404");
  }) as typeof fetch).check();
  assert.equal(missing.latest, null);
  assert.equal(missing.behind, false);
});

test("a check that fails has no opinion, even if the last one had", async () => {
  // behind=true, then the registry goes away: the deployment must stop telling its viewer to update,
  // not keep saying so for another six hours on the strength of a check that no longer works.
  let fail = false;
  const checker = new UpdateChecker("0.1.0", true, (async () => {
    if (fail) throw new Error("ECONNREFUSED");
    return new Response(JSON.stringify({ version: "0.2.0" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);
  assert.equal((await checker.check()).behind, true, "it starts out behind");
  fail = true;
  const after = await checker.check();
  assert.equal(after.behind, false, "and stops claiming so when it cannot check");
  assert.equal(after.latest, null);
  assert.equal(after.current, "0.1.0", "who it is does not change");
  assert.match(after.error ?? "", /ECONNREFUSED/);
});

test("a deployment that has turned the check off never asks", async () => {
  const calls: string[] = [];
  const checker = new UpdateChecker("0.1.0", false, registrySays("0.2.0", calls));
  const status = await checker.check();
  assert.equal(calls.length, 0, "not one request");
  assert.equal(status.behind, false);
  assert.match(status.error ?? "", /off/);
});

test("concurrent asks share one request", async () => {
  const calls: string[] = [];
  const checker = new UpdateChecker("0.1.0", true, registrySays("0.2.0", calls));
  await Promise.all([checker.check(), checker.check(), checker.check()]);
  assert.equal(calls.length, 1, "three callers, one trip to the registry");
});
