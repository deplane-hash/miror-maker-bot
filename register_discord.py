#!/usr/bin/env python3
"""Long-running registration helper for the Discord bot.

Flow: login (via saved cookie or fresh creds) -> fetch captcha -> print CAPTCHA_READY
      -> poll the configured code file -> submit -> print RESULT line.
Captcha and submission share ONE requests.Session.
"""
import json
import os
import re
import sys
import time

BASE_DIR = os.environ.get("FH_DIR", "/root/freedns-unblocker")
sys.path.insert(0, BASE_DIR)
import requests
import freedns

DOMAIN_ID = sys.argv[1]
DOMAIN = sys.argv[2] if len(sys.argv) > 2 else "unknown"
USERNAME = sys.argv[3] if len(sys.argv) > 3 else None
PASSWORD = sys.argv[4] if len(sys.argv) > 4 else None
DESTINATION = sys.argv[5] if len(sys.argv) > 5 else "5.45.110.86"
SUBDOMAIN = sys.argv[6] if len(sys.argv) > 6 and sys.argv[6] else "freedomhub"
CODE_FILE = os.environ.get("FH_CODE_FILE", os.path.join(BASE_DIR, "code.txt"))
DIR = BASE_DIR
BASE = "https://freedns.afraid.org"
FALLBACK_COOKIE = os.environ.get("FH_FALLBACK_COOKIE", "").strip()
MAX_SUBDOMAINS = 5
TARGET_SUBDOMAIN = SUBDOMAIN + "." + DOMAIN

if os.path.exists(CODE_FILE):
    os.remove(CODE_FILE)

s = requests.Session()
s.headers["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"


def find_cookie_for(username):
    """Return a stored dns_cookie for this account if we have one."""
    try:
        p = os.path.join(DIR, "accounts.json")
        if not os.path.exists(p):
            return None
        accounts = json.load(open(p))
        for a in accounts:
            if a.get("username") == username and a.get("cookie"):
                return a["cookie"]
    except Exception:
        pass
    return None


def login_session():
    cookie = find_cookie_for(USERNAME) if USERNAME else None
    if cookie:
        s.cookies.set("dns_cookie", cookie, domain="freedns.afraid.org", path="/")
        if freedns._is_logged_in(s):
            print(f"STATUS: using saved cookie for {USERNAME}")
            return True
        print(f"STATUS: saved cookie for {USERNAME} invalid, trying fresh login")
    if USERNAME and PASSWORD:
        s.get(BASE + "/", timeout=30)
        s.post(
            BASE + "/zc.php?step=2",
            data={"username": USERNAME, "password": PASSWORD, "remember": "1",
                  "action": "auth", "submit": "Login"},
            allow_redirects=True,
            timeout=30,
        )
        return freedns._is_logged_in(s)
    if FALLBACK_COOKIE:
        s.cookies.set("dns_cookie", FALLBACK_COOKIE, domain="freedns.afraid.org", path="/")
        return freedns._is_logged_in(s)
    return False


if not login_session():
    print("RESULT: login_failed")
    sys.exit(1)


def account_subdomain_count():
    """Return (count, names) of subdomains on the logged-in account, or (None, []) on failure."""
    try:
        r = s.get(BASE + "/subdomain/", timeout=30)
        html = r.text
        names = [n for n in re.findall(r"<a href=edit\.php\?data_id=\d+>([^<]+)</a>", html)]
        count = len(names)
        return count, names
    except Exception:
        return None, []


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


def submit(code):
    r = s.post(
        BASE + "/subdomain/save.php?step=2",
        data={
            "type": "A",
            "subdomain": SUBDOMAIN,
            "domain_id": DOMAIN_ID,
            "address": DESTINATION,
            "ttlalias": "",
            "ref": "L3N1YmRvbWFpbi8=",
            "captcha_code": code,
            "send": "Save!",
        },
        allow_redirects=True,
        timeout=30,
    )
    txt = r.text
    low = txt.lower()
    if "incorrect" in low or "try again" in low:
        return "captcha_wrong", txt
    if "success" in low or "added" in low or "saved" in low or "created" in low or "/subdomain/" in r.url:
        # Verify the subdomain actually exists on the account before claiming success.
        _, names = account_subdomain_count()
        if TARGET_SUBDOMAIN in names:
            return "ok", txt
        return "verify_failed", txt
    if "already" in low or "exists" in low:
        return "already_exists", txt
    if "limit" in low or "allocated" in low or "maximum" in low or "premium" in low or "upgrade" in low:
        return "subdomain_limit", txt
    return "unexpected", r.url


MAX_ATTEMPTS = 5
count, names = account_subdomain_count()
if count is not None and count >= MAX_SUBDOMAINS:
    print(f"RESULT: subdomain_limit (account has {count} subdomains)")
    sys.exit(0)
print(f"STATUS: account subdomain count {count}")

for attempt in range(1, MAX_ATTEMPTS + 1):
    raw = freedns.fetch_captcha(s)
    open(os.path.join(DIR, "captcha.png"), "wb").write(raw)
    print("CAPTCHA_READY", flush=True)

    code = wait_for_code()
    if not code:
        print("RESULT: captcha_timeout")
        sys.exit(1)

    result, info = submit(code)
    if result == "captcha_wrong" and attempt < MAX_ATTEMPTS:
        print(f"STATUS: captcha wrong, regenerating (attempt {attempt}/{MAX_ATTEMPTS})", flush=True)
        continue
    if result == "subdomain_limit":
        open("/tmp/register_limit.html", "w").write(info)
    if result == "unexpected":
        print("RESULT: unexpected", info)
        print(info[:500])
    elif result == "ok":
        print(f"RESULT: OK {DOMAIN}")
    else:
        print(f"RESULT: {result}")
    sys.exit(0)

print("RESULT: captcha_wrong")
sys.exit(1)
