// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * The speech models, in a process of their own.
 *
 * Recognition and alignment are seconds of native work per chunk: onnxruntime runs them with a
 * thread pool the size of the machine, and while it does, the process that owns the sockets gets
 * whatever the scheduler has left. Running them inside the server meant that starting a playback
 * could make every page stop answering -- `/health` and even the drain button included -- and an
 * inference already under way could not be interrupted, so a drain could only time out.
 *
 * So the models live here, and the server talks to this over two pipes: one request at a time,
 * one JSON line each way. The server can kill it at any moment (a drain, a shutdown) and stays
 * free to answer while it works. It is `nice`d when it is started, so the sockets win.
 *
 * Protocol, one JSON object per line:
 *   in:  {"id":1,"cmd":"available"}
 *        {"id":2,"cmd":"transcribe","wav":"/path.wav","language":"en","refine":true}
 *   out: {"id":1,"ok":true,"available":true,"error":null}
 *        {"id":2,"ok":true,"transcript":{...}}
 *        {"id":2,"ok":false,"error":"..."}
 */

import { createInterface } from "node:readline";

import { loadSettings } from "./env.js";
import { Transcriber } from "./transcribe.js";
import type { Word } from "./cues.js";

interface Request {
  id: number;
  cmd: "available" | "transcribe";
  wav?: string;
  language?: string;
  refine?: boolean;
}

const transcriber = new Transcriber(loadSettings());
/** One at a time: the model is a single instance, and two chunks at once would thrash. */
let chain: Promise<void> = Promise.resolve();

function reply(body: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(body)}\n`);
}

async function handle(request: Request): Promise<void> {
  if (request.cmd === "available") {
    const available = await transcriber.available();
    reply({ id: request.id, ok: true, available, error: transcriber.lastError });
    return;
  }
  const wav = request.wav ?? "";
  const language = request.language ?? "";
  const transcript = await transcriber.transcribe(wav, language);
  let words: Word[] = transcript.words;
  if (request.refine !== false && words.length > 0) {
    try {
      words = await transcriber.refine(wav, words, language);
    } catch {
      // Alignment is an improvement, not a requirement.
    }
  }
  reply({ id: request.id, ok: true, transcript: { ...transcript, words } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed === "") return;
  let request: Request;
  try {
    request = JSON.parse(trimmed) as Request;
  } catch {
    return;
  }
  chain = chain.then(async () => {
    try {
      await handle(request);
    } catch (error) {
      reply({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
});

// A drain kills this process outright; nothing to flush, and no point keeping the pipe open.
process.stdin.on("end", () => process.exit(0));
