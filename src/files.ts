// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * Serving a cut file to a player.
 *
 * A player treats the cut like any other file: it asks for byte ranges as it
 * seeks, so this answers `206 Partial Content` with the right `Content-Range`, and
 * `HEAD` without a body. The body is a stream from disk, so a 6 GB file never sits
 * in memory.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

import { CORS_HEADERS } from "./http.js";

export function contentTypeFor(container: string | undefined): string {
  switch (container) {
    case "mp4":
      return "video/mp4";
    case "ts":
      return "video/mp2t";
    case "mkv":
    default:
      return "video/x-matroska";
  }
}

/** Parse a single-range `Range` header against a known size. */
export function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null | "unsatisfiable" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  let start: number;
  let end: number;
  if (rawStart === "") {
    // A suffix range: the last N bytes.
    const length = Number(rawEnd);
    if (!Number.isFinite(length) || length <= 0) return "unsatisfiable";
    start = Math.max(0, size - length);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "unsatisfiable";
  if (start > end || start >= size) return "unsatisfiable";
  return { start, end: Math.min(end, size - 1) };
}

export async function serveFile(
  request: Request,
  filePath: string,
  container: string | undefined,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  let size: number;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");
    size = info.size;
  } catch {
    return new Response("Cut file is gone", { status: 404, headers: CORS_HEADERS });
  }

  const headers: Record<string, string> = {
    ...CORS_HEADERS,
    "content-type": contentTypeFor(container),
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=0, must-revalidate",
    ...extraHeaders,
  };

  const range = parseRange(request.headers.get("range"), size);
  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { ...headers, "content-range": `bytes */${size}` },
    });
  }

  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  const length = end - start + 1;

  if (request.method === "HEAD") {
    return new Response(null, {
      status: range ? 206 : 200,
      headers: {
        ...headers,
        "content-length": String(length),
        ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
      },
    });
  }

  const stream = Readable.toWeb(
    createReadStream(filePath, { start, end }),
  ) as unknown as ReadableStream<Uint8Array>;

  return new Response(stream, {
    status: range ? 206 : 200,
    headers: {
      ...headers,
      "content-length": String(length),
      ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
    },
  });
}
