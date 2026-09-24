# `_build/` — 站点的生成与自检脚本

全部零依赖（除 `build-zh.mjs` 用主工作树的 playwright），可反复跑，幂等。
路径一律用 `git rev-parse --git-common-dir` 定位主工作树，不写死。

## 改了什么，就跑什么

| 你改了 | 跑这个 | 不跑的后果 |
|---|---|---|
| `index.html` | `build-zh.mjs` | **`/zh/` 悄悄过期**。它是首页切中文后 dump 的快照，不是运行时渲染的；英文页照常更新，中文页停在上一版，**零报错** |
| 任何页面的增删 | `build-sitemap.mjs` | sitemap 漏页或指向已删的文件 |
| 重新生成了 `diagrams/` | `build-diagrams-seo.mjs` | archify 覆盖掉 canonical / description / 底部导航，13 张图页重新变回死胡同 |
| 重新生成了 `docs-site/` | `build-docs-nav.mjs` | 手册 28 页重新变回只在内部循环、不回站点主干 |
| 重新生成了 `docs-site/` | `build-descriptions.mjs` | 手册页的 meta description 退回十几个字的导语（「本页讲：…」整段消失）。`check-seo` 只把宽度 <20 判失败，偏短的只列成「不算失败」的提示，**所以不会红**。2026-09-24 就这样漏跑上线过一次 |
| 重新生成了 `docs-site/`，或改了 `book.config.cjs` | `build-llms.mjs` | **`llms.txt` 与 `llms-full.txt` 同时过期**（一条命令管两份）。它们是 AI agent 读这个项目的入口（AEO）：前者按 token 标注决定先加载哪几页，标错就是按错误预算加载（首次接上时实测 28 个标注**全部**对不上）；后者是 28 章正文的合成，**页面更新而它没重生成时 agent 读到的是旧正文，且没有任何外部症状** —— 线上 200、字节数也像那么回事 |

## 提交前跑

```bash
node _build/check-seo.mjs             # canonical / description / 重复 / 旧许可证残留 / llms.txt 清单与 token
node _build/check-event-contract.mjs  # 站点的事件清单 ⇔ 主仓 protocol.js
node _build/check-link-graph.mjs      # 从首页 BFS，钉住「没有孤儿页」
```

三个都是零网络、秒级。`check-event-contract` 需要主工作树在原位。

## 部署后跑

```bash
node _build/submit-indexnow.mjs       # 推送 sitemap 的 URL 给 Bing / Yandex / Seznam
python3 ../seo-baseline/capture.py    # 重拍 SEO 漂移基线（从线上抓，必须等 Pages 生效）
python3 ../seo-baseline/compare.py    # 与基线对比，期望 Findings: 0
```

Google 不在 IndexNow 这条链上 —— 它只认 Search Console，必须人工提交。
站点已验证的 GSC 资源是「网址前缀」`https://ike-li.github.io/claude-chat-mobile/`，
验证文件是根目录下的 `google*.html`，**别删**。

## 两个反直觉的点

- **`robots.txt` 对爬虫不生效**。RFC 9309 规定它只在主机根被读取，而本站那份在
  `/claude-chat-mobile/` 子路径下。域根属于 `ike-li.github.io` 仓库，该仓库不存在。
  所以真正要挡的页面各自带 `<meta name="robots" content="noindex">`，别指望 `Disallow`。
- **`check-link-graph` 报绿不代表每条链接都必要**。站内链接有冗余（删掉首页指向
  `/diagrams/` 的链接后它仍然全绿，因为 docs-site 那 28 页也指向那里）。它守的是
  「没有页面掉出链接图」，不是「链接结构最优」。
