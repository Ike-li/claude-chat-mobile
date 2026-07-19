---
name: promo
description: 根据当前代码产出/更新 claude-chat-mobile 的宣传文案与视频。Use when 用户要写宣传文案、做宣传视频、出片、更新 promo 素材、检查文案是否过时。
---

# promo — 宣传产出流程入口

宣传创作的一切内容与工具都在本仓 **`promo` 孤儿分支**（不在 dev/master）。本 skill 只是指路层，权威流程在分支内的 `PLAYBOOK.md`。

## 步骤

1. 用 worktree 检出 promo 分支（**勿在主树直接 checkout**，防污染 dev 工作区）：
   ```bash
   git worktree add <scratchpad>/promo-wt promo
   ```
2. 读 worktree 里的 `PLAYBOOK.md`，按其流程执行：
   - 写/更新文案 → 流程 A（铁律：文案从代码来、核查表、禁写清单）
   - 出竖屏成片 → 流程 B（`shotlist.md` 四条命令，全自动零 token）
   - 出横屏成片 → 流程 C（ai_video 工作台）
3. 文案/timeline 改动 commit 到 promo 并 push；产物（clips/cards/render）不进 git，成片拷稳定盘位。
4. 完事 `git worktree remove` 清理；验证主树 `git status` 干净。

## 红线（来自机主指令，PLAYBOOK 有全文）

- **文案内容不从记忆来，从代码来**——每条能力主张先在当前代码找到证据再写，并登记核查表。
- 禁写：实时镜像活会话 / 离线可用 / 语音输入 / 拍照直传。
- 宣传物永不进 dev/master。
