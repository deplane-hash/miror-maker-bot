#!/usr/bin/env node
"use strict";
const { Client } = require("discord.js-selfbot-v13");
const cfg = require("./config.json");
const { classify, extractText, waitForResult } = require("./checker-utils");

const token = cfg.discord.token;
const appId = cfg.discord.application_id;
const channelId = cfg.discord.channel_id;
const timeoutMs = Number(cfg.behavior && cfg.behavior.timeout_ms) > 0
  ? Number(cfg.behavior.timeout_ms)
  : 90000;

const urls = process.argv.slice(2);

async function checkUrl(client, channel, url) {
  const msg = await channel.sendSlash(appId, "check linewize", url);
  // Wait for an edit that actually contains the result, not an intermediate
  // "Loading..." / empty edit. The helper also handles fast initial replies
  // and clears its timer when a result arrives.
  const finalMsg = await waitForResult(client, msg, timeoutMs);
  if (!finalMsg) {
    console.log(`RESULT\t${url}\tunknown\tcheck timed out`);
    return "unknown";
  }
  const full = extractText(finalMsg);
  const status = classify(full);
  console.log(`RESULT\t${url}\t${status}\t${full.replace(/\t/g, " ")}`);
  return status;
}

async function main() {
  const client = new Client({ checkUpdate: false });
  try {
    await client.login(token);
    const channel = await client.channels.fetch(channelId);
    for (const url of urls) {
      const status = await checkUrl(client, channel, url);
      if (status === "not_blocked") {
        console.log("FOUND_FIRST\t" + url);
        break;
      }
    }
  } finally {
    client.destroy();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
