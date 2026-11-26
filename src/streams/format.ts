// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/** Time formatting shared by the stream list labels and the playlist debug headers. */

import type { SkipWindow } from "../addon/types.js";

/** `228665` -> `3:48`; an hour or more gets `1:02:33`. */
export function formatMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** Human-readable cut list, e.g. `intro 3:48-4:06, credits 57:12-end`. */
export function describeWindows(windows: readonly SkipWindow[]): string {
  return windows
    .map((window) => {
      const end = window.endMs === null ? "end" : formatMs(window.endMs);
      return `${window.type} ${formatMs(window.startMs)}-${end}`;
    })
    .join(", ");
}

/** One line for a Stremio stream description. */
export function describeCuts(windows: readonly SkipWindow[]): string {
  return `TheIntroDB cuts: ${describeWindows(windows)}`;
}
