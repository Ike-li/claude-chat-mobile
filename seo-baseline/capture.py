#!/usr/bin/env python3
"""Capture a curl-based SEO baseline for Claude Chat Mobile Pages.

Writes seo-baseline/baseline-YYYY-MM-DD.json and seo-baseline/latest.json
(relative to the gh-pages worktree root).
"""
from __future__ import annotations

import hashlib
import json
import re
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://ike-li.github.io/claude-chat-mobile"
URLS = [
    f"{BASE}/",
    f"{BASE}/en/quickstart.html",
    f"{BASE}/en/security.html",
    f"{BASE}/docs-site/",
    f"{BASE}/docs-site/index.html",
    f"{BASE}/docs-site/pages/quickstart.html",
    f"{BASE}/docs-site/pages/security-model.html",
    f"{BASE}/docs-site/pages/overview.html",
    f"{BASE}/docs-site/pages/production-deploy.html",
    f"{BASE}/docs-site/content/overview.html",  # expect 404 after content→fragments
    f"{BASE}/robots.txt",
    f"{BASE}/sitemap.xml",
    f"{BASE}/llms.txt",
    f"{BASE}/demo.webm",
    f"{BASE}/og-image.jpg",
]


def extract_html(html: str) -> dict:
    def one(pat, flags=re.I | re.S):
        m = re.search(pat, html, flags)
        return m.group(1).strip() if m else None

    title = one(r"<title[^>]*>(.*?)</title>")
    if title:
        title = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", title)).strip()
    desc = one(r'<meta[^>]+name=["\']description["\'][^>]*content=["\']([^"\']*)["\']')
    if not desc:
        desc = one(r'<meta[^>]+content=["\']([^"\']*)["\'][^>]*name=["\']description["\']')
    canonical = one(r'<link[^>]+rel=["\']canonical["\'][^>]*href=["\']([^"\']+)["\']')
    robots = one(r'<meta[^>]+name=["\']robots["\'][^>]*content=["\']([^"\']+)["\']')
    lang = one(r'<html[^>]*lang=["\']([^"\']+)["\']')
    h1s = [
        re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", h)).strip()
        for h in re.findall(r"<h1[^>]*>(.*?)</h1>", html, re.I | re.S)
    ]
    h2s = [
        re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", h)).strip()
        for h in re.findall(r"<h2[^>]*>(.*?)</h2>", html, re.I | re.S)
    ]
    ld_types = []
    for block in re.findall(
        r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
        html,
        re.I | re.S,
    ):
        try:
            data = json.loads(block)
            if isinstance(data, list):
                for d in data:
                    if isinstance(d, dict) and d.get("@type"):
                        ld_types.append(d["@type"])
            elif isinstance(data, dict) and data.get("@type"):
                ld_types.append(data["@type"])
        except Exception:
            ld_types.append("(invalid-json)")
    hreflangs = re.findall(
        r'rel=["\']alternate["\'][^>]*hreflang=["\']([^"\']+)["\'][^>]*href=["\']([^"\']+)["\']',
        html,
        re.I,
    )
    if not hreflangs:
        hreflangs = re.findall(
            r'hreflang=["\']([^"\']+)["\'][^>]*href=["\']([^"\']+)["\']',
            html,
            re.I,
        )
    og = {
        "title": one(r'<meta[^>]+property=["\']og:title["\'][^>]*content=["\']([^"\']*)["\']'),
        "description": one(
            r'<meta[^>]+property=["\']og:description["\'][^>]*content=["\']([^"\']*)["\']'
        ),
        "image": one(r'<meta[^>]+property=["\']og:image["\'][^>]*content=["\']([^"\']*)["\']'),
        "url": one(r'<meta[^>]+property=["\']og:url["\'][^>]*content=["\']([^"\']*)["\']'),
    }
    return {
        "title": title,
        "title_len": len(title or ""),
        "meta_description": desc,
        "meta_description_len": len(desc or ""),
        "canonical": canonical,
        "robots_meta": robots,
        "lang": lang,
        "h1": [h for h in h1s if h],
        "h1_count": len([h for h in h1s if h]),
        "h2": [h for h in h2s if h][:20],
        "h2_count": len([h for h in h2s if h]),
        "jsonld_types": ld_types,
        "hreflang": [{"lang": a, "href": b} for a, b in hreflangs],
        "og": og,
        "picture_count": html.count("<picture"),
        "webp_source_count": html.count('type="image/webp"') + html.count("type='image/webp'"),
        "has_demo_webm": "demo.webm" in html,
        "has_demo_gif": "demo.gif" in html,
        "en_quickstart_link": "en/quickstart.html" in html,
    }


def curl(url: str) -> dict:
    r = subprocess.run(
        [
            "curl",
            "-sS",
            "-L",
            "-D",
            "-",
            "-o",
            "/tmp/seo-drift-body",
            "-w",
            "\n__CURL__%{http_code}|%{url_effective}|%{content_type}|%{size_download}",
            "--max-time",
            "45",
            url,
        ],
        capture_output=True,
        text=True,
        errors="replace",
    )
    raw = r.stdout
    if "__CURL__" not in raw:
        return {"url": url, "error": f"curl failed: {r.stderr[:200]}"}
    head, meta = raw.rsplit("__CURL__", 1)
    code, final, ctype, size = meta.strip().split("|", 3)
    body = Path("/tmp/seo-drift-body").read_bytes()
    text = body.decode("utf-8", errors="replace")
    status = int(code)
    if "Page not found" in text and "GitHub Pages" in text and status == 200:
        status = 404
    rec = {
        "url": url,
        "final_url": final,
        "status_code": status,
        "content_type": ctype,
        "size_bytes": int(size) if size.isdigit() else len(body),
        "sha256": hashlib.sha256(body).hexdigest(),
        "fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    if status == 200 and (
        "text/html" in (ctype or "")
        or url.rstrip("/").endswith((".html", "docs-site"))
        or url.endswith("/")
    ):
        rec.update(extract_html(text))
    elif status == 200 and ("text/plain" in (ctype or "") or url.endswith((".txt", "robots.txt"))):
        rec["text_preview"] = text[:500]
        rec["text_lines"] = text.count("\n") + (1 if text and not text.endswith("\n") else 0)
        if "Sitemap:" in text:
            rec["sitemap_ref"] = re.findall(r"(?im)^Sitemap:\s*(\S+)", text)
    elif status == 200 and ("xml" in (ctype or "") or url.endswith(".xml")):
        rec["loc_count"] = len(re.findall(r"<loc>", text))
        rec["locs_sample"] = re.findall(r"<loc>([^<]+)</loc>", text)[:8]
    return rec


def main() -> None:
    pages = []
    for u in URLS:
        print("fetch", u)
        pages.append(curl(u))
        time.sleep(0.25)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    snap = {
        "schema_version": 1,
        "site": BASE,
        "label": "post-seo-A-B-ship",
        "captured_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "tool": "seo-baseline/capture.py (curl; Clash-safe)",
        "note": (
            "Official claude-seo drift_baseline.py blocked by Clash fake-IP (198.18.x). "
            "This snapshot is the project SoT for drift compare."
        ),
        "pages": pages,
    }
    out_dir = ROOT / "seo-baseline"
    out_dir.mkdir(parents=True, exist_ok=True)
    dated = out_dir / f"baseline-{stamp}.json"
    payload = json.dumps(snap, ensure_ascii=False, indent=2) + "\n"
    dated.write_text(payload, encoding="utf-8")
    (out_dir / "latest.json").write_text(payload, encoding="utf-8")
    print("wrote", dated)
    for p in pages:
        print(f"  {p.get('status_code')} {p.get('size_bytes')} {p['url']}")


if __name__ == "__main__":
    main()
