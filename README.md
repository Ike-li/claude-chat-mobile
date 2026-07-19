# promo — 宣传创作区

本分支是 claude-chat-mobile 的**宣传素材创作区**（文案、分镜、出片管线），与 `master`/`dev` 开发线**零共同历史**，不参与构建、测试与发布。`git clone` 默认不会拿到本分支。

- 产品代码与部署文档：见 [`master`](https://github.com/Ike-li/claude-chat-mobile) 分支
- 展示站（GitHub Pages）：`gh-pages` 分支 → https://ike-li.github.io/claude-chat-mobile/
- 本分支内容为创作过程草稿，公开可见但随时重写，不构成产品承诺

## 目录

| 路径 | 内容 |
|---|---|
| `copy/vertical.md` | 竖屏短视频文案（抖音 30s / 朋友圈 15s，静音字幕友好） |
| `copy/horizontal.md` | 横屏长视频文案（B 站 / YouTube，约 3 分钟分镜+旁白） |
| `timeline/*.json` | 文案的结构化形态：分镜/字幕/时长/画布参数——gen-cards 与 compose 的单一输入源 |
| `shotlist.md` | 素材录制与出片手册（镜头↔mock 场景映射、全流程命令、人工镜头清单） |
| `tools/make-demo-clips.js` | 录 6 段手机 UI 素材（对历史检出的 mock server 录屏，零 token） |
| `tools/gen-cards.mjs` | 生成全屏字幕卡与手机区覆盖层（Playwright 截图） |
| `tools/compose.mjs` | ffmpeg 三层合成 + 拼接出竖屏成片 |

## 快速出片

```bash
npm i && cat shotlist.md   # 全流程四条命令在 shotlist.md
```

产物目录（`clips/` `cards/` `render/`）不进 git；成片留存拷去稳定盘位。

## 创作纪律

所有能力主张**只写当前代码里实证存在的功能**，每份文案末尾附「能力核查表」：主张 → 代码证据（源文件 / 测试 spec）。代码里没有的，一个字不写。
