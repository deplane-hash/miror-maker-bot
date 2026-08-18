# FreedomHub Mirror Bot (`miror-maker-bot`)

A Discord bot that automatically finds unblocked domains in the freeDNS
(`freedns.afraid.org`) registry, checks them against a school linewize
filter, and registers `freedomhub.<domain>` subdomains pointing at a
mirror host — so the site stays reachable even as domains get blocked.

Everything is driven from Discord: scan, check, register, create
accounts, and list live links.

## How it works

```
/newmirror
   │
   ├─ 1. SCRAPE   Read a random registry page (freedns.py)
   │              → candidate domains not yet registered
   │
   ├─ 2. CHECK    For each candidate, ask the linewize bot via a
   │              Discord selfbot (checker.js + "check linewize")
   │              → stop at the first UNBLOCKED domain
   │
   └─ 3. REGISTER  register_discord.py logs into freeDNS (saved cookie
                   or fresh login), shows a captcha image in Discord,
                   waits for your typed answer, submits the subdomain
                   → "freedomhub.<domain>" → 5.45.110.86
                   → posts "MIRROR MADE: <url>" to the notify channel
```

Accounts are rotated automatically: when one freeDNS account hits its
subdomain limit, the bot marks it failed and tries the next account
with a valid saved cookie.

## Requirements

- A Linux server (tested on Debian/Ubuntu) with:
  - Node.js 18+ and `npm`
  - Python 3.8+ with `requests` and `beautifulsoup4`
- Two Discord accounts/apps:
  1. A **bot** (used for `/newmirror`, `/newaccount`, `/links`)
  2. A **selfbot token** that has access to a channel where the
     *linewize* slash command is available (used to check domains)
- A freeDNS account (`freedns.afraid.org`) to register subdomains
  under. For higher volume, create multiple accounts (see `/newaccount`).

## Setup

```bash
# 1. Clone / copy the project onto the server, then:
cd freedns-unblocker
npm install
pip install requests beautifulsoup4

# 2. Configure
cp config.example.json config.json
#    - fill in your Discord bot token, selfbot token, IDs
#    - freeDNS credentials + registry page range
#    - notify channel and owner user id

# 3. Start
node botv14/bot.js
# or, if you installed the systemd unit (see below):
systemctl enable --now freedns-unblocker
```

## Discord commands

| Command               | Who     | Description                                             |
|-----------------------|---------|---------------------------------------------------------|
| `/newmirror [count]`  | anyone  | Create 1–5 mirrors (scan → check → register).           |
| `/newaccount [count]` | anyone  | Create 1–10 freeDNS accounts using `@freedomhub.at` mailboxes. Requires the mailbox database (see below). |
| `/links`              | owner   | List every registered mirror URL.                       |

When a captcha appears, read the image and click the button to type the
characters.

## Configuration reference

All options live in `config.json` (see `config.example.json`).

- `freedns.username` / `freedns.password` — main freeDNS login (used as
  a last-resort account). Store cookies for additional accounts in
  `accounts.json` so fresh logins (which freeDNS rate-limits by IP)
  aren't needed.
- `freedns.page_min` / `page_max` — registry pages to scan.
- `freedns.subdomain` / `destination` — what to register and where to
  point it (default `freedomhub` → `5.45.110.86`).
- `discord.token` — selfbot token (linewize checking).
- `discord.bot_token` / `bot_application_id` — slash-command bot.
- `discord.channel_id` — where the selfbot runs `/check linewize`.
- `discord.guild_id` — the server the commands are registered on.
- `discord.notify_channel_id` — success notifications.
- `discord.owner_id` — who may use `/links`.
- `behavior.timeout_ms` — how long to wait for a check result.

Environment overrides (optional):

| Var             | Default                        | Purpose                         |
|-----------------|--------------------------------|---------------------------------|
| `FH_DIR`        | `/root/freedns-unblocker`      | project directory               |
| `FH_CODE_FILE`  | `/root/code.txt`               | captcha answer file             |
| `FH_MAIL_DB`    | `/var/lib/freedomhub/mail.db`  | mailbox DB for account creation |
| `FH_FALLBACK_COOKIE` | (built-in)                 | cookie when no account matches  |

## Accounts (`accounts.json`)

Each entry stores freeDNS credentials plus a verified `dns_cookie`:

```json
[
  { "username": "fhXXXX1234", "password": "...", "email": "fhXXXX1234@freedomhub.at", "cookie": "..." }
]
```

- `set_cookie.py USERNAME COOKIE` adds a cookie for an account.
- The bot prefers cookie-bearing accounts (freeDNS blocks fresh logins
  from repeated server IPs).
- Account rotation state is kept in `account_state.json`.

## /newaccount (optional)

Creates freeDNS accounts with a disposable `@freedomhub.at` mailbox and
auto-clicks the activation link. This needs the mailbox **SQLite**
database path (`FH_MAIL_DB`) to exist and the mail delivery service to
be running on the same host. If you don't need account creation, you
can ignore this command — cookies can also be added by hand.

## Project layout

```
freedns-unblocker/
├── botv14/bot.js        # Discord bot (commands, captcha, orchestration)
├── checker.js           # selfbot: runs "check linewize" on candidate URLs
├── freedns.py           # freeDNS login, registry scrape, captcha, register
├── register_discord.py  # per-registration helper (login→captcha→submit)
├── create_account.py    # freeDNS account creation via temp mailbox
├── set_cookie.py        # store a dns_cookie for an account
├── config.json          # your secrets & settings (gitignored)
├── config.example.json  # template
├── accounts.json        # freeDNS accounts + cookies
├── registered.txt       # domains already registered (auto-maintained)
└── account_state.json   # rotation state (auto-maintained)
```

## Troubleshooting

- **"RESULT: login_failed"** — freeDNS is rate-limiting fresh logins
  from the server IP. Add verified cookies to `accounts.json`
  (`set_cookie.py`) or wait for the block to clear.
- **"RESULT: captcha_wrong"** — the captcha was misread; run the
  command again.
- **"RESULT: subdomain_limit"** — that account is full; the bot rotates
  to the next one automatically.
- **No unblocked domain found** — all candidates on the scanned page
  are filtered. The bot starts each run at a random page and wraps, so
  just try again.