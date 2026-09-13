import re, base64, html, sys
from pathlib import Path

src = Path("wechat-2026-09-13.md").read_text(encoding="utf-8")
body = src.split("## 附一")[0]

lines = body.split("\n")
# 丢掉 h1 与元信息块（标题在公众号单独填）、封面图（单独上传）
out, i = [], 0
title = ""
while i < len(lines):
    ln = lines[i]
    if ln.startswith("# ") and not title:
        title = ln[2:].strip(); i += 1; continue
    if ln.startswith("> 微信公众号 ·") or ln.startswith("> 标题已定"):
        i += 1; continue
    if "img/00-cover.png" in ln:
        i += 1; continue
    out.append(ln); i += 1
body = "\n".join(out)

def img_tag(path):
    p = Path(path)
    if not p.exists(): return f"<p>[缺图 {path}]</p>"
    mime = "image/png" if p.suffix == ".png" else "image/jpeg"
    b64 = base64.b64encode(p.read_bytes()).decode()
    return (f'<p style="text-align:center;margin:16px 0;">'
            f'<img src="data:{mime};base64,{b64}" '
            f'style="max-width:100%;border-radius:6px;border:1px solid #e8e8e8;"/></p>')

def inline(s):
    s = html.escape(s)
    s = re.sub(r'`([^`]+)`', r'<code style="background:#f5f5f5;padding:1px 4px;border-radius:3px;font-size:14px;color:#c7254e;">\1</code>', s)
    s = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', s)
    s = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'<a href="\2">\1</a>', s)
    return s

P = 'style="font-size:16px;line-height:1.75;margin:14px 0;color:#333;"'
res, i, lines = [], 0, body.split("\n")
while i < len(lines):
    ln = lines[i]
    m = re.match(r'^!\[[^\]]*\]\(([^)]+)\)', ln.strip())
    if m:
        for mm in re.findall(r'!\[[^\]]*\]\(([^)]+)\)', ln):
            res.append(img_tag(mm))
        i += 1; continue
    if ln.startswith("```"):
        buf = []; i += 1
        while i < len(lines) and not lines[i].startswith("```"):
            buf.append(lines[i]); i += 1
        i += 1
        res.append('<pre style="background:#f7f7f7;border-left:3px solid #d0d0d0;padding:12px;'
                   'overflow-x:auto;font-size:13px;line-height:1.6;color:#333;border-radius:4px;">'
                   f'<code>{html.escape(chr(10).join(buf))}</code></pre>')
        continue
    if ln.startswith("|"):
        rows = []
        while i < len(lines) and lines[i].startswith("|"):
            rows.append(lines[i]); i += 1
        cells = [[c.strip() for c in r.strip().strip("|").split("|")] for r in rows]
        cells = [c for c in cells if not all(re.fullmatch(r':?-{2,}:?', x or '-') for x in c)]
        t = ['<table style="width:100%;border-collapse:collapse;font-size:14px;margin:14px 0;">']
        for ri, row in enumerate(cells):
            tag = "th" if ri == 0 else "td"
            bg = ' background:#fafafa;' if ri == 0 else ''
            t.append("<tr>" + "".join(
                f'<{tag} style="border:1px solid #e0e0e0;padding:8px;text-align:left;{bg}">{inline(c)}</{tag}>'
                for c in row) + "</tr>")
        t.append("</table>")
        res.append("".join(t)); continue
    if ln.startswith("> "):
        buf = []
        while i < len(lines) and lines[i].startswith(">"):
            buf.append(lines[i].lstrip(">").strip()); i += 1
        res.append('<blockquote style="border-left:4px solid #07c160;background:#f8f9fa;'
                   'padding:12px 16px;margin:16px 0;color:#444;font-size:15px;line-height:1.7;">'
                   + "<br/>".join(inline(b) for b in buf if b) + "</blockquote>")
        continue
    if ln.startswith("### "):
        res.append(f'<h3 style="font-size:17px;font-weight:600;margin:24px 0 10px;color:#222;">{inline(ln[4:])}</h3>'); i += 1; continue
    if ln.startswith("## "):
        res.append(f'<h2 style="font-size:19px;font-weight:700;margin:34px 0 14px;padding-left:10px;'
                   f'border-left:4px solid #07c160;color:#111;">{inline(ln[3:])}</h2>'); i += 1; continue
    if ln.strip() == "---":
        res.append('<hr style="border:none;border-top:1px solid #e5e5e5;margin:28px 0;"/>'); i += 1; continue
    if ln.startswith("- "):
        buf = []
        while i < len(lines) and lines[i].startswith("- "):
            buf.append(lines[i][2:]); i += 1
        res.append('<ul style="margin:14px 0;padding-left:22px;">' + "".join(
            f'<li style="font-size:16px;line-height:1.75;margin:6px 0;color:#333;">{inline(b)}</li>' for b in buf) + "</ul>")
        continue
    if ln.strip():
        res.append(f'<p {P}>{inline(ln)}</p>')
    i += 1

Path("wechat-paste.html").write_text(
    '<!doctype html><meta charset="utf-8"><title>' + html.escape(title) + '</title>'
    '<div style="max-width:677px;margin:0 auto;padding:20px;font-family:-apple-system,BlinkMacSystemFont,'
    '\'PingFang SC\',\'Helvetica Neue\',sans-serif;-webkit-font-smoothing:antialiased;">'
    + "\n".join(res) + '</div>', encoding="utf-8")
print("标题:", title)
print("HTML 生成: wechat-paste.html")
