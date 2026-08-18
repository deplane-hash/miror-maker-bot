#!/usr/bin/env node
"use strict";
const {
  Client, GatewayIntentBits, AttachmentBuilder, REST, Routes,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle,
} = require("discord.js");
const { spawnSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const cfg = require("../config.json");
const DIR = path.join(__dirname, "..");
const REGISTERED_FILE = path.join(DIR, "registered.txt");
const ACCOUNTS_FILE = path.join(DIR, "accounts.json");
const ACCT_STATE_FILE = path.join(DIR, "account_state.json");
const freednsPy = path.join(DIR, "freedns.py");
const checkerJs = path.join(DIR, "checker.js");
const checkerAllJs = path.join(DIR, "checker_all.js");
const registerDiscordPy = path.join(DIR, "register_discord.py");
const createAccountPy = path.join(DIR, "create_account.py");
const CODE_FILE = process.env.FH_CODE_FILE || "/root/code.txt";
const NOTIFY_CHANNEL_ID = cfg.discord.notify_channel_id || "1538166114595377183";
const OWNER_ID = cfg.discord.owner_id || "1335356263986499604";

const TOKEN = cfg.discord.bot_token;
const CLIENT_ID = cfg.discord.bot_application_id;
const GUILD_ID = cfg.discord.guild_id;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
let busy = false;
let captchaResolver = null;

// ---------- helpers ----------
function loadRegistered() {
  if (!fs.existsSync(REGISTERED_FILE)) return new Set();
  return new Set(fs.readFileSync(REGISTERED_FILE, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")));
}
function saveRegistered(set) {
  fs.writeFileSync(REGISTERED_FILE, "# registered freedomhub subdomains\n" + [...set].sort().join("\n") + "\n");
}

// ---------- freedns account rotation ----------
// Pool: accounts with stored cookies first, then any cookie-less accounts, then config creds.
function accountPool() {
  const withCookie = [];
  const withoutCookie = [];
  try {
    if (fs.existsSync(ACCOUNTS_FILE)) {
      const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));
      for (const a of accounts) {
        if (a && a.username && a.password) {
          const entry = { username: a.username, password: a.password };
          if (a.cookie) { entry.cookie = a.cookie; withCookie.push(entry); }
          else withoutCookie.push(entry);
        }
      }
    }
  } catch (e) {
    console.error("[accounts] failed to load accounts.json:", e.message);
  }
  return [...withCookie, ...withoutCookie, { username: cfg.freedns.username, password: cfg.freedns.password }];
}
function loadAccountState() {
  try {
    if (fs.existsSync(ACCT_STATE_FILE)) return JSON.parse(fs.readFileSync(ACCT_STATE_FILE, "utf8"));
  } catch (e) {}
  return { index: 0, failed: [] };
}
function saveAccountState(state) {
  fs.writeFileSync(ACCT_STATE_FILE, JSON.stringify(state, null, 2));
}
// Returns current account creds, rotating past any known-failed ones.
function currentAccount() {
  const pool = accountPool();
  const state = loadAccountState();
  let idx = Math.min(state.index, pool.length - 1);
  let guard = 0;
  while (state.failed.includes(pool[idx].username) && guard < pool.length) {
    idx = (idx + 1) % pool.length;
    guard++;
  }
  return pool[idx];
}
function markAccountFailed(username) {
  const state = loadAccountState();
  if (!state.failed.includes(username)) state.failed.push(username);
  const pool = accountPool();
  const idx = pool.findIndex((a) => a.username === username);
  state.index = idx >= 0 ? (idx + 1) % pool.length : 0;
  saveAccountState(state);
}
function resetAccountFailures() {
  const state = loadAccountState();
  state.failed = [];
  saveAccountState(state);
}
function runPy(args) {
  const res = spawnSync("python3", [freednsPy, ...args], {
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 90000,
    env: { ...process.env, FH_DIR: DIR },
  });
  if (res.error) throw res.error;
  return res.stdout.toString();
}
// Check domains via the selfbot; streams results and stops at the first
// unblocked domain. Resolves with the candidate that was unblocked, or null.
function linewizeCheckFirst(candidates, onStatus) {
  return new Promise((resolve, reject) => {
    const urls = candidates.map((c) => c.url || `http://www.${c.domain}/`);
    const proc = spawn("node", [checkerJs, ...urls]);
    proc.stdout.on("data", (buf) => {
      for (const line of buf.toString().split("\n")) {
        const l = line.trim();
        if (l.startsWith("FOUND_FIRST\t")) {
          const url = l.split("\t")[1];
          const cand = candidates.find((c) => (c.url || `http://www.${c.domain}/`) === url);
          proc.kill();
          resolve(cand);
          return;
        }
        if (l.startsWith("RESULT\t")) {
          const parts = l.split("\t");
          if (onStatus) onStatus(`Checked ${parts[1]}: ${parts[2]}`);
        }
      }
    });
    proc.stderr.on("data", (buf) => {
      for (const line of buf.toString().split("\n")) {
        const l = line.trim();
        if (l) onStatus(l);
      }
    });
    proc.on("error", reject);
    proc.on("exit", (code) => resolve(null));
    // Hard safety: never let the check hang forever.
    const hard = setTimeout(() => {
      proc.kill();
      resolve(null);
    }, (cfg.behavior.timeout_ms || 90000) + 15000);
    proc.on("exit", () => clearTimeout(hard));
  });
}

// ---------- captcha flow (button + modal, all on the SAME message) ----------
// Strip any captcha image/button from the progress message once it's no
// longer needed (mirror made, or the run finished).
function clearCaptchaImage(interaction) {
  interaction.editReply({ files: [], components: [] }).catch(() => {});
}
function waitForCaptchaText(interaction, authorId) {
  if (fs.existsSync(CODE_FILE)) fs.unlinkSync(CODE_FILE);
  return new Promise((resolve, reject) => {
    const img = fs.readFileSync(path.join(DIR, "captcha.png"));
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("captcha_btn").setLabel("I read it - type captcha").setStyle(ButtonStyle.Primary)
    );
    interaction
      .editReply({ content: "CAPTCHA - read the image, then click the button to enter the characters.", files: [new AttachmentBuilder(img, "captcha.png")], components: [row] })
      .then(() => {
        captchaResolver = { authorId, resolve, reject, timer: setTimeout(() => {
          captchaResolver = null;
          reject(new Error("Timed out waiting for captcha input"));
        }, cfg.behavior.timeout_ms) };
      })
      .catch(reject);
  });
}

// ---------- register flow ----------
function registerWithCaptcha(interaction, authorId, domainId, domain) {
  return new Promise((resolve, reject) => {
    const acct = currentAccount();
    const args = [domainId, domain, acct.username, acct.password];
    const proc = spawn("python3", [registerDiscordPy, ...args], { env: { ...process.env, FH_DIR: DIR, FH_CODE_FILE: CODE_FILE } });
    let settled = false;
    proc.stdout.on("data", async (buf) => {
      for (const line of buf.toString().trim().split("\n")) {
        const l = line.trim();
        if (l === "CAPTCHA_READY" && !settled) {
          try {
            await waitForCaptchaText(interaction, authorId);
          } catch (e) {
            settled = true; proc.kill(); reject(e);
          }
        }
        if (l.startsWith("RESULT") && !settled) {
          settled = true; proc.kill(); resolve(l);
        }
      }
    });
    proc.stderr.on("data", () => {});
    proc.on("error", (e) => { if (!settled) { settled = true; reject(e); } });
    proc.on("exit", (code) => { if (!settled) { settled = true; resolve("RESULT: python_exit_" + code); } });
  });
}

// ---------- main command ----------
// Create one mirror: scan -> linewize check -> register with account rotation.
// Returns the created URL string, or null if none was created.
async function createOneMirror(interaction, registered) {
  // Scan pages until we find unregistered domains, starting from a random page.
  const { page_min, page_max } = cfg.freedns;
  const startPage = page_min + Math.floor(Math.random() * (page_max - page_min + 1));
  let candidates = [];
  let page = null;
  const pages = [];
  for (let p = startPage; p <= page_max; p++) pages.push(p);
  for (let p = page_min; p < startPage; p++) pages.push(p);
  for (const p of pages) {
    const scrapeOut = runPy(["scrape", String(p)]);
    const scrape = JSON.parse(scrapeOut.trim().split("\n").pop());
    candidates = scrape.domains.filter((d) => !registered.has(d.domain));
    await interaction.editReply(`Scanned page ${p}: ${candidates.length} unregistered domains.`);
    if (candidates.length > 0) { page = p; break; }
  }
  if (page === null || candidates.length === 0) {
    await interaction.editReply("No unregistered domains found in the page range.");
    return null;
  }

  await interaction.editReply(`Checking up to ${candidates.length} domains from page ${page}... (stops at first unblocked)`);
  const statusUpdates = (msg) => interaction.editReply(msg).catch(() => {});
  const chosen = await linewizeCheckFirst(candidates, statusUpdates);
  if (!chosen) {
    await interaction.editReply("No unblocked domain found among the candidates.");
    return null;
  }

  const cand = chosen;
  // Try registering, rotating accounts on subdomain_limit until one succeeds or all fail.
  let result = "RESULT: no_accounts";
  const attempts = new Set();
  for (let guard = 0; guard < accountPool().length; guard++) {
    const acct = currentAccount();
    if (attempts.has(acct.username)) break;
    attempts.add(acct.username);
    await interaction.editReply(`UNBLOCKED: ${cand.domain} - registering freedomhub.${cand.domain} -> 5.45.110.86 (account: ${acct.username})`);
    result = await registerWithCaptcha(interaction, interaction.user.id, cand.domain_id, cand.domain);
    if (result.includes("RESULT: OK")) {
      registered.add(cand.domain);
      saveRegistered(registered);
      const url = `http://freedomhub.${cand.domain}`;
      const channel = client.channels.cache.get(NOTIFY_CHANNEL_ID);
      if (channel) {
        channel.send(`MIRROR MADE: ${url}`).catch((e) => console.error("[notify] send failed:", e.message));
      } else {
        client.channels.fetch(NOTIFY_CHANNEL_ID).then((ch) => ch.send(`MIRROR MADE: ${url}`)).catch((e) => console.error("[notify] fetch/send failed:", e.message));
      }
      clearCaptchaImage(interaction);
      return url;
    }
    if (result.includes("RESULT: subdomain_limit")) {
      markAccountFailed(acct.username);
      continue;
    }
    await interaction.editReply(result);
    clearCaptchaImage(interaction);
    return null;
  }
  await interaction.editReply(`All freedns accounts are at their subdomain limit or failed. Last result: ${result}`);
  clearCaptchaImage(interaction);
  return null;
}

async function runNewMirror(interaction) {
  if (busy) return interaction.editReply("Another /newmirror is already running - wait for it to finish.");
  busy = true;
  try {
    const count = Math.max(1, Math.min(5, interaction.options.getInteger("count") || 1));
    const registered = loadRegistered();
    const made = [];
    for (let i = 1; i <= count; i++) {
      await interaction.editReply(`Creating mirror ${i}/${count}...`);
      const url = await createOneMirror(interaction, registered);
      if (url) {
        made.push(url);
        await interaction.editReply(`Mirror ${i}/${count}: ${url}`);
      } else {
        break;
      }
      if (i < count) await new Promise((r) => setTimeout(r, 1500));
    }
    if (made.length > 0) {
      await interaction.editReply(`Done: ${made.length}/${count} mirrors created.`);
    }
    return;
  } catch (e) {
    await interaction.editReply(`Error: ${e.message}`).catch(() => {});
  } finally {
    clearCaptchaImage(interaction);
    busy = false;
  }
}

// Create one freedns account. Uses the same captcha button+modal flow.
function createAccount(interaction) {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", [createAccountPy], { env: { ...process.env, FH_DIR: DIR, FH_CODE_FILE: CODE_FILE, FH_MAIL_DB: process.env.FH_MAIL_DB } });
    let settled = false;
    proc.stdout.on("data", async (buf) => {
      for (const line of buf.toString().trim().split("\n")) {
        const l = line.trim();
        console.log("[create_account]", l);
        if (l.startsWith("STATUS:")) {
          await interaction.editReply("Account: " + l.slice(7)).catch(() => {});
        }
        if (l.startsWith("CAPTCHA_READY")) {
          const [, username, email] = l.split("\t");
          try {
            await interaction.editReply(`Creating freedns account ${username} (${email})...`);
            await waitForCaptchaText(interaction, interaction.user.id);
          } catch (e) {
            settled = true; proc.kill(); reject(e);
          }
        }
        if (l.startsWith("RESULT") && !settled) {
          settled = true; proc.kill(); resolve(l);
        }
      }
    });
    proc.stderr.on("data", (buf) => console.log("[create_account stderr]", buf.toString()));
    proc.on("error", (e) => { if (!settled) { settled = true; reject(e); } });
    proc.on("exit", (code) => { if (!settled) { settled = true; resolve("RESULT: python_exit_" + code); } });
  });
}

async function runNewAccount(interaction) {
  if (busy) return interaction.editReply("Another command is already running - wait for it to finish.");
  busy = true;
  try {
    const count = Math.max(1, Math.min(10, interaction.options.getInteger("count") || 1));
    const results = [];
    for (let i = 1; i <= count; i++) {
      await interaction.editReply(`Creating freedns account ${i}/${count}...`);
      const result = await createAccount(interaction);
      results.push(result.replace(/^RESULT: /, ""));
      if (result.includes("RESULT: OK")) {
        const ok = /OK (\S+)/.exec(result);
        await interaction.editReply(`Created account ${i}/${count}: ${ok ? ok[1] : "?"}. ${i < count ? "Next one incoming - solve the captcha." : "Done."}`);
      } else {
        await interaction.editReply(`Account ${i}/${count} failed: ${result.replace(/^RESULT: /, "")}.`);
      }
      if (i < count) {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    const okCount = results.filter((r) => r.startsWith("OK ")).length;
    await interaction.editReply(`Done: ${okCount}/${count} accounts created.`);
  } catch (e) {
    await interaction.editReply(`Error: ${e.message}`).catch(() => {});
  } finally {
    clearCaptchaImage(interaction);
    busy = false;
  }
}

async function runLinks(interaction) {
  const domains = loadRegistered();
  const urls = [...domains].sort().map((d) => `http://freedomhub.${d}`);
  if (urls.length === 0) {
    return interaction.editReply("No mirrors registered yet.");
  }
  await interaction.editReply(`**Mirror links (${urls.length}):**\n${urls.join("\n")}`);
}

// ---------- scheduled link health check ----------
// Every CHECK_INTERVAL_MS, check all registered mirrors and post the working
// ones to the notify channel. Runs even while no command is active.
const CHECK_INTERVAL_MS = parseInt(process.env.FH_CHECK_INTERVAL_MS || "", 10) || 5 * 60 * 60 * 1000; // 5h
let healthCheckRunning = false;

function runCheckAll(urls) {
  return new Promise((resolve) => {
    const proc = spawn("node", [checkerAllJs, ...urls]);
    const results = [];
    proc.stdout.on("data", (buf) => {
      for (const line of buf.toString().split("\n")) {
        const l = line.trim();
        if (!l.startsWith("RESULT\t")) continue;
        const parts = l.split("\t");
        results.push({ url: parts[1], status: parts[2] });
      }
    });
    proc.on("error", () => resolve(results));
    proc.on("exit", () => resolve(results));
    setTimeout(() => { proc.kill(); resolve(results); }, (cfg.behavior.timeout_ms || 90000) * urls.length + 30000);
  });
}

async function runScheduledCheck() {
  if (healthCheckRunning) return;
  healthCheckRunning = true;
  try {
    const domains = loadRegistered();
    const urls = [...domains].sort().map((d) => `http://freedomhub.${d}`);
    if (urls.length === 0) {
      console.log("[health] no mirrors registered, skipping");
      return;
    }
    console.log(`[health] checking ${urls.length} mirrors...`);
    const results = await runCheckAll(urls);
    const working = results.filter((r) => r.status === "not_blocked").map((r) => r.url);
    const blocked = results.filter((r) => r.status === "blocked").length;
    const unknown = results.filter((r) => r.status === "unknown").length;
    const channel = client.channels.cache.get(NOTIFY_CHANNEL_ID) ||
      (await client.channels.fetch(NOTIFY_CHANNEL_ID).catch(() => null));
    if (!channel) {
      console.error("[health] notify channel not found:", NOTIFY_CHANNEL_ID);
      return;
    }
    const lines = working.length > 0 ? working.join("\n") : "none";
    await channel.send(
      `**MIRROR HEALTH CHECK (${new Date().toLocaleString()})**\n` +
      `Working: ${working.length}/${results.length} | Blocked: ${blocked} | Unknown: ${unknown}\n\n` +
      `**Working links:**\n${lines}`
    ).catch((e) => console.error("[health] send failed:", e.message));
    console.log(`[health] done: ${working.length} working, ${blocked} blocked, ${unknown} unknown`);
  } catch (e) {
    console.error("[health] error:", e.message);
  } finally {
    healthCheckRunning = false;
  }
}

// ---------- scheduled AI news update ----------
// Runs news_update.py "collect" every COLLECT_INTERVAL_MS (3h) to accumulate
// detected changes, and "publish" every PUBLISH_INTERVAL_MS (10h) to post one
// combined patch note covering everything since the last publish.
const NEWS_CHANNEL_ID = (cfg.news && cfg.news.channel_id) || "1538982557440540723";
const COLLECT_INTERVAL_MS = parseInt(process.env.FH_NEWS_COLLECT_MS || "", 10) ||
  ((cfg.news && cfg.news.collect_interval_ms) || 3 * 60 * 60 * 1000); // 3h
const PUBLISH_INTERVAL_MS = parseInt(process.env.FH_NEWS_PUBLISH_MS || "", 10) ||
  ((cfg.news && cfg.news.publish_interval_ms) || 10 * 60 * 60 * 1000); // 10h
let newsRunning = false;

function runNewsScript(arg) {
  const key = (cfg.news && cfg.news.openrouter_key) || "";
  return spawnSync("python3", [path.join(DIR, "news_update.py"), arg], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 90000,
    env: { ...process.env, FH_OPENROUTER_KEY: key, FH_NEWS_MODEL: (cfg.news && cfg.news.model) || "" },
  });
}

async function runNewsCollect() {
  if (newsRunning) return;
  newsRunning = true;
  try {
    const res = runNewsScript("collect");
    const out = (res.stdout || "").toString();
    const errOut = (res.stderr || "").toString();
    for (const line of out.split("\n")) {
      const l = line.trim();
      if (l.startsWith("RESULT: ")) console.log("[news] collect:", l.slice("RESULT: ".length));
    }
    if (errOut) console.error("[news] collect stderr:", errOut.trim());
  } catch (e) {
    console.error("[news] collect error:", e.message);
  } finally {
    newsRunning = false;
  }
}

async function runNewsPublish() {
  if (newsRunning) return;
  newsRunning = true;
  try {
    const res = runNewsScript("publish");
    const out = (res.stdout || "").toString();
    const errOut = (res.stderr || "").toString();
    let news = null;
    const idx = out.indexOf("RESULT: ");
    if (idx !== -1) {
      const v = out.slice(idx + "RESULT: ".length).trim();
      if (v !== "no_changes") news = v;
    }
    if (errOut) console.error("[news] publish stderr:", errOut.trim());
    if (!news) {
      console.log("[news] publish: no accumulated changes, skipping post");
      return;
    }
    const channel = client.channels.cache.get(NEWS_CHANNEL_ID) ||
      (await client.channels.fetch(NEWS_CHANNEL_ID).catch(() => null));
    if (!channel) {
      console.error("[news] channel not found:", NEWS_CHANNEL_ID);
      return;
    }
    await channel.send(`**FreedomHub Patch Note** — ${new Date().toLocaleString()}\n${news}`)
      .catch((e) => console.error("[news] send failed:", e.message));
    console.log("[news] posted patch note");
  } catch (e) {
    console.error("[news] publish error:", e.message);
  } finally {
    newsRunning = false;
  }
}

// ---------- bootstrap ----------
async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
    body: [
      { name: "newmirror", description: "Find and register new freedomhub mirror subdomains", options: [
        { name: "count", description: "How many mirrors to create (max 5)", type: 4, required: false },
      ] },
      { name: "newaccount", description: "Create freedns accounts via freedomhub.at temp mailboxes", options: [
        { name: "count", description: "How many accounts to create", type: 4, required: false },
      ] },
      { name: "links", description: "List all registered mirror links (owner only)" },
    ],
  });
  console.log("[bot] commands registered");
}

async function main() {
  await registerCommands();
  await client.login(TOKEN);
  client.on("interactionCreate", async (interaction) => {
    try {
      if (interaction.isCommand() && interaction.commandName === "newmirror") {
        await interaction.deferReply();
        await runNewMirror(interaction);
        return;
      }
      if (interaction.isCommand() && interaction.commandName === "newaccount") {
        await interaction.deferReply();
        await runNewAccount(interaction);
        return;
      }
      if (interaction.isCommand() && interaction.commandName === "links") {
        await interaction.deferReply();
        if (interaction.user.id !== OWNER_ID) {
          await interaction.editReply("Only the owner can use this command.");
          return;
        }
        await runLinks(interaction);
        return;
      }
      if (interaction.isButton() && interaction.customId === "captcha_btn") {
        const r = captchaResolver;
        if (!r || r.authorId !== interaction.user.id) {
          return interaction.reply({ content: "No captcha is waiting for you right now.", flags: 64 }).catch(() => {});
        }
        const modal = new ModalBuilder().setCustomId("captcha_modal").setTitle("Enter captcha characters");
        const input = new TextInputBuilder()
          .setCustomId("captcha_text")
          .setLabel("Characters from the image")
          .setStyle(TextInputStyle.Short)
          .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal).catch(() => {});
      }
      if (interaction.isModalSubmit() && interaction.customId === "captcha_modal") {
        const r = captchaResolver;
        const val = interaction.fields.getTextInputValue("captcha_text").trim();
        console.log("[modal] submit from", interaction.user.id, "value:", JSON.stringify(val), "resolver:", !!r);
        if (r && r.authorId === interaction.user.id && val) {
          clearTimeout(r.timer);
          captchaResolver = null;
          fs.writeFileSync(CODE_FILE, val);
          r.resolve(val);
        }
        return interaction.deferUpdate().catch(() => {});
      }
    } catch (e) {
      console.error("interaction handler error:", e.message);
    }
  });
  console.log("[bot] ready");
  // Schedule periodic mirror health checks.
  // Schedule periodic mirror health checks (every CHECK_INTERVAL_MS = 5h).
  setInterval(runScheduledCheck, CHECK_INTERVAL_MS);
  // Schedule periodic AI news collection (3h) and combined patch note publish (10h).
  setInterval(runNewsCollect, COLLECT_INTERVAL_MS);
  setInterval(runNewsPublish, PUBLISH_INTERVAL_MS);
}

main().catch((e) => { console.error(e); process.exit(1); });

// Never let an unhandled error kill the process - log and keep running.
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));