// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * What a master playlist has to say about the film, learned from one probe.
 *
 * A variant with no `RESOLUTION` (and with a `BANDWIDTH` that is a guess) is a variant a player
 * may refuse to initialise at all -- which shows up as a stream that simply does not load, not as
 * a subtitle problem. So the same `ffprobe` that learns the title's length reports what the
 * master needs, and it is stored with it.
 *
 * `CODECS` is built only for the pairs this can spell correctly: an `avc1` string is
 * `avc1.PPCCLL` from the profile and level, and a wrong one is worse than none (the attribute is
 * optional, and players sniff what a stream is from `RESOLUTION` and the media itself). Anything
 * else -- HEVC above all, whose string needs compatibility flags this does not read -- is left
 * out rather than guessed.
 */

/** The parts of a probe a master playlist needs. */
export interface StreamInfo {
  /** The film's length, which the playlist also declares as its own. */
  durationMs: number;
  /** The source's bitrate, for the variant's `BANDWIDTH`. */
  bitrate: number;
  width: number;
  height: number;
  /** An `RFC 6381` codec string, or "" when it cannot be spelled correctly. */
  codecs: string;
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  level?: number;
  width?: number;
  height?: number;
}

/** The `avc1` profile byte for the profiles ffprobe names. */
const H264_PROFILES: Record<string, string> = {
  "constrained baseline": "42",
  baseline: "42",
  main: "4d",
  high: "64",
  "high 10": "6e",
  "high 4:2:2": "7a",
};

const AUDIO_CODECS: Record<string, string> = {
  aac: "mp4a.40.2",
  mp3: "mp4a.40.34",
  ac3: "ac-3",
  eac3: "ec-3",
  opus: "opus",
  flac: "flac",
};

/** The codec list a master may carry, or "" when any part of it would be a guess. */
export function codecsFor(video?: ProbeStream, audio?: ProbeStream): string {
  const parts: string[] = [];
  const name = (video?.codec_name ?? "").toLowerCase();
  if (name === "h264") {
    const profile = H264_PROFILES[(video?.profile ?? "").toLowerCase()];
    const level = Number(video?.level);
    if (!profile || !Number.isFinite(level) || level <= 0) return "";
    // Constraint flags are not reported per set bit; 0x00 is what a High/Main stream carries.
    parts.push(`avc1.${profile}00${level.toString(16).padStart(2, "0")}`);
  } else if (name !== "") {
    return ""; // HEVC and friends: no spelling that is guaranteed right, so none.
  }
  const sound = AUDIO_CODECS[(audio?.codec_name ?? "").toLowerCase()];
  if (sound) parts.push(sound);
  return parts.join(",");
}

/** Read an `ffprobe -of json` report of one input. Null when it is not usable. */
export function parseProbe(text: string): StreamInfo | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const report = raw as { format?: { duration?: unknown; bit_rate?: unknown }; streams?: ProbeStream[] };
  const seconds = Number(report.format?.duration);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const streams = Array.isArray(report.streams) ? report.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const bitrate = Number(report.format?.bit_rate);
  return {
    durationMs: Math.round(seconds * 1000),
    bitrate: Number.isFinite(bitrate) && bitrate > 0 ? Math.round(bitrate) : 0,
    width: Number(video?.width) || 0,
    height: Number(video?.height) || 0,
    codecs: codecsFor(video, audio),
  };
}

/** `#EXT-X-STREAM-INF` attributes for a variant, with only what is known. */
export function variantAttributes(info: StreamInfo | null, subtitles: boolean): string {
  const parts = [`BANDWIDTH=${info?.bitrate && info.bitrate > 0 ? info.bitrate : 10_000_000}`];
  if (info?.bitrate && info.bitrate > 0) parts.push(`AVERAGE-BANDWIDTH=${info.bitrate}`);
  if (info?.width && info.height) parts.push(`RESOLUTION=${info.width}x${info.height}`);
  if (info?.codecs) parts.push(`CODECS="${info.codecs}"`);
  if (subtitles) parts.push('SUBTITLES="subs"');
  return parts.join(",");
}

/** A quoted-string attribute. HLS requires the quotes, and a parser that reads the line at all
 *  drops an unquoted one -- `LANGUAGE=en` made the whole `#EXT-X-MEDIA` line unreadable.
 *  Quoting is necessary and not sufficient: see the note on `masterPlaylist`. */
function quoted(name: string, value: string): string {
  return `${name}="${value.replace(/"/g, "")}"`;
}

export interface MasterOptions {
  /** The film itself, as a media playlist -- this same URL with the media flag set. */
  mediaUri: string;
  /** The subtitle rendition's playlist. */
  subtitleUri: string;
  /** The one language this track holds. */
  language: string;
  name: string;
  info: StreamInfo | null;
}

/**
 * The multivariant playlist a film is offered as when it carries generated subtitles.
 *
 * A subtitle rendition can only be declared here, and every attribute that is a quoted-string has
 * to be quoted: `LANGUAGE=en` makes the whole `#EXT-X-MEDIA` line unparseable, which reads as a
 * stream with no subtitle track rather than as a syntax error.
 *
 * `FORCED` is deliberately absent. Forced subtitles mean "only the lines someone must read, for
 * dialogue in another language" -- these are the whole track, and players treat a forced-only
 * group as one to leave off.
 *
 * What a player does with this line is a separate question from whether it is correct. Measured
 * against Apple's own reference multivariant playlist, ffmpeg below 8 logs `hls: Can't support
 * the subtitle(<uri>)` and exposes no subtitle stream at all, so every ffmpeg-based player --
 * mpv, IINA, and Stremio's desktop shell, which bundles libmpv -- is blind to a rendition
 * however well it is written. Support landed in ffmpeg 8 (April 2025); hls.js and ExoPlayer
 * have always had it. So `SUBTITLES="subs"` is the right line to serve, and it is not what
 * makes a subtitle appear on a desktop player.
 */
export function masterPlaylist(options: MasterOptions): string {
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    [
      "#EXT-X-MEDIA:TYPE=SUBTITLES",
      quoted("GROUP-ID", "subs"),
      quoted("NAME", options.name),
      quoted("LANGUAGE", options.language),
      "DEFAULT=YES",
      "AUTOSELECT=YES",
      quoted("URI", options.subtitleUri),
    ].join(","),
    `#EXT-X-STREAM-INF:${variantAttributes(options.info, true)}`,
    options.mediaUri,
    "",
  ].join("\n");
}
