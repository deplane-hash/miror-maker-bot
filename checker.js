#!/usr/bin/env node
"use strict";
const { Client } = require("discord.js-selfbot-v13");
const cfg = require("./config.json");

const token = cfg.discord.token;
const appId = cfg.discord.application_id;
const channelId = cfg.discord.channel_id;
const timeoutMs = cfg.behavior.timeout_ms;

const urls = process.argv.slice(2);

function classify(text) {
  const t = (text || "");
  // Real format: "Results for URL\n<U> unblocked • <B> blocked\n..."
  const m = t.match(/(\d+)\s*unblocked\s*•\s*(\d+)\s*blocked/i);
  if (m) {
    const unblocked = parseInt(m[1], 10);
    const blocked = parseInt(m[2], 10);
    if (unblocked > 0) return "not_blocked";
    return "blocked";
  }
  const tl = t.toLowerCase();
  if (/not blocked|unblocked|not forbidden|not restricted|is not|accessible|reachable/.test(tl)) {
    return "not_blocked";
  }
  if (/blocked|forbidden|restricted|denied|not accessible|unreachable|blacklist/.test(tl)) {
    return "blocked";
  }
  return "unknown";
}

function hasResult(text) {
  // Require the real result format: "N unblocked • M blocked"
  return /(\d+)\s*unblocked\s*•\s*(\d+)\s*blocked/i.test(text);
}

async function checkUrl(client, channel, url) {
  const msg = await channel.sendSlash(appId, "check linewize", url);
  const msgId = msg.id;
  // Wait for an edit that actually contains the result, not the intermediate
  // "Loading..." / empty edits the linewize bot emits first.
  const finalMsg = await new Promise((resolve) => {
    const done = (m) => {
      if (m.id !== msgId) return;
      const text = extractText(m);
      if (hasResult(text)) {
        client.off("messageUpdate", done);
        resolve(m);
      }
    };
    client.on("messageUpdate", done);
    setTimeout(() => {
      client.off("messageUpdate", done);
      resolve(extractText(msg) && hasResult(extractText(msg)) ? msg : null);
    }, timeoutMs);
  });
  if (!finalMsg) {
    console.log(`RESULT\t${url}\tunknown\tcheck timed out`);
    return "unknown";
  }
  const full = extractText(finalMsg);
  const status = classify(full);
  console.log(`RESULT\t${url}\t${status}\t${full.replace(/\t/g, " ")}`);
  return status;
}

function extractText(m) {
  const embedTexts = (m.embeds || [])
    .map((e) => [e.title, e.description, e.fields && e.fields.map((f) => `${f.name}: ${f.value}`).join("\n")]
      .filter(Boolean).join("\n"))
    .join("\n");
  return [m.content, embedTexts].filter(Boolean).join(" ");
}

async function main() {
  const client = new Client({ checkUpdate: false });
  await client.login(token);
  const channel = await client.channels.fetch(channelId);
  for (const url of urls) {
    const status = await checkUrl(client, channel, url);
    if (status === "not_blocked") {
      console.log("FOUND_FIRST\t" + url);
      break;
    }
  }
  client.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});