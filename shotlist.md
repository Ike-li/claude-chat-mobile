# shotlist — 素材录制与出片手册

## 出片全流程（竖屏静音字幕版，全自动）

```bash
# 0) 一次性：本分支装依赖（Playwright Chromium）
npm i

# 1) 起拍摄 rig：demo:* mock 场景已从 dev 拆除，须检出历史（ae0e722^ = 拆除前最后一个 commit）
git -C /path/to/claude-chat-mobile worktree add --detach /tmp/ccm-shoot 'ae0e722^'
(cd /tmp/ccm-shoot && npm ci)

# 2) 录 6 段手机 UI 素材（mock server 零 token，1124×2436@30fps）
CCM_REPO_DIR=/tmp/ccm-shoot node tools/make-demo-clips.js        # → clips/*.mp4 + clips.json

# 3) 生成静态图层（全屏字幕卡 + 手机区覆盖层）
node tools/gen-cards.mjs --timeline timeline/vertical-30s.json   # → cards/vertical-30s/
node tools/gen-cards.mjs --timeline timeline/vertical-15s.json   # → cards/vertical-15s/

# 4) 合成成片
node tools/compose.mjs --timeline timeline/vertical-30s.json     # → render/vertical-30s.mp4（抖音）
node tools/compose.mjs --timeline timeline/vertical-15s.json     # → render/vertical-15s.mp4（朋友圈）

# 5) 收拾拍摄 rig
git -C /path/to/claude-chat-mobile worktree remove /tmp/ccm-shoot
```

> 试跑管线不想先录素材：`CCM_PLACEHOLDER=1 node tools/compose.mjs --timeline …`（缺失 clip 用灰底占位）。
> 产物目录 clips/ cards/ render/ 均被 .gitignore 排除；**成片留存请拷去稳定盘位**（如 ~/code/ai_video/projects/），别留在临时 worktree 里。

## 镜头 ↔ mock 场景映射（make-demo-clips.js 录制的 6 段）

| clip | mock 命令 | 内容 | 用在 |
|---|---|---|---|
| `stream` | `demo:stream` | 中文流式回答（Markdown 渲染全程） | 横屏 what/stream 幕 |
| `tools` | `demo:tool` | 修 bug 流程：流式 + 工具卡片展开 | 竖屏 process 镜 · 横屏 tools 幕 |
| `approval` | `demo:permission` | 定格待审批弹窗（HERO 镜头，不点允许） | 竖屏 approval 镜 · 横屏 hook/approval 幕 |
| `question` | `demo:question` | 定格 AskUserQuestion 选择题 | 横屏 question 幕 |
| `tabs` | `demo:tab` | 会话抽屉展开，两个工作区并行状态 | 竖屏 tabs 镜 · 横屏 details/cta 幕 |
| `statusline` | `demo:statusline` | CLI 密集态状态行展开（token/花费/上下文） | 横屏 security 幕垫底画面 |

## 人工镜头（自动管线不覆盖，需要时实拍）

- **锁屏推送实拍**（竖屏 hook 的理想画面）：真机配好 Web Push 后锁屏录制推送横幅弹出。
- **手机+终端分屏**（竖屏 resume 镜的完整版）：手机聊天与电脑终端 `/resume` 同框；当前 timeline 用字幕卡替代。
- **口播 / BGM / 横屏 3 分钟成片**：横屏线走 ai_video 工作台（make-tts.mjs 吃 `timeline/horizontal.json` 的 narration 数组；BGM 用 make-bgm.mjs 程序化生成，零版权）。

## 参数备忘

- 画布 1080×1920@30fps；手机区 690×1494 @ (195,230)——由 timeline JSON 单一来源，gen-cards 与 compose 共读，改尺寸只改 timeline。
- 录屏源 1124×2436（375×812 视口 ×3 DSF，缩偶数），合成时 scale 进手机区。
- ffmpeg 8.x：lavfi 无限源必须显式 `-t`，否则无限编码撑爆文件（compose.mjs 已内建，勿删该参数）。
