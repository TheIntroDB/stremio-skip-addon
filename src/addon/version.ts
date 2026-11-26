// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * Is the version this deployment runs older than the one in the repository?
 *
 * The repository is the release: `main`'s `package.json` carries the version a fresh deployment gets,
 * and this asks for that one file. No registry, no API, no token — and nothing on a request's path: the
 * answer is cached and refreshed in the background, so a slow or unreachable GitHub costs a deployment
 * nothing but the notice.
 *
 * The notice appears in two places, both of which are a person wondering whether their copy is current:
 * the configuration page (fetched by the *browser*, see `config-page-html.ts`) and the processing card
 * (`cardText`), which says it while the viewer is already watching.
 */

/** The version a fresh deployment would get. Override with `UPDATE_VERSION_URL` for a fork. */
export const VERSION_URL =
  process.env.UPDATE_VERSION_URL?.trim() ||
  "https://raw.githubusercontent.com/TheIntroDB/stremio-skip-addon/main/package.json";

/** How long an answer is trusted. */
const CHECK_MS = 60 * 60_000;

/**
 * `0.2.0` is newer than `0.1.0`, compared as numbers so ten is not less than nine.
 *
 * A prerelease is not an update (a `-rc` on `main` is not something to tell a viewer about), and
 * anything unparseable answers false: a wrong "out of date" is worse than none.
 */
export function isNewer(upstream: string, current: string): boolean {
  const parse = (value: string): number[] | null => {
    // A version that is not a string at all (a `package.json` with no `version`) is unparseable, not
    // a crash: this runs inside a page and on a timer, and neither can throw over a missing field.
    const trimmed = String(value ?? "")
      .trim()
      .replace(/^v/i, "");
    if (trimmed.includes("-")) return null;
    if (!/^\d+(\.\d+)*$/.test(trimmed)) return null;
    return trimmed.split(".").map(Number);
  };
  const next = parse(upstream);
  const now = parse(current);
  if (!next || !now) return false;
  for (let i = 0; i < Math.max(next.length, now.length); i += 1) {
    const a = next[i] ?? 0;
    const b = now[i] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}

export class UpstreamVersion {
  private latest: string | null = null;
  private checkedAt: number | null = null;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly current: string,
    private readonly url: string = VERSION_URL,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** The repository's version, once it has been read. */
  get upstream(): string | null {
    return this.latest;
  }

  /** Whether the repository is ahead of this process. */
  get behind(): boolean {
    return this.latest !== null && isNewer(this.latest, this.current);
  }

  /**
   * What to tell a viewer, or nothing.
   *
   * Short on purpose: it is drawn on a card and shown above a form, and both are read at a glance.
   */
  get notice(): string | null {
    if (!this.behind || !this.latest) return null;
    return `This addon is out of date — v${this.latest} is available`;
  }

  /** Ask now, unless the last answer is fresh. Never throws, never rejects. */
  async refresh(): Promise<void> {
    if (this.checkedAt !== null && Date.now() - this.checkedAt < CHECK_MS) return;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const response = await this.fetchImpl(this.url, {
          signal: AbortSignal.timeout(10_000),
          headers: { "cache-control": "no-cache" },
        });
        if (!response.ok) throw new Error(`answered ${response.status}`);
        const body = (await response.json()) as { version?: unknown };
        this.latest = typeof body.version === "string" ? body.version.trim() : null;
      } catch {
        // A deployment with no route to GitHub simply has no opinion; the next check tries again.
        this.latest = null;
      } finally {
        this.checkedAt = Date.now();
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /** Ask in the background, so nothing waits on it. */
  refreshInBackground(): void {
    void this.refresh();
  }
}
