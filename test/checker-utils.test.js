"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  classify,
  extractText,
  hasResult,
  parseResult,
  waitForResult,
} = require("../checker-utils");

test("parses the canonical Linewize result", () => {
  assert.deepEqual(parseResult("Results for URL\n2 unblocked • 5 blocked"), {
    unblocked: 2,
    blocked: 5,
  });
  assert.equal(classify("Results for URL\n2 unblocked • 5 blocked"), "not_blocked");
  assert.equal(classify("Results for URL\n0 unblocked • 5 blocked"), "blocked");
});

test("does not confuse negated phrases", () => {
  assert.equal(classify("This URL is not accessible"), "blocked");
  assert.equal(classify("This URL is not blocked"), "not_blocked");
  assert.equal(classify("This URL is unreachable"), "blocked");
  assert.equal(classify("This URL is accessible"), "not_blocked");
  assert.equal(classify("The request is still loading"), "unknown");
});

test("extracts content and embed fields", () => {
  const message = {
    content: "Results for URL",
    embeds: [{
      title: "linewize",
      description: "2 unblocked • 1 blocked",
      fields: [{ name: "Summary", value: "complete" }],
    }],
  };
  assert.equal(hasResult(extractText(message)), true);
  assert.equal(classify(extractText(message)), "not_blocked");
});

test("waitForResult accepts a fast initial reply and removes its listener", async () => {
  const client = new EventEmitter();
  const message = { id: "fast", content: "2 unblocked • 0 blocked" };
  const result = await waitForResult(client, message, 50);
  assert.equal(result, message);
  assert.equal(client.listenerCount("messageUpdate"), 0);
});

test("waitForResult resolves a later message update", async () => {
  const client = new EventEmitter();
  const message = { id: "later", content: "Loading..." };
  const pending = waitForResult(client, message, 100);
  client.emit("messageUpdate", { id: "other", content: "2 unblocked • 0 blocked" });
  const updated = { id: "later", content: "2 unblocked • 0 blocked" };
  client.emit("messageUpdate", updated);
  assert.equal(await pending, updated);
  assert.equal(client.listenerCount("messageUpdate"), 0);
});
