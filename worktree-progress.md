# Worktree 会话续接 — 进度笔记（2026-07-18）

> WIP 笔记，随时可删。目标：让 web 端能发现并续接「在 git worktree 里创建的会话」（你踩到的 `d7a185a3` 就是这类），并保证「一个分支同一时刻只能一处使用」的互斥。

---

## 起因

手机端会话 `d7a185a3`「找不到、续不了」→ 查明它是 **worktree 会话**：CLI `EnterWorktree` 后把 transcript 挪进 worktree 的 project 目录，而 ccm 只按 `workdirs.json` 白名单列会话 → 看不到。数据没丢，只是不在列举范围。

---

## 已查清的机制（可靠）

1. **worktree 会话怎么产生/消失**：CLI 调 `EnterWorktree` → transcript relocate 到 `encode(worktreePath)` 的 project 目录 → 逐轮写 `worktree-state` 记录（含 `originalCwd / worktreeBranch / worktreePath / enteredExisting`）。
2. **地基已实测**：`workdirs.json` 12 个开发目录，`git branch` / `git worktree list` 都能程序化拿到（9 个 git repo，3 个非 repo 自动跳过）。
3. **关键概念**：有 branch ≠ 有 worktree（codex 4 branch/1 worktree）；**session 绑的是 worktree 目录、不是 branch**。
4. **决策（你拍板的）**：只列「有 worktree 的分支」（活的）。发现主轴 = `git worktree list`；worktree 已删的孤儿留 **Phase 2**。
5. **唯一性/互斥**：`claude agents --json` 是「谁正占着哪个会话」的权威表（`kind=interactive/background` + `status/pid`）；**CLI 本身 refuse resume 一个已占用的 session = 硬锁**；ccm 已用它挡 interactive（`src/ops/cli-bg-session-lock.js`）。web 会话也进表（本会话 `eca81f41`=interactive 为证）→ **双向互斥地基现成**。

---

## 已完成的代码（**已提交 dev：`f5d15b3`**，未 push）

`src/sessions/worktree-sessions.js` + `tests/unit/worktree-sessions.test.mjs`

| 函数 | 作用 | 状态 |
|---|---|---|
| `parseWorktreeList` | 解析 `git worktree list --porcelain` | ✅ 4 测绿 |
| `listRepoWorktrees` | 排除主树、返回 linked worktree | ✅ 2 测绿 |
| `discoverWorktreeSessions` | 按 branch 分组 + 会话 | ✅ 1 测绿 + **真实实证：真 git+SDK 发现了 d7a185a3** |
| `isAllowedWorktreeTarget` | 续接落点 gate（防前端伪造路径） | ⚠️ **有代码、0 测试、未验证** |

测试合计 **7 绿**（gate 未覆盖）。

---

## 唯一性调研的一个未收尾点

想抓「一个 worktree 会话**正被驾驶时**在 `claude agents` 表里的形态」——用 SDK resume `d7a185a3` 的探针**没抓成**：resume 期间它没进表，而 resume 是否成功在污染环境里无法可靠确证，故**不下结论、不编**。**但不影响核心结论**：互斥按 sessionId，你担心的方向（CLI 占用 → web 被挡）证据最硬。

---

## ⚠️ 本会话的环境问题（重要）

工具**读取/输出层严重污染**：文件明明有内容却报「不存在」、甚至凭空捏造出假数据行（这一路拦下过两次差点被误导，如假的 `kind:worktree`）。所以本会话后期实测可靠性打折——**只有经「干净 python 解析 / 二次核实」的才算数**。下次接续务必换新会话。

---

## 待办 · 合并 service-status-panel → dev（**下次新会话做，别在本会话做**）

**目标**：把 `service-status-panel` 分支的服务状态面板功能合进 dev，然后删该分支。

**已核实的事实（2026-07-18）**：
- `662eb6b`（服务状态面板：设置入口三段式 sheet + `service:status` 事件 + 单测/E2E，13 文件 +418 行）**未进 dev**（`git cherry -v dev service-status-panel` = `+`）。
- 分叉点 merge-base = `26d512b`（7/17 11:49）；分叉后 dev 领先 **4 个 commit**：`db25863`(动态状态行) / `4b63e20`(修测试) / `74af6e5` / `f5d15b3`(worktree WIP)。
- `git merge-tree` 预览冲突：**2 处真冲突** `docs/repository-map.md` + `public/js/app.js`；`public/js/logic.js` / `src/server/app.js` / `tests/e2e/mock/server.js` 三个 git 自动合并。

**步骤**：
1. `git checkout dev`（确认工作树干净）
2. `git merge service-status-panel`（或 `git cherry-pick 662eb6b`）
3. 解 2 个冲突：`docs/repository-map.md`（小）、`public/js/app.js`（170KB 大文件，仔细看上下文）
4. `npm run check` + `npm run test:unit` + `npm run test:e2e` 全绿
5. **绿了才删**：`git worktree remove .claude/worktrees/service-status-panel` + `git branch -d service-status-panel`

**注意**：删 worktree 后 `d7a185a3` 会话变孤儿——它的 transcript 在 `~/.claude/projects/-Users-raylee-code-claude-chat-mobile--claude-worktrees-service-status-panel/` **保留不删**，只是 worktree 目录没了。

---

## 待你验证（worktree 续接功能本身）

在终端 `claude` 进一个 worktree 会话 → web 端去打开它 → 看 ccm 是否挡你 / 报「终端驾驶中」。这是唯一性最可靠的真机验证。

---

## 待办（worktree 续接功能，下次接续）

- [ ] gate `isAllowedWorktreeTarget` **补 4 个测试**
- [ ] `worktrees:list` socket 事件 + 契约登记（`scripts/agent-event-contract.js` 双面）
- [ ] 前端 git picker（`public/app.js` 内改、**不拆文件**）：开发目录 → branch(worktree) → session，选中续接
- [ ] 续接路径接上 gate + **唯一性检查**（复用 `cli-bg-session-lock` 的 interactive lock）
- [ ] 收口：`npm run check` + `test:unit` + `test:e2e` 全绿 + `inventory:update`
- [ ] Phase 2（可选）：孤儿 worktree 会话（worktree 已删 → 落 `originalCwd`）

---

## 状态清单

- 已提交 dev：`f5d15b3`（worktree-sessions.js + test + 本文件）；`dev` 本地领先 origin 188、未 push。
- 分支：`dev` / `master`（未动）/ `service-status-panel`（保留，待新会话合并）。
- 生产 server：未动、未重启。
