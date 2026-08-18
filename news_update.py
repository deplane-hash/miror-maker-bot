#!/usr/bin/env python3
"""Track changes in /var/www/html since the last snapshot.

Every run, detected changes are appended to a pending buffer (news_pending.json).
When run with "publish", a single combined patch note is generated via a free
OpenRouter model covering ALL accumulated changes, printed as RESULT for the
bot to post, and the pending buffer is cleared.
"""
import hashlib
import json
import os
import re
import sys

SITE_DIR = os.environ.get("FH_SITE_DIR", "/var/www/html")
SNAPSHOT_FILE = os.environ.get("FH_SNAPSHOT_FILE", "/root/freedns-unblocker/news_snapshot.json")
PENDING_FILE = os.environ.get("FH_PENDING_FILE", "/root/freedns-unblocker/news_pending.json")
OPENROUTER_KEY = os.environ.get("FH_OPENROUTER_KEY", "")
MODEL = os.environ.get("FH_NEWS_MODEL", "google/gemma-4-26b-a4b-it:free")
EXCLUDE_DIRS = {"assets", "api", "node_modules", ".git"}
MAX_FILES = int(os.environ.get("FH_NEWS_MAX_FILES", "25"))


def snapshot():
    out = {}
    for root, dirs, files in os.walk(SITE_DIR):
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS and not d.startswith(".")]
        for f in files:
            p = os.path.join(root, f)
            rel = os.path.relpath(p, SITE_DIR)
            try:
                st = os.stat(p)
                with open(p, "rb") as fh:
                    h = hashlib.sha1(fh.read(65536)).hexdigest()
                out[rel] = {"mtime": int(st.st_mtime), "size": st.st_size, "sha1": h}
            except Exception:
                continue
    return out


def describe_file(rel):
    if rel.endswith(".php"):
        try:
            with open(os.path.join(SITE_DIR, rel), "r", errors="ignore") as fh:
                head = fh.read(1200)
            m = re.search(r"/\*\*(.*?)\*/", head, re.S)
            if m:
                return " ".join(m.group(1).split())[:160]
            return "PHP script"
        except Exception:
            return "PHP script"
    if rel.endswith(".html"):
        return "HTML page"
    if rel.endswith(".json"):
        return "JSON data file"
    if rel.endswith(".js"):
        return "JavaScript file"
    return os.path.basename(rel)


def load_pending():
    try:
        return json.load(open(PENDING_FILE))
    except Exception:
        return {"added": [], "changed": [], "removed": []}


def save_pending(p):
    json.dump(p, open(PENDING_FILE, "w"), indent=2)


def call_openrouter(prompt):
    if not OPENROUTER_KEY:
        return None
    import requests
    for model in [MODEL, "nvidia/nemotron-3-super-120b-a12b:free"]:
        try:
            r = requests.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={"Authorization": "Bearer " + OPENROUTER_KEY},
                json={
                    "model": model,
                    "messages": [
                        {"role": "system", "content": "You write patch notes for the users of a privacy web proxy called FreedomHub. Format them like this example:\n\nLAN Sync\nFixes on macro sharing, this was desyncing in several ways at once\n\nTrajectories (new module)\nNew render module, shows where a throw is going to land\nWorks for bows, crossbows including every bolt of multishot and loaded rockets, snowballs, eggs, ender pearls, splash and lingering potions, tridents, fishing rods, exp bottles, fire charges and wind charges\n\nGame mode\n.gamemode <mode> changes your real game mode without sending a chat command\n.fakegm <mode> is client side only, nothing is sent to the server, .fakegm reset puts it back\n\nKeybinds while typing\nTyping in the creative search bar fired module keybinds\n\nImproved security\n\n@everyone\n\nRules: Group ALL changes under short section headers (one line each, no markdown symbols, no bold asterisks). Under each header put 1-3 plain lines explaining each change: what it does, and if it is a fix, what was broken and why. Cover every listed change. No intro or outro sentences. No bullet dashes, no markdown, no emoji. Always end the note with a line 'Improved security' and a final line '@everyone'."},
                        {"role": "user", "content": prompt},
                    ],
                    "max_tokens": 500,
                    "temperature": 0.7,
                },
                timeout=60,
            )
            if r.status_code == 200:
                return r.json()["choices"][0]["message"]["content"].strip()
        except Exception:
            continue
    return None


def collect():
    cur = snapshot()
    prev = {}
    if os.path.exists(SNAPSHOT_FILE):
        try:
            prev = json.load(open(SNAPSHOT_FILE))
        except Exception:
            prev = {}

    added = [k for k in cur if k not in prev]
    changed = [k for k in cur if k in prev and cur[k]["sha1"] != prev[k]["sha1"]]
    removed = [k for k in prev if k not in cur]
    added.sort(), changed.sort(), removed.sort()

    json.dump(cur, open(SNAPSHOT_FILE, "w"), indent=2)

    if not added and not changed and not removed:
        print("RESULT: no_changes")
        return

    pending = load_pending()
    for k in added:
        if k not in pending["added"]:
            pending["added"].append(k)
    for k in changed:
        if k not in pending["changed"]:
            pending["changed"].append(k)
    for k in removed:
        if k not in pending["removed"]:
            pending["removed"].append(k)
    save_pending(pending)
    print(f"RESULT: accumulated ({len(added)} new, {len(changed)} updated, {len(removed)} removed)")


def publish():
    pending = load_pending()
    if not pending["added"] and not pending["changed"] and not pending["removed"]:
        print("RESULT: no_changes")
        return

    lines = []
    if pending["added"]:
        lines.append("NEW:\n" + "\n".join(f"- {k} ({describe_file(k)})" for k in pending["added"][:MAX_FILES]))
    if pending["changed"]:
        lines.append("UPDATED:\n" + "\n".join(f"- {k} ({describe_file(k)})" for k in pending["changed"][:MAX_FILES]))
    if pending["removed"]:
        lines.append("REMOVED: " + ", ".join(pending["removed"][:MAX_FILES]))

    prompt = ("Here is everything that changed on the FreedomHub server since the last patch note:\n\n"
              + "\n\n".join(lines)
              + "\n\nWrite one patch-note style news update covering ALL of these changes for our users.")

    news = call_openrouter(prompt)
    if not news:
        news = ("Site update\nChanges were made to the FreedomHub server files:\n" +
                "\n".join("- " + k for k in pending["added"][:8] + pending["changed"][:8]) +
                "\n\nImproved security\n\n@everyone")
        print("STATUS: ai_fallback", file=sys.stderr)

    save_pending({"added": [], "changed": [], "removed": []})
    print("RESULT: " + news)


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "collect"
    if cmd == "publish":
        publish()
    else:
        collect()


if __name__ == "__main__":
    main()