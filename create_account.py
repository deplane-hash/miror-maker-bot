#!/usr/bin/env python3
"""Create ONE freedns account using a freedomhub.at temp mailbox.

Driven by the Discord bot (same captcha flow as registration):
  1. generate username/password, create mailbox <user>@freedomhub.at
  2. GET /signup/ -> save captcha.png -> print CAPTCHA_READY
  3. poll /root/code.txt for the user's captcha code
  4. POST signup -> poll mail.db for activation email -> click link
  5. print RESULT line; append credentials to accounts.json
"""
import io
import json
import os
import random
import re
import sqlite3
import string
import sys
import time

import requests

BASE = "https://freedns.afraid.org"
MAIL_DB = os.environ.get("FH_MAIL_DB", "/var/lib/freedomhub/mail.db")
DIR = os.environ.get("FH_DIR", "/root/freedns-unblocker")
OUT = os.path.join(DIR, "accounts.json")
CAP_FILE = os.path.join(DIR, "captcha.png")
CODE_FILE = os.environ.get("FH_CODE_FILE", "/root/code.txt")


def log(msg):
    print(f"STATUS: {msg}", flush=True)


def gen_username():
    return "fh" + "".join(random.choices(string.ascii_lowercase + string.digits, k=8))


def gen_password():
    chars = string.ascii_letters + string.digits
    return "".join(random.choices(chars, k=12)) + "A1!"


def ensure_mailbox(username):
    addr = f"{username}@freedomhub.at"
    db = sqlite3.connect(MAIL_DB)
    db.execute(
        "INSERT OR IGNORE INTO mailboxes (user_id, username, address, created_at) "
        "VALUES (?,?,?,datetime('now'))",
        (random.randint(100000, 999999), username, addr),
    )
    db.commit()
    db.close()
    return addr


def wait_for_code(deadline=600):
    if os.path.exists(CODE_FILE):
        os.remove(CODE_FILE)
    start = time.time()
    while time.time() - start < deadline:
        if os.path.exists(CODE_FILE):
            with open(CODE_FILE) as f:
                code = f.read().strip()
            if code:
                return code
        time.sleep(2)
    return None


def wait_for_activation(email, timeout=240):
    db = sqlite3.connect(MAIL_DB)
    db.row_factory = sqlite3.Row
    deadline = time.time() + timeout
    while time.time() < deadline:
        rows = db.execute(
            "SELECT * FROM messages WHERE to_addr=? AND folder='inbox' "
            "AND (lower(subject) LIKE '%freedns%' OR lower(from_addr) LIKE '%freedns%' "
            "     OR lower(body) LIKE '%confirm%' OR lower(body) LIKE '%activate%') "
            "ORDER BY id DESC LIMIT 1",
            (email,),
        ).fetchall()
        if rows:
            return dict(rows[0])
        time.sleep(5)
    return None


def extract_error(html):
    for m in re.findall(r'<font[^>]*color=(?:red|#?ff0000)[^>]*>(.*?)</font>', html, re.S):
        txt = re.sub(r'<[^>]+>', ' ', m).strip()
        if txt:
            return txt[:200]
    for m in re.findall(r'<(?:div|span|td)[^>]*class=["\'][^"\']*(?:error|err|alert|box|msg|note)[^"\']*["\'][^>]*>(.*?)</(?:div|span|td)>', html, re.S):
        txt = re.sub(r'<[^>]+>', ' ', m).strip()
        if txt and len(txt) > 3:
            return txt[:200]
    for kw in ["security code was incorrect", "already", "taken", "invalid", "forbidden", "denied", "must be"]:
        i = html.lower().find(kw)
        if i >= 0:
            return re.sub(r'<[^>]+>', ' ', html[max(0, i - 60):i + 160]).strip()[:200]
    return html[:300]


def activate(msg, session):
    body = (msg.get("body") or "") + "\n"
    m = re.search(r"https?://[^\s\"']*(?:confirm|activate|verify|approve)[^\s\"']*", body)
    if not m:
        m = re.search(r"https?://[^\s\"']+", body)
    if not m:
        return False, "no link", None
    url = m.group(0).rstrip(".,);")
    log(f"clicking activation link {url}")
    r = session.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=30)
    cookie = None
    for c in session.cookies:
        if c.name == "dns_cookie" and c.value:
            cookie = c.value
            break
    return r.status_code == 200, f"{url} -> {r.status_code}", cookie


PROXIES = [
    p for p in [
        os.environ.get("FH_LOGIN_PROXY"),
        "90.151.105.38:1080",
        "203.189.155.68:1080",
        "145.255.239.78:1080",
        "103.216.49.147:1080",
    ] if p
]


def fetch_fresh_proxies(limit=20):
    """Fetch the live SOCKS5 list from databay and return candidate endpoints."""
    try:
        raw = requests.get("https://databay.com/free-proxy-list/socks5.txt", timeout=20).text
        out = [l.strip() for l in raw.split("\n") if l.strip() and not l.startswith("#")]
        return out[:limit]
    except Exception:
        return []


def login_and_save_cookie(username, password):
    """Log the fresh account into freedns and return its dns_cookie, or None.

    Tries each configured proxy first (fresh exit IPs bypass freedns's
    login block on this server), then freshly-fetched proxies, then direct.
    """
    candidates = [None] + PROXIES + fetch_fresh_proxies()
    for proxy in candidates:
        try:
            s = requests.Session()
            s.headers["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
            proxies = {"http": "socks5h://" + proxy, "https": "socks5h://" + proxy} if proxy else None
            s.get(BASE + "/dynamic/", proxies=proxies, timeout=20)
            r = s.post(
                BASE + "/zc.php?step=2",
                data={"username": username, "password": password, "remember": "1",
                      "from": "L2R5bmFtaWMv", "action": "auth", "submit": "Login"},
                allow_redirects=True,
                proxies=proxies,
                timeout=20,
            )
            for c in s.cookies:
                if c.name == "dns_cookie" and c.value:
                    # verify the cookie actually authenticates
                    v = requests.Session()
                    v.headers["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
                    v.cookies.set("dns_cookie", c.value, domain="freedns.afraid.org", path="/")
                    vr = v.get(BASE + "/subdomain/", timeout=20)
                    if "subdomains" in vr.text:
                        log(f"login via {'proxy ' + proxy if proxy else 'direct'}: cookie verified")
                        return c.value
                    log(f"login via {'proxy ' + proxy if proxy else 'direct'}: cookie invalid, trying next")
        except Exception as e:
            log(f"login via {'proxy ' + proxy if proxy else 'direct'}: {type(e).__name__} {str(e)[:60]}")
    return None


def main():
    username = gen_username()
    password = gen_password()
    email = ensure_mailbox(username)
    log(f"mailbox ready: {email}")

    s = requests.Session()
    s.headers["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
    s.get(BASE + "/signup/", timeout=30)

    MAX_ATTEMPTS = 5
    for attempt in range(1, MAX_ATTEMPTS + 1):
        raw = s.get(BASE + "/securimage/securimage_show.php", timeout=30).content
        open(CAP_FILE, "wb").write(raw)
        print(f"CAPTCHA_READY\t{username}\t{email}", flush=True)

        code = wait_for_code()
        if not code:
            print("RESULT: captcha_timeout")
            sys.exit(1)
        log(f"got captcha code {code}, submitting signup...")

        r = s.post(
            BASE + "/signup/?step=2",
            data={
                "firstname": "Fh",
                "lastname": "User",
                "username": username,
                "password": password,
                "password2": password,
                "email": email,
                "captcha_code": code,
                "tos": "1",
                "affirm": "1",
                "action": "signup",
                "send": "Send activation email",
            },
            allow_redirects=True,
            timeout=30,
        )
        low = r.text.lower()
        # captcha wrong -> regenerate and retry
        if "security code was incorrect" in low or ("incorrect" in low and "captcha" in low) or "try again" in low:
            if attempt < MAX_ATTEMPTS:
                log(f"captcha wrong, regenerating (attempt {attempt}/{MAX_ATTEMPTS})")
                continue
            print("RESULT: captcha_wrong")
            sys.exit(1)
        # still showing the join form => signup rejected
        if "name='joinfrm'" in low or 'name="joinfrm"' in low or "joinfrm" in low:
            open("/tmp/signup_error.html", "w").write(r.text)
            print(f"RESULT: signup_error {extract_error(r.text)}")
            sys.exit(1)
        break

    log("signup accepted, waiting for activation email...")
    msg = wait_for_activation(email)
    if not msg:
        print(f"RESULT: no_activation_email {email}")
        sys.exit(1)
    ok, info, act_cookie = activate(msg, s)
    if not ok:
        print(f"RESULT: activation_failed {info}")
        sys.exit(1)
    if act_cookie:
        log(f"dns_cookie captured from activation session")

    acc = {"username": username, "password": password, "email": email}
    cookie = act_cookie or (s.cookies.get("dns_cookie") if s.cookies.get("dns_cookie") else None)
    if cookie:
        acc["cookie"] = cookie
        log(f"saved dns_cookie for {username} (from signup/activation session)")
    else:
        cookie = login_and_save_cookie(username, password)
        if cookie:
            acc["cookie"] = cookie
            log(f"saved dns_cookie for {username} (fresh login)")
        else:
            log(f"no dns_cookie captured for {username} (fresh login may be blocked)")
    accounts = json.load(open(OUT)) if os.path.exists(OUT) else []
    accounts.append(acc)
    json.dump(accounts, open(OUT, "w"), indent=2)
    print(f"RESULT: OK {username} {email}")


if __name__ == "__main__":
    main()