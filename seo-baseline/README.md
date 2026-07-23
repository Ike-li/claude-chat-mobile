# SEO baseline (drift monitoring)

Snapshot of SEO-critical URLs for `https://ike-li.github.io/claude-chat-mobile/` after the A/B SEO ship (robots/sitemap/canonical/schema/WebP/English quickstart).

## Why not `/seo drift baseline`?

The bundled `claude-seo` drift tool refuses Clash fake-IP resolutions (`ike-li.github.io` → `198.18.x`). This folder uses **curl** against the public GitHub Pages edge instead.

## Files

| File | Role |
|------|------|
| `baseline-YYYY-MM-DD.json` | Immutable snapshot |
| `latest.json` | Same content as the newest snapshot (convenience) |
| `compare.py` | Re-fetch live URLs and diff against a baseline |
| `capture.py` | Re-capture a new baseline (optional) |

## Compare (after a Pages deploy)

```bash
# from gh-pages worktree root
python3 seo-baseline/compare.py
# or
python3 seo-baseline/compare.py --baseline seo-baseline/baseline-2026-07-23.json
```

Exit code **1** if any Critical/High field drifted (status, title, H1, canonical, JSON-LD types, demo.gif regression, sitemap loc count, …).

## Recapture

```bash
python3 seo-baseline/capture.py
```

Commit the new `baseline-*.json` and refresh `latest.json` when the intentional SEO surface changes.

## What is tracked

- Status codes for home, EN quickstart, key handbook pages, robots/sitemap/llms, demo.webm, og-image
- HTML: title, meta description, canonical, H1/H2, JSON-LD `@type`s, hreflang, picture/webp signals
- Sitemap `<loc>` count; robots text preview
