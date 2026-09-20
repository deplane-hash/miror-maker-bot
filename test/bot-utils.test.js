"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createLineReader, parseScrapeResponse } = require("../bot-utils");

test("line reader preserves lines split across stream chunks", () => {
  const lines = [];
  const reader = createLineReader((line) => lines.push(line));
  const tab = String.fromCharCode(9);
  const newline = String.fromCharCode(10);
  reader.push(["RESULT", "first", "blocked"].join(tab) + newline + "RES");
  reader.push(["ULT", "second", "not_blocked"].join(tab));
  reader.flush();
  assert.deepEqual(lines, [
    ["RESULT", "first", "blocked"].join(tab),
    ["RESULT", "second", "not_blocked"].join(tab),
  ]);
});

test("scrape parser accepts progress logs before final JSON", () => {
  const result = parseScrapeResponse([
    "[scrape] requesting page 12",
    JSON.stringify({ domains: [{ domain: "example.test", domain_id: "42" }] }),
  ].join("\n"));
  assert.deepEqual(result.domains, [{ domain: "example.test", domain_id: "42" }]);
});

test("scrape parser rejects incomplete output", () => {
  assert.throws(() => parseScrapeResponse("[scrape] request failed"), /no valid domain list/);
});
