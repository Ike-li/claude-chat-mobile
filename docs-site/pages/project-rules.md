# 项目规范
> 分支纪律、门禁、worktree 约定、测试分层。

- **Part**: 第七部分 · 参考与规范
- **Reading Time**: ~10 min
- **Estimated Tokens**: ~1772

---

分支纪律、自动化门禁矩阵、测试执行槽划分与决策留痕约束。遵守这些工程铁律，是维护代码库在重度开发下依然健康稳定的唯一保障。

## 分支纪律与 Worktree 约定

- 日常改动走 feature 分支 → PR → dev ，每个小改动一个 PR； dev 要求 PR 且 CI 必须绿。GitHub 默认分支是 master ，所以开 PR 必须显式 --base dev 。
- master 只接受发版 PR ：由 scripts/release.sh 开 dev → master 的 PR，等真 CI 绿后合并（产生 merge commit），再在合并后的 master HEAD 上打 tag、建 Release。开了 enforce_admins ，谁都不能直推； master 上不得出现未发版的提交，因为装机拉的就是它。
- 分发裁剪 (export-ignore) ：装机的 curl 直接拉 GitHub 对 master 的源码归档，GitHub 现场 git archive 并遵守 .gitattributes ；发版不打包、不上传资产。一条 /tests/** 前缀就裁掉了全部用例、测试基建与门禁，所以 新增的测试与门禁文件只要落在 tests/ 下就自动覆盖 ，不用逐个登记。例外： scripts/doc-consistency.js 与 scripts/collect-source-files.js 被 doctor import，不能移进 tests/ 。
- 常驻 Worktree 物理外置 ：其他分支（如 gh-pages 、 promo 等）常驻于与主仓平级的兄弟目录（如 ../claude-chat-mobile-gh-pages ），物理上不在源码树内，杜绝搜索和工具扫描污染。

## 自动化测试执行槽 (S0–S7) 与防假绿

测试与门禁全部集中于 `tests/` 目录下，分为清晰的八大执行槽（按「安全性依不依赖被测代码正确性」划分，详见 `tests/README.md` 与 `docs/testing.md`）：

| 执行槽 | 定义与内容 | 安全边界与隔离要求 |
| --- | --- | --- |
| S0 静态 | 语法、import 边界、循环依赖、双向事件契约、i18n key、破坏性删除形态、分发裁剪、Swift typecheck | 纯静态扫描，不跑业务代码 |
| S1 决策与真磁盘 | 纯函数 + 一次性目录（mkdtemp）上的真实 fs / git / symlink / FIFO（ tests/unit/ 与 tests/invariants/ 纯逻辑） | 不拉起 app.js 、不 spawn Claude 进程 |
| S2 真 server + 假 CLI | 真实组装根，HTTP + Socket 接线（ tests/integration/ ， CLAUDE_BIN 指向 fake-claude.sh） | 零真实模型回合 |
| S3 真浏览器 + 假后端 | 真实 app/public 前端，内存 Mock Server 仅模拟事件信封（ tests/e2e/ ） | 零外部依赖，无真组装根 |
| S4 薄跨缝 | 真浏览器 → 真 server → 假 CLI（覆盖字段契约分叉） | 零真实模型回合 |
| S5 授权真 Claude | 真 CLI + 真 SDK + 隔离的 CCM_DATA_DIR / HOME （ RUN_CLAUDE_INTEGRATION=1 ） | 需真 Token 与显式授权 |
| S6 变异 | 故意改坏源码再跑 S1（ npm run mutate:docker ） | 强制在 Docker 容器内跑 ，沙箱隔离 HOME |
| S7 Darwin | Swift 逻辑 + 桌面端 bundle 编译校验 | 唯一需在 macOS 宿主机跑的槽（容器无 swiftc） |

> **CRITICAL / DANGER:** 宿主机命令白名单约束 (guard-host-tests) — 宿主机仅允许直接执行白名单内的无害命令（npm run lint、npm run check、npm run test:unit、npm run test:e2e）。任何拉起真实服务或执行卸载器的测试必须进 Docker 容器，物理切断对开发机家目录（~/.claude）造成破坏的可能。

## 代码决策留痕与 Git Commit 规范

会话日志只在本机，commit 跟着仓库走，所以取舍与验证过程写进 commit message 的 trailer，不新增一次性的设计文档（`repo-inventory` 闸也会拦下审计报告、进度笔记这类文件）。两侧验收的证据写在 `Tested:` 里：注入了什么、哪一条红了。下面的 trailer 取自产品仓 `docs/testing.md`：

```
Tested: 注入 `live: 0` 到 app.js:3322 → unread-on-entry 精确红 1 条（"后台累积的未读必须随 ack 带回，实际 0"）
Tested: 容器全链五段 rc=0（unit 3570 / invariants 532 / :server 53 / :env 13 / integration 101）
Not-tested: e2e 未跑——本次零生产代码改动且未触及 tests/e2e/
```

有取舍时再加 `Constraint:`（限制方案选择的外部条件）与 `Rejected:`（否决的方案及原因）。写「已做双向验收」零成本，写不出「注入了什么、哪一条红了」就是没做。
