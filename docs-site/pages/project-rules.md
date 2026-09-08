# 项目规范
> 分支纪律、门禁、worktree 约定、测试分层。

- **Part**: 第七部分 · 参考与规范
- **Reading Time**: ~10 min
- **Estimated Tokens**: ~1454

---

分支纪律、自动化门禁矩阵、测试执行槽划分与决策留痕约束。遵守这些工程铁律，是维护代码库在重度开发下依然健康稳定的唯一保障。

## 分支纪律与 Worktree 约定

- 日常开发严格在 dev 分支 ：严禁直接在 master 上提交改动。 master 为发布保护分支，仅在发版时通过 scripts/release.sh 由 dev 执行 fast-forward 合并。
- 分发裁剪 (Export-Ignore) ：发版会自动通过 git archive 打出纯净安装包。所有新增的测试、门禁脚本必须同步登记至 .gitattributes 的 export-ignore ，防止测试代码混入轻量安装包。
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

根据工作宪法，开发会话会定期清理，而 Git 历史永久留存。重要架构取舍直接记录在 Commit Message 的 Trailer 中，不新增多余的设计文档：

```
feat(auth): 引入 IPv6 /64 分桶聚合限速机制

对同一 /64 子网的入向请求聚合至单桶，防御动态轮换 IPv6 绕过策略。

Constraint: 不引入外部 Redis，完全基于进程内 LRU Map 实现
Rejected: 按单一完整 IPv6 限速（极易被攻击者动态前缀绕过）
Tested: tests/unit/auth-rate-limit.test.mjs 注入单 IP 测试变红，/64 聚类通过
Not-tested: 超过 10 万并发连接下的内存极限水线
```
