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

// Check ONE url and emit its result. Unlike checker.js, does NOT stop early.
async function checkUrl(client, channel, url) {
  const msg = await channel.sendSlash(appId, "check linewize", url);
  const finalMsg = await waitForResult(client, msg, timeoutMs);
  if (!finalMsg) {
    console.log(`RESULT\t${url}\tunknown`);
    return "unknown";
  }
  const status = classify(extractText(finalMsg));
  console.log(`RESULT\t${url}\t${status}`);
  return status;
}

async function main() {
  const client = new Client({ checkUpdate: false });
  try {
    await client.login(token);
    const channel = await client.channels.fetch(channelId);
    for (const url of urls) {
      await checkUrl(client, channel, url);
    }
  } finally {
    client.destroy();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
