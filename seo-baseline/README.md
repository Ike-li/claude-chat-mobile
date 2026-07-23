# SEO baseline（漂移监控）

`https://ike-li.github.io/claude-chat-mobile/` 的 SEO 关键面快照。  
基线标签 `post-seo-A-B-ship`：robots/sitemap/llms、canonical、JSON-LD、WebP、英文安装页之后拍下。

## 为何不用官方 `/seo drift baseline`？

本机 Clash 下 `claude-seo` 的 `drift_baseline.py` 会因 DNS rebinding（`ike-li.github.io` → `198.18.x`）拒绝抓取。  
本目录用 **curl 打 GitHub Pages 公网**，同一网络可复验。

## 文件

| 文件 | 作用 |
|------|------|
| `baseline-YYYY-MM-DD.json` | 冻结快照 |
| `latest.json` | 当前基线指针（与最新快照同内容） |
| `compare.py` | 线上重抓 vs 基线 |
| `capture.py` | 重拍基线 |

## 改完 gh-pages 并 push 后：5 分钟检查清单

在 **gh-pages 工作树根**（本仓库此 worktree）执行。Pages 通常 1–2 分钟生效；若对比失败可再等一会重跑。

### 0. 等部署

```bash
# 可选：看远程 tip 是否已是你刚 push 的 commit
git fetch origin gh-pages && git log -1 --oneline origin/gh-pages
```

### 1. 一键漂移对比（主门禁）

```bash
python3 seo-baseline/compare.py
# 期望：Findings: 0，exit 0
# Critical/High 漂移 → exit 1（status / title / H1 / canonical / JSON-LD / demo.gif 回潮 / sitemap loc 数等）
```

### 2. 抓取基建（30 秒）

```bash
BASE=https://ike-li.github.io/claude-chat-mobile
for p in /robots.txt /sitemap.xml /llms.txt /en/quickstart.html /docs-site/pages/quickstart.html; do
  curl -sS -o /dev/null -w "%{http_code} %{content_type} $p\n" -L --max-time 20 "$BASE$p"
done
# 期望：全部 200；robots/llms 为 text/plain；sitemap 为 application/xml（或 text/xml）
```

### 3. 首页与媒体（60 秒）

```bash
BASE=https://ike-li.github.io/claude-chat-mobile
curl -sS -L "$BASE/" | grep -E 'rel="canonical"|application/ld\+json|demo\.webm|demo\.gif|en/quickstart' | head
# 期望：有 canonical、有 ld+json、有 demo.webm、无 demo.gif、有 en/quickstart
curl -sS -o /dev/null -w "%{http_code} %{content_type} demo.webm\n" -L "$BASE/demo.webm"
curl -sS -o /dev/null -w "%{http_code} old gif (expect 404)\n" -L "$BASE/demo.gif"
curl -sS -o /dev/null -w "%{http_code} webp sample\n" -L "$BASE/screenshots/03-approval-en.webp"
```

### 4. 中英安装路径 + hreflang（60 秒）

```bash
BASE=https://ike-li.github.io/claude-chat-mobile
curl -sS -L "$BASE/en/quickstart.html" | grep -E 'canonical|hreflang|Quickstart' | head
curl -sS -L "$BASE/docs-site/pages/quickstart.html" | grep -E 'hreflang|English Quickstart' | head
# 期望：EN 页 title/H1/canonical；双方 hreflang 互指；中文页有 English 横幅
```

### 5. 手册封面 H1 + 面包屑 schema（30 秒）

```bash
BASE=https://ike-li.github.io/claude-chat-mobile
curl -sS -L "$BASE/docs-site/" | grep -E '<h1|BreadcrumbList|canonical' | head
# 期望：H1「封面与导读」；有 BreadcrumbList JSON-LD；canonical 指向 docs-site/
```

### 6. 有意改 SEO 面之后

```bash
python3 seo-baseline/capture.py   # 重写 baseline-日期.json + latest.json
git add seo-baseline/ && git commit -m "seo: 更新 baseline（说明改了什么）"
git push origin gh-pages
```

**不要**在无关文案小改后无脑 recapture；只有 title/canonical/schema/关键 URL/媒体策略变化时才更新基线。

## 对照 / 重拍（简）

```bash
python3 seo-baseline/compare.py
python3 seo-baseline/compare.py --baseline seo-baseline/baseline-2026-07-23.json
python3 seo-baseline/capture.py
```

## 跟踪字段

- 状态码：首页、EN quickstart、手册关键页、robots/sitemap/llms、demo.webm、og-image  
- HTML：title、meta description、canonical、H1/H2、JSON-LD `@type`、hreflang、picture/webp、demo.gif 回归  
- sitemap `<loc>` 数量；robots 文本预览  

## CI 说明

gh-pages 宣传站一般**不**挂 Node 测试 CI；本清单设计为 **push 后本机 5 分钟手跑**。若日后要挂 Actions，需 runner 能直连 `ike-li.github.io`（勿走会把域名解析到 fake-IP 的代理）。
