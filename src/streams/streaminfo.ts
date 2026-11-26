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

/** One audio track of the source, as the probe sees it. */
export interface AudioStream {
  /** The stream's index in the container: what `-map 0:<index>` needs. */
  index: number;
  /** The container's language tag, normalised to ISO 639-1 where it can be ("eng" -> "en"). */
  language: string;
  /** Whether the file marks this track as the default one. */
  isDefault: boolean;
  /** The codec's name as ffprobe reports it (`eac3`, `aac`, `ac3`, ...). */
  codec?: string;
}

/** The parts of a probe a master playlist needs. */
/**
 * A subtitle track the source already carries, in a form that can be turned into WebVTT.
 *
 * Image tracks (PGS, VobSub) are deliberately absent: they cannot be converted without OCR, so a
 * release that only has those still needs the generated track.
 */
export interface SourceTrack {
  index: number;
  language: string;
  codec: string;
}

/** The subtitle codecs that are text, and therefore convertible without recognising anything. */
const TEXT_SUBTITLES = new Set([
  "subrip",
  "srt",
  "ass",
  "ssa",
  "webvtt",
  "mov_text",
  "text",
  "sami",
  "subviewer",
  "subviewer1",
  "microdvd",
  "jacosub",
  "realtext",
  "stl",
  "mpl2",
  "pjs",
  "vplayer",
]);

export interface StreamInfo {
  /** The film's length, which the playlist also declares as its own. */
  durationMs: number;
  /** The source's bitrate, for the variant's `BANDWIDTH`. */
  bitrate: number;
  width: number;
  height: number;
  /** An `RFC 6381` codec string, or "" when it cannot be spelled correctly. */
  codecs: string;
  /** The video codec's name as ffprobe reports it (`hevc`, `h264`, ...), so the packaging does
   *  not have to infer it from a codec string it may not have been able to spell. */
  video?: string;
  /** The source's own text subtitle tracks, in the order the container lists them. */
  subtitles?: SourceTrack[];
  /** Every audio track, in container order. Absent on a package probed before this existed. */
  audio?: AudioStream[];
}

interface ProbeStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  level?: number;
  width?: number;
  height?: number;
  tags?: { language?: string };
  disposition?: { default?: number };
}

/**
 * ISO 639-2 (what a container usually says) to ISO 639-1 (what this addon's settings say).
 *
 * Matroska and MP4 both normally store the three-letter code, and the ones that have a
 * two-letter form use it inconsistently -- "fre" and "fra" are both French -- so both are read
 * as the same language. Anything not listed is compared as-is, lowercased.
 */
const ISO_639: Record<string, string> = {
  eng: "en",
  spa: "es",
  fra: "fr",
  fre: "fr",
  deu: "de",
  ger: "de",
  por: "pt",
  ita: "it",
  jpn: "ja",
  kor: "ko",
  zho: "zh",
  chi: "zh",
  rus: "ru",
  hin: "hi",
  ara: "ar",
  pol: "pl",
  nld: "nl",
  dut: "nl",
  tur: "tr",
  swe: "sv",
  dan: "da",
  nor: "no",
  nob: "no",
  fin: "fi",
  ces: "cs",
  cze: "cs",
  ell: "el",
  gre: "el",
  heb: "he",
  hun: "hu",
  ind: "id",
  ron: "ro",
  rum: "ro",
  slk: "sk",
  slo: "sk",
  ukr: "uk",
  vie: "vi",
  tha: "th",
  cat: "ca",
  mul: "",
  und: "",
  mis: "",
};

/** A container language tag as the two-letter code the settings use. Empty when unknown. */
export function normalizeLanguage(tag: string | undefined): string {
  const value = (tag ?? "").trim().toLowerCase();
  if (value === "") return "";
  if (value.length === 2) return value;
  return ISO_639[value] ?? value;
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

/**
 * HEVC profiles, as RFC 6381 spells them: profile id and the compatibility flag that a stream of
 * that profile always carries. Apple's authoring spec wants `hvc1` (not `hev1`) for HLS, and every
 * HEVC example of theirs is `hvc1.<id>.<compat>.L<level>.B0`.
 */
const HEVC_PROFILES: Record<string, { id: number; compat: string }> = {
  main: { id: 1, compat: "6" },
  "main 10": { id: 2, compat: "4" },
  "main still picture": { id: 3, compat: "4" },
  rext: { id: 4, compat: "4" },
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
  } else if (name === "hevc") {
    // Omitting this used to be the choice here, on the grounds that a wrong codec string is worse
    // than none. It is not: a master with no `CODECS` leaves a player to guess, and hls.js guesses
    // AVC -- it builds a MediaSource for AVC, feeds it HEVC, and the viewer gets a black picture
    // with the audio playing. Saying what the stream is lets a player that cannot decode it say so
    // instead (and lets one that can -- Safari, Chrome with hardware HEVC -- play it).
    const profile = HEVC_PROFILES[(video?.profile ?? "").toLowerCase()];
    const level = Number(video?.level);
    if (!profile || !Number.isFinite(level) || level <= 0) return "";
    parts.push(`hvc1.${profile.id}.${profile.compat}.L${level}.B0`);
  } else if (name !== "") {
    return "";
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
  const report = raw as {
    format?: { duration?: unknown; bit_rate?: unknown };
    streams?: ProbeStream[];
  };
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
    video: (video?.codec_name ?? "").toLowerCase(),
    subtitles: streams
      .filter((stream) => stream.codec_type === "subtitle" && Number.isInteger(stream.index))
      .map((stream) => ({
        index: Number(stream.index),
        language: normalizeLanguage(stream.tags?.language),
        codec: (stream.codec_name ?? "").toLowerCase(),
      }))
      .filter((track) => TEXT_SUBTITLES.has(track.codec)),
    audio: streams
      .filter((stream) => stream.codec_type === "audio" && Number.isInteger(stream.index))
      .map((stream) => ({
        index: Number(stream.index),
        language: normalizeLanguage(stream.tags?.language),
        isDefault: Number(stream.disposition?.default) === 1,
        codec: (stream.codec_name ?? "").toLowerCase(),
      })),
  };
}

/**
 * The audio codec a placeholder piece should carry, so a player never changes decoder mid-stream.
 *
 * hls.js builds its audio `SourceBuffer` from the first segment it parses. A card with silent AAC in
 * front of a film whose audio is E-AC-3 hands it an AAC buffer, and the film's audio is then refused:
 * the picture plays and there is no sound at all. The placeholder has to speak the film's codec, and
 * this is the nearest one it can encode.
 */
export function placeholderAudio(track: { codec?: string } | null | undefined): string {
  switch ((track?.codec ?? "").toLowerCase()) {
    case "eac3":
      return "eac3";
    case "ac3":
      return "ac3";
    case "mp3":
      return "libmp3lame";
    default:
      return "aac";
  }
}

/**
 * Which audio track to recognise, from an install's preference.
 *
 * The model is trained on English, so a dub recognised as English is noise -- every file with a
 * second audio track was producing an empty track. The order is the one the preference implies:
 * the language asked for, then English, then whatever the file marks as its default (and failing
 * a default flag, its first track). `null` means "let ffmpeg decide", which is what happens when
 * the probe could not read the audio tracks at all.
 */
export function chooseAudio(
  audio: AudioStream[] | undefined,
  preferred: string,
  fallback = "en",
): AudioStream | null {
  if (!Array.isArray(audio) || audio.length === 0) return null;
  const want = normalizeLanguage(preferred);
  const first = normalizeLanguage(fallback);
  return (
    (want ? audio.find((track) => track.language === want) : undefined) ??
    (first ? audio.find((track) => track.language === first) : undefined) ??
    audio.find((track) => track.isDefault) ??
    audio[0] ??
    null
  );
}

/** `#EXT-X-STREAM-INF` attributes for a variant, with only what is known. */
export function variantAttributes(info: StreamInfo | null, subtitles: boolean): string {
  const parts = [`BANDWIDTH=${info?.bitrate && info.bitrate > 0 ? info.bitrate : 10_000_000}`];
  if (info?.bitrate && info.bitrate > 0) parts.push(`AVERAGE-BANDWIDTH=${info.bitrate}`);
  if (info?.width && info.height) parts.push(`RESOLUTION=${info.width}x${info.height}`);
  if (info?.codecs) parts.push(`CODECS="${info.codecs}"`);
  if (subtitles) parts.push('SUBTITLES="subs"');
  // Apple's authoring spec asks for this on a variant that carries no closed captions, and it is
  // an enumerated string, so it is unquoted. AVFoundation is the player that reads it; the ones
  // that ignore it are unaffected, which is why it is cheap to always say.
  parts.push("CLOSED-CAPTIONS=NONE");
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
    // While a package is still being made its playlist is an EVENT one, and a player treats an
    // EVENT playlist as live: hls.js starts at `liveSyncPosition`, which -- because the playlist
    // declares the whole episode from its first response and pads the rest -- is the *end* of it.
    // A viewer who opened the file landed twenty minutes in and could not get back. This says
    // where playback starts, and in the multivariant playlist it applies to the audio and
    // subtitle controllers too, so their clocks match.
    "#EXT-X-START:TIME-OFFSET=0",
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

/**
 * Which of the source's own subtitle tracks to use.
 *
 * Unlike the audio choice there is no "leave it to ffmpeg" answer here -- any text track is better
 * than none -- so the order is: the language the install asked for, then English, then whatever
 * the container lists first. A release's own subtitles are timed to that release and cost nothing
 * to produce, which makes them worth having even when the install never asked for subtitles.
 */
export function chooseSourceTrack(
  tracks: SourceTrack[] | undefined,
  preferred: string,
  fallback = "en",
): SourceTrack | null {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  const want = normalizeLanguage(preferred);
  const first = normalizeLanguage(fallback);
  return (
    (want ? tracks.find((track) => track.language === want) : undefined) ??
    tracks.find((track) => track.language === first) ??
    tracks[0] ??
    null
  );
}
