# Claude Chat Mobile · 项目全景手册

离线静态多页站。源码基线：**dev** 分支（`/Users/raylee/code/claude-chat-mobile`）。本目录位于 **gh-pages** worktree 的 `docs-site/`。

## 本地查看

```bash
# 在本目录
open index.html          # macOS 双击亦可
# 或
python3 -m http.server 8765 --directory .
```

## 重新构建

```bash
node build.cjs           # 由 fragments/*.html + book.config.cjs 生成 pages/ 与 index.html
node verify.cjs          # 链接 / Mermaid / 结构 / emoji 校验
```

> 父仓 `package.json` 含 `"type": "module"`，故构建脚本使用 `.cjs` 扩展名。

## 结构

| 路径 | 说明 |
|---|---|
| `book.config.cjs` | 全书骨架（单一事实来源） |
| `fragments/` | 各页 HTML 片段 |
| `pages/` | 生成页 |
| `assets/` | style / app / mermaid / 搜索索引 |
| `build.cjs` / `verify.cjs` | 生成与校验 |

## 维护约定

- 改结构：先改 `book.config.cjs`，再补 `fragments/<slug>.html`，然后 `node build.cjs`。
- 事实以 dev 代码为准；矛盾记入 `fragments/drift.html`。
- 不要把本手册内容回写进 master/dev 的产品 `docs/`（产品侧保持极简）。
