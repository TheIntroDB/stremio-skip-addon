// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * The page a browser gets when it asks for a path this addon does not serve.
 *
 * It exists because a Stremio addon is not a website: someone who opens the host
 * directly should be told where the configuration page is, not shown a bare 404.
 */

import { TAILWIND_CSS } from "./styles.generated.js";

export function notFoundPage(origin: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Not found</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${TAILWIND_CSS}</style></head>
<body>
<main class="mx-auto max-w-150 px-5 py-15">
<h1 class="text-xl font-bold">Not found</h1>
<p>This is a Stremio addon, not a website. Start at <a href="${origin}/">${origin}/</a> to build an install link.</p>
</main></body></html>`;
}
