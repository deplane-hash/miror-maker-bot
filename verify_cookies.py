#!/usr/bin/env python3
"""Verify every dns_cookie in accounts.json and report the UserID it maps to."""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import requests

BASE = "https://freedns.afraid.org"
ACCOUNTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "accounts.json")

def main():
    if not os.path.exists(ACCOUNTS):
        print("no accounts.json")
        sys.exit(1)
    accounts = json.load(open(ACCOUNTS))
    if not accounts:
        print("accounts.json is empty")
        return
    for a in accounts:
        u = a.get("username", "?")
        c = a.get("cookie")
        if not c:
            print(f"{u}: NO COOKIE")
            continue
        s = requests.Session()
        s.headers["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
        s.cookies.set("dns_cookie", c, domain="freedns.afraid.org", path="/")
        try:
            r = s.get(BASE + "/menu/", timeout=30)
            if "menu" in r.url and ("Logged in" in r.text or "/logout.php" in r.text):
                m = re.search(r"UserID:\s*</td><td[^>]*>(\d+)", r.text) or re.search(r"UserID[^0-9]{0,40}(\d+)", r.text)
                print(f"{u}: VALID userid={m.group(1) if m else '?'}")
            else:
                print(f"{u}: INVALID (redirected to {r.url})")
        except Exception as e:
            print(f"{u}: ERROR {e}")

if __name__ == "__main__":
    main()
