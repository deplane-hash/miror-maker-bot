#!/usr/bin/env python3
"""freedns automation: login, registry scrape, subdomain registration."""
import io
import json
import os
import random
import re
import subprocess
import sys
import time
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

BASE = "https://freedns.afraid.org"
CFG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")


def load_config():
    with open(CFG_PATH) as f:
        return json.load(f)


def login(session, cfg, tries=3):
    """Login and persist the dns_cookie into cookies.txt for reuse."""
    # If we already have a valid cookie file, just apply it.
    cookie_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cookies.txt")
    if os.path.exists(cookie_file):
        with open(cookie_file) as f:
            for line in f:
                parts = line.strip().split("\t")
                if len(parts) == 7 and parts[0] == cfg["freedns"]["host"] and parts[5] == "dns_cookie":
                    session.cookies.set("dns_cookie", parts[6], domain=cfg["freedns"]["host"], path="/")
        if _is_logged_in(session):
            return True

    for attempt in range(tries):
        try:
            session.post(
                BASE + "/zc.php?step=2",
                data={
                    "username": cfg["freedns"]["username"],
                    "password": cfg["freedns"]["password"],
                    "remember": "1",
                    "action": "auth",
                    "submit": "Login",
                },
                allow_redirects=True,
                timeout=30,
            )
            if _is_logged_in(session):
                _save_cookie(session, cookie_file)
                return True
        except Exception:
            pass
        time.sleep(15 * (attempt + 1))
    return False


def _is_logged_in(session):
    check = session.get(BASE + "/menu/", timeout=30)
    return (
        check.status_code == 200
        and "menu" in check.url
        and ("Logged in" in check.text or "/logout.php" in check.text or ">Logout<" in check.text)
    )


def _save_cookie(session, cookie_file):
    try:
        with open(cookie_file, "w") as f:
            f.write("# Netscape HTTP Cookie File\n")
            for c in session.cookies:
                if c.name in ("dns_cookie", "tz"):
                    f.write(
                        f"{c.domain}\tFALSE\t{c.path}\tFALSE\t{int(c.expires or 0)}\t{c.name}\t{c.value}\n"
                    )
    except Exception:
        pass


def scrape_registry(session, cfg, page=None):
    if page is None:
        page = random.randint(cfg["freedns"]["page_min"], cfg["freedns"]["page_max"])
    url = f"{BASE}/domain/registry/page-{page}.html"
    r = session.get(url, timeout=30)
    soup = BeautifulSoup(r.text, "html.parser")
    domains = []
    for tr in soup.select("tr"):
        cells = tr.find_all("td")
        if len(cells) < 2:
            continue
        link = cells[0].find("a", href=re.compile(r"edit_domain_id="))
        if not link:
            continue
        m = re.search(r"edit_domain_id=(\d+)", link.get("href", ""))
        domain = link.get_text(strip=True)
        status = cells[1].get_text(strip=True).lower()
        website = ""
        wl = cells[0].find("a", href=re.compile(r"^http"))
        if wl:
            website = wl.get("href", "")
        if not domain or not m:
            continue
        domains.append({
            "domain": domain,
            "domain_id": m.group(1),
            "status": status,
            "url": website,
        })
    return domains, page


def fetch_captcha(session):
    r = session.get(BASE + "/securimage/securimage_show.php", timeout=30)
    return r.content


def render_captcha_terminal(img_bytes):
    """Render captcha to terminal with 24-bit half-block drawing."""
    import PIL.Image
    img = PIL.Image.open(io.BytesIO(img_bytes)).convert("RGB")
    w, h = img.size
    cols = 60
    rows = int(h * cols / w * 0.5)
    img = img.resize((cols, rows))
    px = img.load()
    for y in range(0, rows - 1, 2):
        line = ""
        for x in range(cols):
            r1, g1, b1 = px[x, y]
            r2, g2, b2 = px[x, y + 1]
            line += f"\x1b[38;2;{r1};{g1};{b1}m\x1b[48;2;{r2};{g2};{b2}m\u2580"
        line += "\x1b[0m"
        print(line, file=sys.stderr)
    print("\x1b[0m", file=sys.stderr)


def ocr_captcha(img_bytes):
    """Best-effort OCR; returns '' if unusable."""
    import PIL.Image
    import PIL.ImageOps
    import PIL.ImageFilter

    img = PIL.Image.open(io.BytesIO(img_bytes)).convert("L")
    big = img.resize((img.width * 3, img.height * 3), PIL.Image.LANCZOS)
    big = PIL.ImageOps.autocontrast(big)
    p = "/tmp/freedns_captcha_ocr.png"
    big.save(p)
    out = subprocess.run(
        ["tesseract", p, "stdout", "--psm", "8", "--oem", "1",
         "-c", "tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"],
        capture_output=True, text=True, timeout=30)
    return "".join(out.stdout.split())


def solve_captcha(session, attempts=0):
    """Fetch captcha image for manual entry. OCR is unreliable, so skip it."""
    raw = fetch_captcha(session)
    cap_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "captcha.png")
    with open(cap_file, "wb") as f:
        f.write(raw)
    render_captcha_terminal(raw)
    print(f"[captcha] image saved to {cap_file} - enter captcha: ", file=sys.stderr, end="", flush=True)
    answer = sys.stdin.readline().strip() or input().strip()
    return answer, raw


def register_subdomain(session, cfg, domain_id, domain, subdomain=None):
    subdomain = subdomain or cfg["freedns"]["subdomain"]
    dest = cfg["freedns"]["destination"]
    form = session.get(f"{BASE}/subdomain/edit.php?edit_domain_id={domain_id}", timeout=30)
    soup = BeautifulSoup(form.text, "html.parser")
    form_tag = soup.find("form", {"name": "myform"})
    action = f"{BASE}/subdomain/save.php?step=2"
    if form_tag:
        a = form_tag.get("action", "")
        if a:
            action = urljoin(form.url, a)

    captcha, _ = solve_captcha(session)
    payload = {
        "type": "A",
        "subdomain": subdomain,
        "domain_id": domain_id,
        "address": dest,
        "ttlalias": "",
        "ref": "L3N1YmRvbWFpbi8=",
        "captcha_code": captcha,
        "send": "Save!",
    }
    r = session.post(action, data=payload, allow_redirects=True, timeout=30)
    text = r.text
    lower = text.lower()
    if "incorrect, please try again" in lower or "problems!" in lower and "captcha" in lower:
        return False, "captcha_wrong"
    if "already" in lower or "exists" in lower:
        return False, "already_exists"
    if "success" in lower or "added" in lower or "saved" in lower or "created" in lower:
        return True, "ok"
    if "error" in lower:
        return False, "error"
    # ambiguous; treat redirect to /subdomain/ as success
    if "/subdomain/" in r.url or "subdomain" in r.url:
        return True, "ok"
    return False, "unexpected"


def main():
    cfg = load_config()
    cmd = sys.argv[1] if len(sys.argv) > 1 else "scrape"
    s = requests.Session()
    s.headers.update({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept-Language": "en-US,en;q=0.9",
    })

    if not login(s, cfg):
        print("FREEDNS_LOGIN_FAILED", file=sys.stderr)
        sys.exit(2)

    if cmd == "scrape":
        page_arg = sys.argv[2] if len(sys.argv) > 2 else None
        page_arg = int(page_arg) if page_arg else None
        domains, page = scrape_registry(s, cfg, page=page_arg)
        print(json.dumps({"page": page, "domains": domains}))
    elif cmd == "register":
        domain_id = sys.argv[2]
        domain = sys.argv[3] if len(sys.argv) > 3 else "unknown"
        ok, reason = register_subdomain(s, cfg, domain_id, domain)
        print(json.dumps({"ok": ok, "reason": reason, "domain": domain}))
    else:
        print("unknown command", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()