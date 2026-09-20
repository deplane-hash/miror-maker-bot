"use strict";

const RESULT_PATTERN = /(\d+)\s*unblocked\s*[•·]\s*(\d+)\s*blocked/i;

/**
 * Extract the text that Linewize may put in a message or embed.
 * Keeping this in one place prevents checker.js and checker_all.js from
 * drifting apart as the upstream bot changes its response shape.
 */
function extractText(message) {
  if (!message) return "";

  const embedTexts = (Array.isArray(message.embeds) ? message.embeds : [])
    .map((embed) => [
      embed && embed.title,
      embed && embed.description,
      embed && Array.isArray(embed.fields)
        ? embed.fields
          .map((field) => `${field.name}: ${field.value}`)
          .join("\n")
        : "",
    ].filter(Boolean).join("\n"))
    .filter(Boolean)
    .join("\n");

  return [message.content, embedTexts].filter(Boolean).join(" ");
}

function parseResult(text) {
  const match = String(text || "").match(RESULT_PATTERN);
  if (!match) return null;
  return {
    unblocked: Number.parseInt(match[1], 10),
    blocked: Number.parseInt(match[2], 10),
  };
}

function hasResult(text) {
  return parseResult(text) !== null;
}

function classify(text) {
  const result = parseResult(text);
  if (result) return result.unblocked > 0 ? "not_blocked" : "blocked";

  const value = String(text || "").toLowerCase();

  // Check negative forms before their positive words. For example,
  // "not accessible" must not match the later "accessible" check.
  if (/\b(?:not\s+accessible|not\s+reachable|unreachable)\b/.test(value)) {
    return "blocked";
  }
  if (/\b(?:not\s+blocked|not\s+forbidden|not\s+restricted|not\s+denied|not\s+blacklisted|unblocked)\b/.test(value)) {
    return "not_blocked";
  }
  if (/\b(?:blocked|forbidden|restricted|denied|blacklisted)\b/.test(value)) {
    return "blocked";
  }
  if (/\b(?:accessible|reachable)\b/.test(value)) {
    return "not_blocked";
  }
  return "unknown";
}

/**
 * Wait for a message edit containing a complete Linewize result.
 * The initial response can already contain the result, so it is checked
 * after the listener is attached to avoid a race with fast responses.
 */
function waitForResult(client, message, timeoutMs) {
  return new Promise((resolve) => {
    let timer;
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      client.off("messageUpdate", onUpdate);
      if (timer) clearTimeout(timer);
      resolve(value);
    };

    const onUpdate = (updated) => {
      if (!updated || updated.id !== message.id) return;
      if (hasResult(extractText(updated))) finish(updated);
    };

    client.on("messageUpdate", onUpdate);
    if (hasResult(extractText(message))) finish(message);
    else timer = setTimeout(() => finish(null), timeoutMs);
  });
}

module.exports = { classify, extractText, hasResult, parseResult, waitForResult };
