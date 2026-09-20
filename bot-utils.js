"use strict";

/**
 * Turn arbitrary stream chunks into complete lines without losing a line
 * split between two data events.
 */
function createLineReader(onLine) {
  let pending = "";

  return {
    push(chunk) {
      pending += Buffer.from(chunk).toString("utf8");
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) onLine(line.trim());
      }
    },
    flush() {
      const line = pending.trim();
      pending = "";
      if (line) onLine(line);
    },
  };
}

function parseScrapeResponse(output) {
  const lines = String(output || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const value = JSON.parse(lines[i]);
      if (value && Array.isArray(value.domains)) return value;
    } catch (_) {
      // The scraper may log progress before its final JSON response.
    }
  }
  throw new Error("scraper returned no valid domain list");
}

module.exports = { createLineReader, parseScrapeResponse };
