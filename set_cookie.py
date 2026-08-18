#!/usr/bin/env python3
"""Store a freedns dns_cookie for an account in accounts.json."""
import json
import os
import sys

DIR = os.environ.get("FH_DIR", "/root/freedns-unblocker")
OUT = os.path.join(DIR, "accounts.json")


def load():
    if os.path.exists(OUT):
        return json.load(open(OUT))
    return []


def main():
    args = sys.argv[1:]
    if len(args) == 2:
        # usage: set_cookie.py USERNAME COOKIE
        username, cookie = args
        accounts = load()
        for a in accounts:
            if a.get("username") == username:
                a["cookie"] = cookie
                json.dump(accounts, open(OUT, "w"), indent=2)
                print(f"cookie set for {username}")
                return
        print(f"account {username} not found in accounts.json")
        return
    print("usage: set_cookie.py USERNAME COOKIE")


if __name__ == "__main__":
    main()