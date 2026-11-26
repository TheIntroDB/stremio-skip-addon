// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * Is there a newer release than the one running?
 *
 * The addon is installed as a package (`npx @theintrodb/stremio-skip-addon`, or the published Docker
 * image), so a deployment already knows how to update itself: pull the newer one. What it cannot know
 * is whether a newer one exists, and asking npm is the smallest way to answer that — the registry is
 * where the releases are, it needs no credentials, and its download counts are what tells us whether
 * anybody is using them.
 *
 * Nothing here is on a request's path: the answer is cached, refreshed at most every few hours in the
 * background, and a deployment that cannot reach npm simply says nothing. A self-hoster who would
 * rather not ask at all sets `UPDATE_CHECK=off`.
 */

/** The package this service is published as. Changing it is changing the release channel. */
export const PACKAGE_NAME = "@theintrodb/stremio-skip-addon";
const REGISTRY = `https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}/latest`;
/** How long an answer is trusted, and how often a deployment asks again. */
const CHECK_MS = 6 * 60 * 60_000;

export interface UpdateStatus {
  /** The version this process is running. */
  current: string;
  /** The registry's `latest`, when it could be read. */
  latest: string | null;
  /** Whether `latest` is newer than `current`. */
  behind: boolean;
  /** Where to read about it. */
  url: string;
  /** When the answer was last refreshed, in milliseconds, or null when it never was. */
  checkedAt: number | null;
  /** Why there is no answer, when there is not one. */
  error: string | null;
}

/**
 * `1.4.0` is newer than `1.3.9`: compared as numbers, so ten is not less than nine.
 *
 * Only the numeric part counts, and a prerelease is never an update: a `-rc` tag on `latest` is a
 * mistake in the release, not an upgrade. Anything unparseable answers false — a wrong "update
 * available" is worse than none, and a deployment that nags is a deployment people stop believing.
 */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (value: string): number[] | null => {
    const trimmed = value.trim().replace(/^v/i, "");
    // A prerelease is not something to tell a viewer about: `0.2.0-rc.1` on `latest` is a mistake in
    // the release, not an upgrade, and stripping the suffix would announce it as `0.2.0`.
    if (trimmed.includes("-")) return null;
    const core = trimmed.split("-")[0] ?? "";
    if (!/^\d+(\.\d+)*$/.test(core)) return null;
    return core.split(".").map(Number);
  };
  const next = parse(candidate);
  const now = parse(current);
  if (!next || !now) return false;
  for (let i = 0; i < Math.max(next.length, now.length); i += 1) {
    const a = next[i] ?? 0;
    const b = now[i] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}

export class UpdateChecker {
  private status: UpdateStatus;
  private inflight: Promise<UpdateStatus> | null = null;

  constructor(
    current: string,
    private readonly enabled = true,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.status = {
      current,
      latest: null,
      behind: false,
      url: `https://github.com/TheIntroDB/stremio-skip-addon/releases`,
      checkedAt: null,
      error: enabled ? null : "update check is off",
    };
  }

  /** The last answer. Never blocks, never fetches. */
  get(): UpdateStatus {
    return this.status;
  }

  /** Ask now. Safe to call from a timer; concurrent callers share one request. */
  async check(): Promise<UpdateStatus> {
    if (!this.enabled) return this.status;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const response = await this.fetchImpl(REGISTRY, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`registry answered ${response.status}`);
        const body = (await response.json()) as { version?: unknown };
        const latest = typeof body.version === "string" ? body.version.trim() : "";
        if (!latest) throw new Error("registry answered without a version");
        this.status = {
          ...this.status,
          latest,
          behind: isNewer(latest, this.status.current),
          checkedAt: Date.now(),
          error: null,
        };
      } catch (error) {
        this.status = {
          ...this.status,
          // A registry that cannot be reached has no opinion: keeping the last `behind` would leave a
          // deployment telling its viewer to update for another six hours on the strength of a check
          // that has since stopped working.
          latest: null,
          behind: false,
          checkedAt: Date.now(),
          error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
        };
      } finally {
        this.inflight = null;
      }
      return this.status;
    })();
    return this.inflight;
  }

  /** Ask only if the last answer is old enough, and never wait for it. */
  refresh(): void {
    if (!this.enabled) return;
    const at = this.status.checkedAt;
    if (at !== null && Date.now() - at < CHECK_MS) return;
    void this.check();
  }
}
