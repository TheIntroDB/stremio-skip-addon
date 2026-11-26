#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

/**
 * `npx @theintrodb/stremio-skip-addon` — the short way to run a deployment.
 *
 * This file exists only so the package has a `bin` that is not the service itself: the shebang above
 * is what makes a global install (`npm i -g`) put a runnable command on the PATH, and npm's shim calls
 * this file directly rather than `node dist/cli.js`.
 */

import { main } from "./server.js";

void main();
