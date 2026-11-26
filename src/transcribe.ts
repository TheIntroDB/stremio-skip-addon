// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * The speech models, behind one small interface.
 *
 * Two Desert Ant packages do the work -- **Voz** recognises speech and gives a word's start and
 * end, **Align** moves those boundaries onto the waveform -- and both are *optional* dependencies:
 * a deployment that never turns subtitles on should not pay for a 368 MiB download or a gigabyte
 * of memory. So they are imported lazily, by a specifier held in a variable (which also keeps the
 * type checker out of a package that may not be installed).
 *
 * Both are loaded once and kept. `Voz` has no `dispose()` at all -- holding the instance for the
 * process's life is its intended lifecycle -- and `Align`'s is only for shutdown. Unloading between
 * jobs would turn a cheap transcription into an expensive one, and unloading *during* a job turns
 * it into a failure, which is what the Silo Tiny Subtitles plugin hit in production.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";

import type { Word } from "./cues.js";
import type { Settings } from "./env.js";

/**
 * What the engine needs from the models, whoever owns them.
 *
 * Both implementations fit it: {@link Transcriber} loads them in this process (which is what the
 * tests drive, one chunk at a time), and {@link ProcessTranscriber} keeps them in a child so the
 * server's own loop is never at their mercy.
 */
export interface SpeechModels {
  lastError: string | null;
  available(): Promise<boolean>;
  transcribe(wavPath: string, language: string): Promise<Transcript>;
  refine?(wavPath: string, words: readonly Word[], language: string): Promise<Word[]>;
  /** Stop whatever is running, for a drain. Only a child process can do this at all. */
  cancel?(): void;
}

/** What a recogniser gives back. */
export interface Transcript {
  text: string;
  words: Word[];
  /** Speech seconds per wall-clock second: below 1 is faster than realtime. */
  realtimeFactor: number;
  engine: string;
  language: string;
}

interface VozInstance {
  transcribe(
    input: string,
    options?: { language?: string; onProgress?: (fraction: number) => void },
  ): Promise<{
    text?: string;
    words?: Array<{ text?: string; start?: number; end?: number }>;
    realtimeFactor?: number;
  }>;
}

interface VozModule {
  Voz: { load(options: Record<string, unknown>): Promise<VozInstance> };
}

interface AlignInstance {
  refine(
    samples: Float32Array,
    sampleRate: number,
    words: Array<{ text: string; start: number; end: number }>,
    options: { language: string },
  ): Promise<Array<{ text?: string; start?: number; end?: number; refined?: boolean }>>;
  isDownloaded?(): boolean;
  dispose?(): void;
}

interface AlignModule {
  Align: {
    load(options: Record<string, unknown>): Promise<AlignInstance>;
    isSupported?(language: string): boolean;
  };
}

export class Transcriber {
  private vozPromise: Promise<VozInstance> | null = null;
  private alignPromise: Promise<AlignInstance | null> | null = null;
  /** Why the models are not usable, for /health. Null once they are. */
  lastError: string | null = null;

  constructor(private readonly settings: Settings) {}

  /** Load both models, or remember why they cannot be loaded. Never throws. */
  async warm(): Promise<boolean> {
    try {
      await this.voz();
    } catch (error) {
      this.lastError = message(error);
      return false;
    }
    try {
      await this.align();
    } catch {
      // Alignment is an improvement, not a requirement: recognition alone gives usable cues.
      this.alignPromise = null;
    }
    this.lastError = null;
    return true;
  }

  /** Whether the models are loaded (or could be). */
  async available(): Promise<boolean> {
    try {
      await this.voz();
      return true;
    } catch (error) {
      this.lastError = message(error);
      return false;
    }
  }

  /** Recognise the speech in a WAV file. */
  async transcribe(wavPath: string, language: string): Promise<Transcript> {
    const voz = await this.voz();
    const result = await voz.transcribe(wavPath, language ? { language } : undefined);
    const words: Word[] = [];
    for (const word of result.words ?? []) {
      const text = typeof word.text === "string" ? word.text.trim() : "";
      const start = Number(word.start);
      const end = Number(word.end);
      // A word the model could not place is dropped here, before Align refuses the whole call
      // for a non-finite time (it validates every word it is given).
      if (text === "" || !Number.isFinite(start) || !Number.isFinite(end)) continue;
      words.push({ text, start, end });
    }
    return {
      text: typeof result.text === "string" ? result.text : "",
      words,
      realtimeFactor: Number(result.realtimeFactor) || 0,
      engine: "voz",
      language,
    };
  }

  /**
   * Move each word's boundaries onto the waveform.
   *
   * Returns the words unchanged when Align is unavailable or does not know the language -- a
   * language it cannot refine is a passthrough there, not an error, and it is here too.
   */
  async refine(wavPath: string, words: readonly Word[], language: string): Promise<Word[]> {
    if (words.length === 0) return [...words];
    let align: AlignInstance | null;
    try {
      align = await this.align();
    } catch {
      return [...words];
    }
    if (!align) return [...words];
    try {
      const audio = await readWav(wavPath);
      const refined = await align.refine(
        audio.samples,
        audio.sampleRate,
        words.map((word) => ({ text: word.text, start: word.start, end: word.end })),
        { language: language || "en" },
      );
      const out: Word[] = [];
      for (const word of refined) {
        const text = typeof word.text === "string" ? word.text : "";
        const start = Number(word.start);
        const end = Number(word.end);
        if (text === "" || !Number.isFinite(start) || !Number.isFinite(end)) continue;
        out.push({ text, start, end });
      }
      return out.length > 0 ? out : [...words];
    } catch {
      // A refinement that fails is not a reason to lose the transcript.
      return [...words];
    }
  }

  /** Load Voz, once, with its weights on the cache volume. */
  private voz(): Promise<VozInstance> {
    if (this.vozPromise) return this.vozPromise;
    this.vozPromise = (async () => {
      // Voz takes no directory option: it reads DAL_CACHE_ROOT (then XDG_CACHE_HOME) at load
      // time, so this has to be set before the first load or the 368 MiB lands in the image
      // layer and is downloaded again on every recreate.
      const models = modelsDir(this.settings);
      process.env.DAL_CACHE_ROOT ??= models;
      process.env.XDG_CACHE_HOME ??= models;
      // Both specifiers are held in variables: the packages are optional dependencies, and a
      // literal import of one that is not installed is a type error as well as a load error.
      const vozSpecifier = "@desert-ant-labs/voz";
      const ortSpecifier = "onnxruntime-node";
      const [{ Voz }, ort] = await Promise.all([
        import(vozSpecifier) as Promise<VozModule>,
        import(ortSpecifier) as Promise<{ default?: unknown }>,
      ]);
      return Voz.load({
        // The package needs a runtime handed to it; the module itself is the fallback.
        ort: (ort as { default?: unknown }).default ?? ort,
        cache: true,
      });
    })();
    // A rejected load must not be cached as the answer forever: a deployment that installs the
    // models later should start working without a restart.
    this.vozPromise.catch(() => {
      this.vozPromise = null;
    });
    return this.vozPromise;
  }

  /** Load Align, once, into its own directory on the cache volume. */
  private align(): Promise<AlignInstance | null> {
    if (this.alignPromise) return this.alignPromise;
    this.alignPromise = (async () => {
      const specifier = "@desert-ant-labs/align/native";
      const { Align } = (await import(specifier)) as AlignModule;
      return Align.load({ directory: alignDir(this.settings) });
    })();
    this.alignPromise.catch(() => {
      this.alignPromise = null;
    });
    return this.alignPromise;
  }
}

/** Where the recogniser's weights live: on the cache volume, beside everything else. */
export function modelsDir(settings: Settings): string {
  return `${settings.cacheDir.replace(/\/+$/, "")}/models`;
}

/** Where Align's own files live. */
export function alignDir(settings: Settings): string {
  return `${modelsDir(settings)}/align`;
}

/** A RIFF/WAVE file as the mono float samples Align wants, plus its rate. */
export async function readWav(path: string): Promise<{ samples: Float32Array; sampleRate: number }> {
  const buffer = await readFile(path);
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error(`not a RIFF/WAVE file: ${path}`);
  }
  let offset = 12;
  let format: { channels: number; sampleRate: number; bits: number; mpeg: number } | null = null;
  let data: Buffer | null = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = buffer.subarray(offset + 8, Math.min(offset + 8 + size, buffer.length));
    if (id === "fmt " && body.length >= 16) {
      format = {
        mpeg: body.readUInt16LE(0),
        channels: body.readUInt16LE(2),
        sampleRate: body.readUInt32LE(4),
        bits: body.readUInt16LE(14),
      };
    } else if (id === "data") {
      data = body;
    }
    offset += 8 + size + (size % 2);
  }
  if (!format || !data) throw new Error(`no fmt or data chunk in ${path}`);
  if (format.mpeg !== 1) throw new Error(`WAV is not PCM (format ${format.mpeg})`);
  const channels = Math.max(1, format.channels);
  const samples = new Float32Array(Math.floor(data.length / (format.bits / 8) / channels));
  for (let i = 0; i < samples.length; i += 1) {
    const at = i * channels * (format.bits / 8);
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      const offsetAt = at + channel * (format.bits / 8);
      sum +=
        format.bits === 16
          ? data.readInt16LE(offsetAt) / 32_768
          : format.bits === 32
            ? data.readInt32LE(offsetAt) / 2_147_483_648
            : (data.readUInt8(offsetAt) - 128) / 128;
    }
    samples[i] = sum / channels;
  }
  return { samples, sampleRate: format.sampleRate };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message || error.name : String(error);
}

/**
 * The same interface, with the models in a child process.
 *
 * Recognition is native work with a thread pool the size of the machine, and while it runs the
 * process that owns the sockets only gets what the scheduler has left: starting a playback could
 * make every page -- `/health`, the drain button -- stop answering, and an inference already under
 * way could not be interrupted, so a drain could only time out. This keeps the models out of the
 * server: it spawns {@link transcribe-worker}, `nice`s it so the sockets win, caps its threads, and
 * can kill it outright. Run it in production; the tests drive `Transcriber` directly.
 */
export class ProcessTranscriber {
  lastError: string | null = null;
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private buffer = "";

  constructor(private readonly settings: Settings) {}

  /** Whether the models are loaded in the child. Starts it if it is not running. */
  async available(): Promise<boolean> {
    try {
      const reply = (await this.send({ cmd: "available" })) as { available?: boolean; error?: string | null };
      this.lastError = reply.error ?? null;
      return reply.available === true;
    } catch (error) {
      this.lastError = message(error);
      return false;
    }
  }

  /** Load the models ahead of the first chunk. Never throws. */
  async warm(): Promise<boolean> {
    return this.available();
  }

  /**
   * Alignment happens in the child, with the words it just produced there, so this side is the
   * passthrough: the engine calls it and the words come back as they arrived.
   */
  async refine(_wavPath: string, words: readonly Word[], _language: string): Promise<Word[]> {
    return [...words];
  }

  /** Recognise and align one WAV file, in the child. */
  async transcribe(wavPath: string, language: string): Promise<Transcript> {
    const reply = (await this.send({ cmd: "transcribe", wav: wavPath, language })) as {
      transcript?: Transcript;
    };
    if (!reply.transcript) throw new Error("the recogniser gave nothing back");
    return reply.transcript;
  }

  /** End the child, if it is running. A drain uses this: inference cannot be cancelled politely. */
  cancel(): void {
    const child = this.child;
    this.child = null;
    for (const waiter of this.pending.values()) waiter.reject(new Error("the recogniser was stopped"));
    this.pending.clear();
    this.buffer = "";
    if (child) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }

  /** One request, one reply, matched by id so a late answer cannot be taken for this one's. */
  private send(request: Record<string, unknown>): Promise<unknown> {
    const child = this.ensure();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin?.write(`${JSON.stringify({ ...request, id })}\n`);
    });
  }

  private ensure(): ChildProcess {
    if (this.child) return this.child;
    // One thread fewer than the machine, so the server and its sockets always have somewhere to
    // run. `nice` is what makes that a preference rather than a hope.
    const threads = String(Math.max(1, Math.min(4, availableParallelism() - 1)));
    const env = { ...process.env, OMP_NUM_THREADS: threads, ORT_NUM_THREADS: threads };
    const worker = new URL("./transcribe-worker.js", import.meta.url).pathname;
    const child = spawn("nice", ["-n", "15", process.execPath, worker], {
      env,
      stdio: ["pipe", "pipe", "inherit"],
    });
    child.on("error", () => {
      // No `nice` on this host: run it unpolitely rather than not at all.
      this.child = null;
      this.lastError = "the recogniser could not be started";
    });
    child.on("exit", () => {
      if (this.child === child) this.child = null;
      for (const [id, waiter] of this.pending) {
        waiter.reject(new Error("the recogniser exited"));
        this.pending.delete(id);
      }
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.receive(chunk));
    this.child = child;
    return child;
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const end = this.buffer.indexOf("\n");
      if (end === -1) return;
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (line === "") continue;
      let reply: { id?: number; ok?: boolean; error?: string };
      try {
        reply = JSON.parse(line) as { id?: number; ok?: boolean; error?: string };
      } catch {
        continue;
      }
      const waiter = reply.id === undefined ? undefined : this.pending.get(reply.id);
      if (!waiter) continue;
      this.pending.delete(reply.id as number);
      if (reply.ok === false) waiter.reject(new Error(reply.error ?? "the recogniser failed"));
      else waiter.resolve(reply);
    }
  }
}
