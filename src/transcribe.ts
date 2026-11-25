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

import { readFile } from "node:fs/promises";

import type { Word } from "./cues.js";
import type { Settings } from "./env.js";

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
