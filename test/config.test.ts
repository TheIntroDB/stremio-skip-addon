// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TheIntroDB

import assert from "node:assert/strict";
import test from "node:test";

import { configIdSuffix, decodeConfig, encodeConfig, parseStremioId, sourceBase } from "../src/config.js";

test("the cutting mode is part of the install, and junk is ignored", () => {
  const encoded = encodeConfig({
    src: ["https://aiostreams.example/manifest.json"],
    types: ["intro"],
    cuts: "off",
  });
  assert.equal(decodeConfig(encoded)?.cuts, "off");

  const asAlways = Buffer.from(
    JSON.stringify({ src: ["https://a.example"], types: ["intro"], cuts: "always" }),
  ).toString("base64url");
  assert.equal(decodeConfig(asAlways)?.cuts, "blocking", "a word a human would write is accepted");

  const nonsense = Buffer.from(
    JSON.stringify({ src: ["https://a.example"], types: ["intro"], cuts: "whenever" }),
  ).toString("base64url");
  assert.equal(decodeConfig(nonsense)?.cuts, undefined, "and anything else falls back to the deployment");
});

test("a config round-trips through the URL segment", () => {
  const encoded = encodeConfig({
    src: ["https://aiostreams.example/manifest.json"],
    types: ["intro", "recap"],
    key: "abc-123",
    name: "Living Room",
  });

  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  const decoded = decodeConfig(encoded);
  assert.deepEqual(decoded, {
    src: ["https://aiostreams.example"],
    types: ["intro", "recap"],
    key: "abc-123",
    name: "Living Room",
  });
});

test("the manifest URL suffix is accepted as a source and normalised away", () => {
  assert.equal(sourceBase("https://a.example/manifest.json"), "https://a.example");
  assert.equal(sourceBase("https://a.example/path/manifest.json"), "https://a.example/path");
  assert.equal(sourceBase("https://a.example/path/"), "https://a.example/path");
  assert.deepEqual(decodeConfig(encodeConfig({ src: ["https://a.example/x/manifest.json"], types: ["intro"] }))?.src, [
    "https://a.example/x",
  ]);
});

test("encoding is deterministic and config-id stable", () => {
  const config = { src: ["https://a.example"], types: ["intro", "credits"] as const };
  const first = encodeConfig({ ...config, types: [...config.types] });
  const second = encodeConfig({ ...config, types: [...config.types] });
  assert.equal(first, second);
  assert.equal(configIdSuffix(first), configIdSuffix(second));
  assert.notEqual(
    configIdSuffix(first),
    configIdSuffix(encodeConfig({ src: ["https://a.example"], types: ["intro"] })),
  );
});

test("types default to intro/recap/credits when absent, and are filtered to known values", () => {
  const encoded = encodeConfig({ src: ["https://a.example"], types: [] });
  assert.deepEqual(decodeConfig(encoded)?.types, []);
  assert.deepEqual(decodeConfig(encodeConfig({ src: ["https://a.example"], types: ["recap"] }))?.types, ["recap"]);

  // Unknown types and duplicates never survive the round trip.
  const raw = Buffer.from(JSON.stringify({ src: ["https://a.example"], types: ["recap", "nonsense", "recap"] }))
    .toString("base64url");
  assert.deepEqual(decodeConfig(raw)?.types, ["recap"]);
});

test("a config without a usable source is rejected", () => {
  assert.equal(decodeConfig(""), null);
  assert.equal(decodeConfig("not base64!!"), null);
  assert.equal(decodeConfig(Buffer.from("null").toString("base64url")), null);
  assert.equal(decodeConfig(Buffer.from('{"src":[]}').toString("base64url")), null);
  assert.equal(decodeConfig(Buffer.from('{"src":["ftp://a.example"]}').toString("base64url")), null);
  assert.equal(decodeConfig(Buffer.from('{"src":[123]}').toString("base64url")), null);
});

test("non-ASCII names survive the config", () => {
  const encoded = encodeConfig({ src: ["https://a.example"], types: ["intro"], name: "Última — salón" });
  assert.equal(decodeConfig(encoded)?.name, "Última — salón");
});

test("only IMDb ids, and only well-formed episode addresses, parse", () => {
  assert.deepEqual(parseStremioId("tt0111161"), { imdbId: "tt0111161", season: null, episode: null });
  assert.deepEqual(parseStremioId("tt0903747:1:1"), { imdbId: "tt0903747", season: 1, episode: 1 });
  assert.deepEqual(parseStremioId("tt0903747:0:10"), { imdbId: "tt0903747", season: 0, episode: 10 });

  assert.equal(parseStremioId("kitsu:1234:1"), null);
  assert.equal(parseStremioId("tt0903747:1"), null);
  assert.equal(parseStremioId("tt0903747:1:1:1"), null);
  assert.equal(parseStremioId("tt0903747:a:b"), null);
  assert.equal(parseStremioId(""), null);
});
