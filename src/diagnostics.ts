// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * The last thing that went wrong, for the runtime log and for `/health`.
 *
 * An addon that answers `500` with nothing but "internal_error" costs a round trip through
 * somebody else's logs to diagnose. This keeps the request, the message and the stack where the
 * operator can read them: `/health`'s `lastError`, and the log line that carries the same text.
 */
export interface Failure {
  /** When it happened, in ISO form. */
  at: string;
  /** The method and URL that failed, without the query string (it can carry a source's token). */
  request: string;
  /** The message, and the stack when there is one. */
  detail: string;
}

export const diagnostics: { lastError: Failure | null } = { lastError: null };

/** Record a failure, and return the line to log. */
export function recordFailure(where: string, error: unknown): string {
  const detail =
    error instanceof Error ? `${error.message}\n${error.stack ?? ""}`.trim() : String(error);
  diagnostics.lastError = {
    at: new Date().toISOString(),
    request: where,
    detail: detail.slice(0, 4_000),
  };
  return `${where} failed: ${detail}`;
}
