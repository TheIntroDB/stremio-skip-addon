// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * `/play` -- the endpoint that makes the skip happen.
 *
 * It is handed the origin stream URL, and it answers with one of three things:
 *
 * - an HLS playlist with the skip windows removed (masters are rewritten so their
 *   variants come back here, then the variant playlist is spliced);
 * - a cut file, for a progressive `.mkv`/`.mp4` whose intro was remuxed out by
 *   `packages.ts` (see there: the first playback warms it, later ones are cut);
 * - a `302` to the origin URL, for anything that cannot be cut, or while a cut is
 *   still being prepared.
 *
 * Nothing here re-encodes: HLS is cut by dropping segments, a progressive file by
 * copying the ranges that survive.
 */

import { getHttpCache } from "../addon/cache.js";
import type { Settings } from "../addon/env.js";
import { CORS_HEADERS, playlist, redirectTo, text } from "../addon/http.js";
import type { AddonConfig, CutMode, SkipWindow } from "../addon/types.js";
import { DEFAULT_CUT_MODE } from "../addon/types.js";
import { playUrl, segmentUrl } from "../addon/urls.js";
import { type SubtitleEngine, trackKey } from "../subtitles/subtitles.js";
import { lookupSkipWindows } from "../theintrodb/theintrodb.js";
import { serveFile } from "./files.js";
import { describeWindows } from "./format.js";
import {
  isMasterPlaylist,
  isPlaylist,
  rewriteMasterPlaylist,
  spliceMediaPlaylist,
  type UriRewriters,
} from "./hls.js";
import { knownCodecs } from "./known.js";
import type { ManifestView, PackageEngine } from "./packages.js";
import { chooseAudio, chooseSourceTrack, masterPlaylist } from "./streaminfo.js";
import { isPrivateHost } from "./upstream.js";

/** Playlists are text and small; anything bigger is not a playlist. */
const MAX_PLAYLIST_BYTES = 4 * 1024 * 1024;
const SNIFF_BYTES = 8192;
const UPSTREAM_TIMEOUT_MS = 10000;
const SEGMENT_TIMEOUT_MS = 30000;
/**
 * How long a cold play waits for the pre-roll before it settles for the processing card.
 *
 * The card exists so that nothing has to wait long, so this is a short grace and not a budget: it
 * is long enough for a source that is keeping up to deliver `PREROLL_SECONDS` of the cut film, and
 * short enough that the player's own request is not the thing being waited on.
 */
const PREROLL_WAIT_MS = 2500;
/** How long a "this target is not a playlist" verdict is remembered. */
const NOT_PLAYLIST_TTL_SECONDS = 60 * 60;

/** Extensions that are never a playlist, so a sniff can be skipped entirely. */
const MEDIA_EXTENSIONS = [
  ".mp4",
  ".m4v",
  ".mkv",
  ".webm",
  ".avi",
  ".mov",
  ".flv",
  ".wmv",
  ".mpg",
  ".mpeg",
  ".m2ts",
  ".ts",
  ".iso",
  ".mp3",
  ".m4a",
  ".aac",
  ".flac",
  ".srt",
  ".vtt",
  ".ass",
];

export interface PlayContext {
  request: Request;
  settings: Settings;
  packages: PackageEngine;
  config: AddonConfig;
  encodedConfig: string;
  origin: string;
  /** Generated subtitles for the cut video, when this install asked for them. */
  subtitles: SubtitleEngine;
  /** The episode id from the play URL, so a track can be offered with the episode it belongs to. */
  episodeId?: string;
}

export async function handlePlay(context: PlayContext): Promise<Response> {
  const requestUrl = new URL(context.request.url);
  // Someone is watching: this is what keeps a subtitle job alive (see `subtitlesIdleSeconds`).
  context.packages.noteActivity();
  const target = requestUrl.searchParams.get("u");
  const id = requestUrl.searchParams.get("id") ?? "";
  // The stable identity of the source stream, from the stream list. Without it a cut
  // is keyed on a URL that a debrid source re-mints, which is how a ready cut used to
  // be missed on the next playback.
  const streamKey = requestUrl.searchParams.get("k");
  // Which episode this is, so its generated subtitles can be found from the addon's subtitles
  // resource later: the resource is asked for an episode id, not for a stream.
  context.episodeId = id;

  if (!target) return text("Missing u parameter", { status: 400 });
  const blocked = targetRejection(target, context.settings);
  if (blocked) return text(blocked, { status: 400 });

  // The timings decide whether anything can be cut, so they come first.
  const lookup = id ? await lookupSkipWindows(context.settings, context.config, id) : null;
  const windows = lookup?.windows ?? [];
  // Whether files are packaged is the install's own choice, so it comes from the link rather
  // than from the deployment: a link that says nothing means everything is cut.
  const cutMode: CutMode = context.config.cuts ?? DEFAULT_CUT_MODE;
  // Both modes splice HLS playlists; only `mkv` packages a file with no playlist of its own.
  // Packaging is what `cutting` means here: a file with no playlist of its own. Splicing an
  // HLS playlist is a text rewrite and happens in both modes, without a cache key.
  const cutting = cutMode === "mkv" && context.packages.enabled;
  // The audio the install asked for: it decides which stream the package keeps, so it is part of
  // the package's identity as well (see `PackageEngine.keyFor`).
  const audioLanguage = context.config.audioLang || context.settings.subtitlesAudioLanguage || "";
  const cutKey =
    windows.length > 0 && cutting
      ? context.packages.keyFor(target, windows, streamKey, audioLanguage)
      : null;

  // A package that already exists is served before anything else is decided: this is
  // what makes a debrid `.mkv` skip its intro on every playback after the first, and
  // a processing card that is already in such a playlist is kept up to date here,
  // because these polls arrive before the target is known to be a file.
  if (cutKey) {
    const card = await context.packages.advanceCard(cutKey);
    if (card) {
      const audio = await offerTrack(context, target, cutKey, windows, card.cardMs);
      return packageResponse(context, card, cutKey, lookup?.reason ?? "", audio);
    }
    const ready = await context.packages.manifest(cutKey);
    if (ready) {
      const audio = await offerTrack(context, target, cutKey, windows, ready.cardMs);
      return packageResponse(context, ready, cutKey, lookup?.reason ?? "", audio);
    }
  }

  const proxyOn = context.settings.proxy === true;
  const cache = getHttpCache();
  const verdictKey = `play:verdict:${target}`;

  if (proxyOn) {
    // With proxying on, the player never touches the source addon. That is not only
    // about segments: a debrid link is minted for the address that asked for it, and
    // this service is that address, so a file has to be streamed from here too --
    // otherwise the player opens the link from its own network and the source answers
    // "this stream link only works on the internet connection that requested it".
    if (looksLikeProgressiveFile(target)) {
      return handleProgressive(
        context,
        target,
        windows,
        "proxied_file",
        streamKey,
        cutMode,
        lookup?.reason ?? "",
      );
    }
  } else {
    // A HEAD probe, or a byte range the player already knows it wants: nothing to
    // rewrite. A playlist is never range-requested in practice, and a progressive
    // file is range-requested on every seek.
    if (context.request.method === "HEAD" || requestUrl.searchParams.has("whole")) {
      return redirectTo(target, "pass_through");
    }
    if (context.request.headers.has("range") && !cutKey) {
      return redirectTo(target, "range_request");
    }
    if (looksLikeProgressiveFile(target)) {
      return handleProgressive(
        context,
        target,
        windows,
        "not_hls",
        streamKey,
        cutMode,
        lookup?.reason ?? "",
      );
    }
    if (await cache.match(verdictKey)) {
      return handleProgressive(
        context,
        target,
        windows,
        "not_a_playlist_cached",
        streamKey,
        cutMode,
        lookup?.reason ?? "",
      );
    }
  }

  const rewriters: UriRewriters = {
    playlistUri: (absoluteUri) => playUrl(context.origin, context.encodedConfig, absoluteUri, id),
    resourceUri: (absoluteUri) =>
      context.settings.proxy
        ? segmentUrl(context.origin, context.encodedConfig, absoluteUri)
        : absoluteUri,
  };

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      headers: forwardedHeaders(context.request),
      redirect: "follow",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    // An unreachable playlist is not a reason to fail playback: the player may
    // still reach the origin itself.
    return redirectTo(target, "upstream_unreachable");
  }

  if (upstream.status >= 400) return redirectTo(target, `upstream_${upstream.status}`);

  const contentType = upstream.headers.get("content-type") ?? "";
  const sniffed = await readPlaylist(upstream, target, contentType);

  if (sniffed === null || !isPlaylist(sniffed.text)) {
    await cache.put(
      verdictKey,
      { status: 302, body: "not_a_playlist", contentType: "text/plain" },
      NOT_PLAYLIST_TTL_SECONDS,
    );
    // A file behind a URL with no extension (a debrid `/playback/<token>`, for
    // instance): the prefix read above already had to come from here, so the rest
    // does too -- which `handleProgressive` does, because proxying is on by default.
    return handleProgressive(
      context,
      target,
      windows,
      "not_a_playlist",
      streamKey,
      cutMode,
      lookup?.reason ?? "",
    );
  }

  if (isMasterPlaylist(sniffed.text)) {
    const rewritten = rewriteMasterPlaylist(sniffed.text, target, rewriters);
    return playlist(rewritten, { "x-tidb-play": "master" }, 60);
  }

  const spliced = spliceMediaPlaylist(sniffed.text, {
    baseUrl: target,
    windows,
    rewriters,
    forceRewrite: context.settings.proxy === true,
  });

  if (!spliced) return redirectTo(target, "not_a_media_playlist");

  if (spliced.degenerate) {
    // Every segment overlapped a window: serving an empty playlist would break
    // playback, so pass the original through and say so in the headers.
    return playlistFor(sniffed.text, {
      "x-tidb-play": "degenerate_windows",
      "x-tidb-lookup": lookup?.reason ?? "",
    });
  }

  if (!spliced.changed) {
    return playlistFor(sniffed.text, {
      "x-tidb-play": context.settings.proxy ? "rewritten_uris" : "unchanged",
      "x-tidb-lookup": lookup?.reason ?? "",
      "x-tidb-windows": String(spliced.windows.length),
      "x-tidb-cuts": describeWindows(spliced.windows),
    });
  }

  return playlistFor(spliced.text, {
    "x-tidb-play": "spliced",
    "x-tidb-lookup": lookup?.reason ?? "",
    "x-tidb-windows": String(spliced.windows.length),
    "x-tidb-cuts": describeWindows(spliced.windows),
    "x-tidb-dropped-segments": String(spliced.droppedSegments),
    "x-tidb-dropped-ms": String(spliced.droppedMs),
    "x-tidb-duration-ms": String(spliced.durationMs),
  });
}

/**
 * A file with no playlist to rewrite: get it cut, and serve it once it is.
 *
 * The install decides whether a file is packaged at all (`mkv`) or handed over untouched
 * (`hls`). When it is packaged the request waits, bounded by `CUT_WAIT_SECONDS`, for the
 * first segment -- so even the first play is handed a playlist that is already being
 * written, rather than the original.
 */
async function handleProgressive(
  context: PlayContext,
  target: string,
  windows: readonly SkipWindow[],
  reason: string,
  streamKey: string | null = null,
  mode: CutMode = DEFAULT_CUT_MODE,
  lookupReason = "",
): Promise<Response> {
  if (windows.length > 0 && mode === "mkv" && context.packages.enabled) {
    return packageOrProxy(context, target, windows, streamKey, lookupReason);
  }
  return passThrough(context, target, reason, lookupReason);
}

/**
 * The source itself: proxied when the config asks for it, otherwise handed over.
 *
 * A debrid link is minted for the address that asked for it, so with proxying on this
 * service has to be the one to fetch it -- the player opening the link from its own
 * network is what produces "this stream link only works on the internet connection
 * that requested it".
 */
function passThrough(
  context: PlayContext,
  target: string,
  reason: string,
  lookupReason = "",
): Promise<Response> | Response {
  if (context.settings.proxy === true) {
    // `x-tidb-play` says what happened, `x-tidb-fallback` says why the original was
    // served instead of a package: two different questions, and an operator asking
    // "why is the intro still there" needs the second one.
    return streamThrough(context.request, target, {
      cacheControl: "no-store",
      timeoutMs: null,
      debug: {
        "x-tidb-play": "proxied_file",
        ...(reason && reason !== "proxied_file" ? { "x-tidb-fallback": reason } : {}),
        ...(lookupReason ? { "x-tidb-lookup": lookupReason } : {}),
      },
    });
  }
  return redirectTo(target, reason);
}

/**
 * A playlist built from this key's package, starting the generation when there is
 * none yet.
 *
 * This is the answer to "the player gives up before the file has downloaded": what is
 * waited for here is one segment, a couple of seconds of work, and not the file.
 * Whatever happens, a player that plays something is better than one that fails, so a
 * source too slow to produce a segment inside the window is passed through untouched.
 */
/**
 * Offer a package's track, starting or resuming the job that makes it, and return the audio stream
 * it is being made from.
 *
 * Called on every path that serves a package, not only the one that builds it. The job lives in
 * memory while its chunks live on disk, so a restart, a drain, or the idle stop after a viewer
 * leaves all end it -- and a cut film served afterwards would have no rendition at all: the film
 * plays, the intro is gone, and the player simply has no subtitle track, with nothing failing
 * anywhere to say why. `run` treats a chunk's file as the record of it, so a resumed job continues
 * where the last one stopped instead of recognising the episode again.
 */
async function offerTrack(
  context: PlayContext,
  target: string,
  key: string,
  windows: readonly SkipWindow[],
  cardMs: number,
): Promise<{ index: number; language?: string } | null> {
  const audio = await audioFor(context, key);
  const info = await context.packages.sourceInfo(key);
  // Without the source's own length there is no timeline to place cues on. The film still plays;
  // it is the track that cannot be offered until a play has probed the source.
  if (!info) return audio;
  // The source's own subtitles come first. They are timed to that release and cost one demux pass,
  // so a file that has them needs no recognition at all -- and, since nothing is being spent, they
  // are offered whether or not the install asked for generated ones. Only a file without a usable
  // text track needs the toggle.
  const source = chooseSourceTrack(info.subtitles, context.settings.subtitlesLanguage);
  if (!source && !context.subtitles.enabled(context.config)) return audio;
  context.subtitles.ensure(
    key,
    target,
    {
      durationMs: info.durationMs,
      windows,
      // The offset the track is timed from has to match the playlist this playback gets: when the
      // card was dropped as stale, the film starts at zero and so must the cues.
      cardMs,
    },
    true,
    source ? undefined : (audio ?? undefined),
    source,
  );
  const track = context.subtitles.trackFor(key);
  if (track && context.episodeId) context.subtitles.note(context.episodeId, track);
  return audio;
}

async function packageOrProxy(
  context: PlayContext,
  target: string,
  windows: readonly SkipWindow[],
  streamKey: string | null,
  lookupReason: string,
): Promise<Response> {
  const audioLanguage = context.config.audioLang || context.settings.subtitlesAudioLanguage || "";
  const key = context.packages.keyFor(target, windows, streamKey, audioLanguage);
  // The audio track is part of the track's identity (see `trackKeyOf`), so it is resolved before
  // anything answers. On a key seen for the first time the probe below is what lists the tracks,
  // so it is resolved again after that.
  let audio = await audioFor(context, key);
  const wantsSubtitles = context.subtitles.enabled(context.config);
  const ready = await context.packages.manifest(key);
  if (ready) {
    const resolved = await offerTrack(context, target, key, windows, ready.cardMs);
    return packageResponse(context, ready, key, lookupReason, resolved);
  }

  // Learn the source's length before answering, so the playlist can declare the whole episode
  // from its first response: a player that reaches the end of a few-second playlist decides the
  // episode is over, marks it watched and jumps to the next one.
  // Only mkvs get here, and a package always waits for its first segment, so the length is
  // always worth learning: the playlist declares it from its first response.
  const durationMs = await context.packages.rememberDuration(key, target);
  // What this release turned out to be, so the stream list for the same release can warn before
  // the next playback spends the same minute finding out again.
  if (streamKey) {
    const probed = await context.packages.sourceInfo(key);
    if (probed?.video)
      await knownCodecs(context.settings.cacheDir).remember(streamKey, probed.video);
  }
  // The probe that learnt the length also listed the audio tracks, which is only available now on
  // a key seen for the first time.
  if (!audio) audio = await audioFor(context, key);
  context.packages.schedule(target, windows, streamKey, durationMs, audioLanguage);
  // The pre-roll: wait, briefly, for `PREROLL_SECONDS` of the cut film. A source that is keeping up
  // then hands the player the film itself, from its first frame, and no card is ever drawn. The
  // wait is short on purpose -- the card is what covers a source that is not keeping up, and what
  // the wait has to beat is one poll of a growing playlist.
  const preroll = await context.packages.waitForPreroll(
    key,
    context.settings.prerollSeconds * 1000,
    PREROLL_WAIT_MS,
  );
  if (preroll) {
    const resolved = await offerTrack(context, target, key, windows, preroll.cardMs);
    return packageResponse(context, preroll, key, lookupReason, resolved);
  }
  // Not enough of it yet, so show what is happening rather than holding the request: a player
  // handed a playlist starts at once and sees the card, where a player handed nothing shows a
  // spinner and then gives up on the stream. The card goes the moment the film can play.
  const card = await context.packages.splashView(key, windows, wantsSubtitles);
  if (card) return packageResponse(context, card, key, lookupReason, audio);

  // Nothing to hand over and nothing being made: a failure, or no card can be drawn here. Waiting
  // the whole `CUT_WAIT_SECONDS` over a job that has already stopped is a player held on a spinner
  // for two minutes, so a failure is the source, untouched, with a header that says why.
  if (context.packages.state(key)?.status === "failed")
    return passThrough(context, target, "package_failed", lookupReason);

  const waited = await context.packages.waitForFirstSegment(
    key,
    context.settings.cutWaitSeconds * 1000,
  );
  if (waited) return packageResponse(context, waited, key, lookupReason, audio);
  return passThrough(context, target, "package_slow", lookupReason);
}

/** The audio track an install asked for, if the probe has listed them. */
async function audioFor(
  context: PlayContext,
  key: string,
): Promise<{ index: number; language: string } | null> {
  const info = await context.packages.sourceInfo(key);
  const preferred = context.config.audioLang || context.settings.subtitlesAudioLanguage || "";
  const chosen = chooseAudio(info?.audio, preferred, "en");
  return chosen ? { index: chosen.index, language: chosen.language } : null;
}

/**
 * A package's playlist: the master that carries the subtitle rendition, or the media playlist.
 *
 * A subtitle rendition can only be declared in a master (`#EXT-X-MEDIA` + `SUBTITLES="subs"` on
 * a variant), so when an install wants subtitles the film is offered as a one-variant master
 * whose subtitle track is the growing playlist the engine serves. The variant is this same URL
 * with `m=1`, which asks for the media playlist itself.
 */
async function packageResponse(
  context: PlayContext,
  view: ManifestView,
  key: string,
  lookupReason: string,
  audio: { index: number } | null = null,
): Promise<Response> {
  const url = new URL(context.request.url);
  const enabled = context.subtitles?.enabled(context.config) === true;
  if (enabled) context.subtitles!.served.wanted += 1;
  // Only when a track is actually being made: a master that points at a rendition with nothing
  // behind it is a track a player will drop, or worse, a master it will refuse. The track is
  // keyed by the audio stream it is made from, not by the package.
  // The engine is the only thing that knows which key its job was started under (the key carries
  // the audio stream), so it is asked rather than re-derived: a mismatch here is a master that
  // declares no rendition, which a player reads as "no subtitle track" with nothing wrong in the
  // logs to say why.
  const track = context.subtitles!.trackFor(key);
  if (enabled)
    context.subtitles!.noteResolved(track ?? trackKey(key, audio), audio ? audio.index : null);
  const wants = enabled && track !== null && url.searchParams.get("m") !== "1";
  if (!wants || track === null) return mediaResponse(view, key, lookupReason);
  context.subtitles!.served.masters += 1;

  const media = new URL(url.toString());
  media.searchParams.set("m", "1");
  // The rendition has to carry the card's own segment, or every cue sits one card late: the card is
  // the film's pre-roll now (see `packages.ts`, `manifest`), so the film starts at `view.cardMs` and
  // the track has to say the same thing. Its length travels in the URI because it is a measured
  // wait, not a deployment constant.
  const subtitleQuery = `f=${encodeURIComponent(track)}&c=${(view.cardMs / 1000).toFixed(3)}`;
  const info = await context.packages.sourceInfo(key);
  const master = masterPlaylist({
    mediaUri: `${media.pathname}${media.search}`,
    subtitleUri: `subs.m3u8?${subtitleQuery}`,
    language: context.subtitles.languageOf(track) ?? context.settings.subtitlesLanguage ?? "en",
    name: "TheIntroDB",
    info,
  });
  return new Response(master, {
    status: 200,
    headers: {
      "content-type": "application/vnd.apple.mpegurl",
      // It carries the key of a track that is still being made, so it must not be cached.
      "cache-control": "no-cache",
      // The master answers the same question the playlist does, so an operator sees one vocabulary.
      "x-tidb-play": view.complete ? "package_vod" : "package_live",
      // What the segments hold, for the "the film plays but the picture is black" report.
      "x-tidb-codecs": info?.codecs || "unknown",
      "x-tidb-complete": view.complete ? "yes" : "no",
      ...CORS_HEADERS,
    },
  });
}

function mediaResponse(view: ManifestView, key: string, lookupReason: string): Response {
  return playlist(
    view.body,
    {
      "x-tidb-play": view.complete ? "package_vod" : "package_live",
      // Which package was served. Two playbacks of the same release must show the same
      // key even though the source re-minted its link in between.
      "x-tidb-package": key,
      "x-tidb-segments": String(view.segments),
      ...(view.card > 0 ? { "x-tidb-card": String(view.card) } : {}),
      "x-tidb-content-ms": String(view.durationMs),
      "x-tidb-complete": view.complete ? "yes" : "no",
      ...(lookupReason ? { "x-tidb-lookup": lookupReason } : {}),
    },
    // Re-read on every poll: an EVENT playlist grows while the player watches.
    0,
  );
}

/**
 * `/seg` -- passthrough for the media resources of a playlist.
 *
 * Used when proxying is on: the player fetches every segment from here
 * instead of from the source, which is what makes a source that binds its links to
 * the requesting address work.
 */
export async function handleSegment(context: PlayContext): Promise<Response> {
  const requestUrl = new URL(context.request.url);
  // A segment being fetched is the clearest sign the video is still moving.
  context.packages.noteActivity();

  // A segment of a package this service generated (`f=<key>/<name>`): served from the
  // cache it was written to. A segment never changes once written, so the player may
  // keep it -- which is what makes a replay cheap.
  const file = requestUrl.searchParams.get("f");
  if (file) {
    const slash = file.lastIndexOf("/");
    const local =
      slash > 0 ? context.packages.segmentPath(file.slice(0, slash), file.slice(slash + 1)) : null;
    if (!local) return text("Malformed f parameter", { status: 400 });
    // An fMP4 package is an initialisation section plus media segments; both are served from here
    // and both have to say what kind of file they are (`video/iso.segment` is the HLS media
    // segment type, `video/mp4` the init section).
    const named = file.slice(slash + 1);
    const container = named.endsWith(".m4s") ? "m4s" : named.endsWith(".mp4") ? "mp4" : "ts";
    return serveFile(context.request, local, container, {
      "x-tidb-play": "package_segment",
      "cache-control": "public, max-age=21600",
    });
  }

  const target = requestUrl.searchParams.get("u");
  if (!target) return text("Missing u parameter", { status: 400 });
  const blocked = targetRejection(target, context.settings);
  if (blocked) return text(blocked, { status: 400 });

  return streamThrough(context.request, target, {
    // A segment is small and immutable, unlike a whole film.
    cacheControl: "public, max-age=3600",
    debug: { "x-tidb-seg": "streamed" },
  });
}

interface StreamOptions {
  cacheControl: string;
  debug?: Record<string, string>;
  /**
   * Abort the upstream request after this long. `null` means no timeout: a whole film
   * can stream for minutes, and the player closing the connection is what ends it
   * (the response body is cancelled, which tears the upstream request down).
   */
  timeoutMs?: number | null;
}

/**
 * Fetch a source and hand its bytes to the player unchanged.
 *
 * The body is streamed, never buffered, and the range headers go both ways, so
 * seeking works exactly as it would against the source. Only the headers a player has
 * any use for are passed through: a length is relayed only when nothing re-encoded
 * the body in between.
 */
async function streamThrough(
  request: Request,
  target: string,
  options: StreamOptions,
): Promise<Response> {
  const headers: Record<string, string> = {};
  for (const name of ["range", "user-agent", "accept", "accept-language"]) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method === "HEAD" ? "HEAD" : "GET",
      headers,
      redirect: "follow",
      ...(options.timeoutMs === null
        ? {}
        : { signal: AbortSignal.timeout(options.timeoutMs ?? SEGMENT_TIMEOUT_MS) }),
    });
  } catch {
    return text("Upstream unreachable", {
      status: 502,
      headers: { "x-tidb-proxy": "unreachable", ...options.debug },
    });
  }

  const passthrough = new Headers(CORS_HEADERS);
  passthrough.set("cache-control", options.cacheControl);
  passthrough.set("x-tidb-proxy", "streamed");
  passthrough.set("x-tidb-upstream-status", String(upstream.status));
  for (const [name, value] of Object.entries(options.debug ?? {})) passthrough.set(name, value);
  for (const name of ["content-type", "content-range", "accept-ranges", "etag", "last-modified"]) {
    const value = upstream.headers.get(name);
    if (value) passthrough.set(name, value);
  }
  if (!upstream.headers.get("content-encoding")) {
    const length = upstream.headers.get("content-length");
    if (length) passthrough.set("content-length", length);
  }

  return new Response(upstream.body, { status: upstream.status, headers: passthrough });
}

/** Read a playlist body, sniffing anything whose content type does not say so. */
async function readPlaylist(
  response: Response,
  target: string,
  contentType: string,
): Promise<{ text: string } | null> {
  if (!response.body) return null;

  const declared =
    /mpegurl/i.test(contentType) ||
    /\.m3u8?(\?|$)/i.test(new URL(target).pathname + new URL(target).search);

  if (declared) {
    const body = await readCapped(response, MAX_PLAYLIST_BYTES);
    if (body === null) return null;
    return { text: body };
  }

  // A generic content type on a playlist is common (proxies serve `.m3u8` as
  // `application/octet-stream`), but so is a video file. Read a prefix and decide.
  const prefix = await readPrefix(response, SNIFF_BYTES);
  if (!isPlaylist(prefix)) return null;

  const full = await fetch(target, {
    redirect: "follow",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  const body = await readCapped(full, MAX_PLAYLIST_BYTES);
  return body === null ? null : { text: body };
}

/** Read at most `maxBytes` of a body, cancelling the rest. Null when it overflows. */
async function readCapped(response: Response, maxBytes: number): Promise<string | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let out = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      out += decoder.decode(value, { stream: true });
    }
  } catch {
    return null;
  }
  return out + decoder.decode();
}

/** Read a prefix of a body and hang up, without downloading the whole thing. */
async function readPrefix(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let out = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      out += decoder.decode(value, { stream: true });
      if (total >= maxBytes) break;
    }
  } catch {
    // A truncated read still tells us what the first bytes were.
  }
  await reader.cancel().catch(() => undefined);
  return out;
}

function forwardedHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  const range = request.headers.get("range");
  if (range) headers.range = range;
  const userAgent = request.headers.get("user-agent");
  if (userAgent) headers["user-agent"] = userAgent;
  return headers;
}

function playlistFor(body: string, debugHeaders: Record<string, string>): Response {
  return playlist(body, debugHeaders);
}

export function looksLikeProgressiveFile(target: string): boolean {
  try {
    const path = new URL(target).pathname.toLowerCase();
    return MEDIA_EXTENSIONS.some((extension) => path.endsWith(extension));
  } catch {
    return true;
  }
}

/** Null when the URL may be fetched, otherwise the reason to refuse it. */
export function targetRejection(target: string, env: Settings): string | null {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return "Invalid u parameter";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "Only http(s) URLs can be relayed";
  }
  if (env.ALLOW_PRIVATE_HOSTS === "1") return null;
  if (isPrivateHost(url.hostname.toLowerCase())) {
    return "Refusing to relay a private address";
  }
  return null;
}
