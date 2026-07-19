# promo 分支 — 宣传创作区

你现在在 claude-chat-mobile 的 **promo 孤儿分支**工作树里：这里是宣传素材创作区（文案 / 分镜 / 出片管线），与 `master`/`dev` 开发线零共同历史。**产品代码不在这里**——事实核查去主仓 dev 分支。

## 先读什么

**`PLAYBOOK.md` 是权威流程**（从代码到文案到视频的全流程），任何宣传产出任务先读它再动手。README.md 有目录索引。

## 三条铁律（全文见 PLAYBOOK）

1. **文案从代码来**：能力主张只写主仓当前代码实证存在的功能，先找证据后下笔，登记进文案末尾的核查表。
2. **禁写**：实时镜像活会话画面 / 离线可用 / 语音输入 / 拍照直传（代码不支持）。
3. **宣传物永不进 dev/master**：文案与工具只 commit 到本分支；产物（clips/ cards/ render/，已被 .gitignore 排除）不进任何 git，成片拷去稳定盘位留存。

## 操作纪律

- 本分支一律用 `git worktree` 检出编辑（勿在主仓主树直接 checkout，防污染 dev 工作区）。
- 出片流程与命令见 `shotlist.md`；拍摄 rig 是主仓历史检出（指针见 PLAYBOOK「维护点」）。
- `.claude/skills/promo/SKILL.md` 是 `/promo` skill 的**入库源**；主仓本机的激活副本丢失时执行：
  `cp .claude/skills/promo/SKILL.md <主仓>/.claude/skills/promo/SKILL.md`
