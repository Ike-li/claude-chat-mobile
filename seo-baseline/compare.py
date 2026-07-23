#!/usr/bin/env python3
"""Compare live Pages SEO surface to a stored baseline JSON.

Usage:
  python3 seo-baseline/compare.py
  python3 seo-baseline/compare.py --baseline seo-baseline/baseline-2026-07-23.json

Exit code 1 if any Critical/High drift is found.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def fetch(url: str) -> dict:
    r = subprocess.run(
        [
            "curl", "-sS", "-L", "-D", "-", "-o", "/tmp/seo-compare-body",
            "-w", "\n__CURL__%{http_code}|%{url_effective}|%{content_type}|%{size_download}",
            "--max-time", "45", url,
        ],
        capture_output=True, text=True, errors="replace",
    )
    raw = r.stdout
    if "__CURL__" not in raw:
        return {"url": url, "error": r.stderr[:300] or "curl failed"}
    _, meta = raw.rsplit("__CURL__", 1)
    code, final, ctype, size = meta.strip().split("|", 3)
    body = Path("/tmp/seo-compare-body").read_bytes()
    text = body.decode("utf-8", errors="replace")
    status = int(code)
    if "Page not found" in text and "GitHub Pages" in text and status == 200:
        status = 404
    out = {
        "url": url,
        "status_code": status,
        "content_type": ctype,
        "size_bytes": int(size) if size.isdigit() else len(body),
        "sha256": hashlib.sha256(body).hexdigest(),
        "final_url": final,
    }
    if status == 200 and ("html" in (ctype or "") or url.endswith("/") or ".html" in url):
        def one(pat):
            m = re.search(pat, text, re.I | re.S)
            return m.group(1).strip() if m else None
        title = one(r"<title[^>]*>(.*?)</title>")
        if title:
            title = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", title)).strip()
        desc = one(r'<meta[^>]+name=["\']description["\'][^>]*content=["\']([^"\']*)["\']')
        canonical = one(r'<link[^>]+rel=["\']canonical["\'][^>]*href=["\']([^"\']+)["\']')
        h1s = [re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", x)).strip()
               for x in re.findall(r"<h1[^>]*>(.*?)</h1>", text, re.I | re.S)]
        ld = []
        for block in re.findall(
            r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
            text, re.I | re.S,
        ):
            try:
                data = json.loads(block)
                if isinstance(data, list):
                    ld += [d.get("@type") for d in data if isinstance(d, dict)]
                elif isinstance(data, dict):
                    ld.append(data.get("@type"))
            except Exception:
                ld.append("(invalid-json)")
        out.update({
            "title": title,
            "meta_description": desc,
            "canonical": canonical,
            "h1": h1s,
            "jsonld_types": [x for x in ld if x],
            "has_demo_gif": "demo.gif" in text,
            "en_quickstart_link": "en/quickstart.html" in text,
            "picture_count": text.count("<picture"),
        })
    elif status == 200 and url.endswith("sitemap.xml"):
        out["loc_count"] = text.count("<loc>")
    return out


def severity(field: str) -> str:
    critical = {"status_code"}
    high = {"canonical", "title", "h1", "jsonld_types", "has_demo_gif", "loc_count"}
    if field in critical:
        return "Critical"
    if field in high:
        return "High"
    return "Medium"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--baseline",
        default=str(ROOT / "seo-baseline" / "latest.json"),
        help="Path to baseline JSON",
    )
    args = ap.parse_args()
    base_path = Path(args.baseline)
    if not base_path.is_absolute():
        base_path = ROOT / base_path
    snap = json.loads(base_path.read_text(encoding="utf-8"))
    pages = snap.get("pages") or []
    findings = []
    for old in pages:
        url = old["url"]
        new = fetch(url)
        if new.get("error"):
            findings.append({
                "severity": "Critical", "url": url, "field": "fetch",
                "was": None, "now": new["error"],
            })
            continue
        for field in (
            "status_code", "canonical", "title", "meta_description",
            "h1", "jsonld_types", "has_demo_gif", "en_quickstart_link",
            "picture_count", "loc_count",
        ):
            if field not in old and field not in new:
                continue
            a, b = old.get(field), new.get(field)
            if a is None and b is None:
                continue
            if a != b:
                findings.append({
                    "severity": severity(field),
                    "url": url,
                    "field": field,
                    "was": a,
                    "now": b,
                })
        # size drift warning only if >25% and html/text
        if old.get("size_bytes") and new.get("size_bytes"):
            o, n = old["size_bytes"], new["size_bytes"]
            if o > 0 and abs(n - o) / o > 0.25 and "html" in (old.get("content_type") or ""):
                findings.append({
                    "severity": "Medium",
                    "url": url,
                    "field": "size_bytes",
                    "was": o,
                    "now": n,
                })

    order = {"Critical": 0, "High": 1, "Medium": 2, "Low": 3}
    findings.sort(key=lambda f: (order.get(f["severity"], 9), f["url"], f["field"]))

    print(f"Baseline: {base_path}")
    print(f"Captured: {snap.get('captured_at')}  label={snap.get('label')}")
    print(f"Compared: {len(pages)} URLs")
    print(f"Findings: {len(findings)}")
    for f in findings:
        print(f"  [{f['severity']}] {f['field']}: {f['url']}")
        print(f"      was: {f['was']!r}")
        print(f"      now: {f['now']!r}")
    if not findings:
        print("No drift detected against baseline.")
    bad = [f for f in findings if f["severity"] in ("Critical", "High")]
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
