# claude-chat-mobile 全仓代码 BUG 审计报告

## 1. 文档控制

| 项目 | 值 |
| --- | --- |
| 审计日期 | 2026-07-13 |
| 审计快照 | `dev@a253e00a4d7492da57b40b9f4622e92ab2e1b2fe` |
| 审计模式 | 代码审查为只读、全仓、scan-only；执行过有状态测试，但未修复业务代码，未提交或推送 |
| 代码覆盖 | 168/168 个一方代码、测试、脚本和配置文件；38,099/38,099 行；0 跳过 |
| 非代码排除 | 64 项：文档 27、静态/二进制资产 23、第三方 vendor 12、lockfile 1、空发布标记 1 |
| 裁决流程 | Recon -> Hunter -> Skeptic -> Referee |
| 采信标准 | 具备可达触发链，Referee 独立回读代码，置信度不低于 85 |
| 最低置信度 | 92；47/47 条候选均为 `INDEPENDENTLY_VERIFIED` |
| 最终状态 | `FINAL` |

本报告中的“确认 BUG”指当前快照下存在“具体输入或状态 -> 可达代码路径 -> 错误行为”的缺陷。测试、CI、部署模板或已披露架构边界不会冒充产品运行时 BUG，但其代码现象和工程风险仍单独登记。

## 2. 执行摘要

Hunter 共提出 47 条候选。Skeptic 与 Referee 最终裁定 34 条 `REAL_BUG`、13 条 `NOT_A_BUG`、0 条 `MANUAL_REVIEW`。`WS-006` 是 `BE-002` 的离线超长消息表现，两者属于同一条端到端假成功丢消息根因，因此严格去重后的确认 BUG 为 33 条。

| 范围 | High | Medium | Low | 合计 |
| --- | ---: | ---: | ---: | ---: |
| 产品运行时 | 3 | 10 | 7 | 20 |
| 运维、发布、smoke 和视觉测试脚本 | 3 | 7 | 2 | 12 |
| 测试进程隔离 | 0 | 1 | 0 | 1 |
| **严格去重合计** | **6** | **18** | **9** | **33** |

没有确认 Critical。最优先处理的风险是：显式旧实例 ID 被改投到其他会话、消息未入队却返回成功、终端外部轮次被吞入 catch-up baseline 后产生 transcript 分叉、smoke 脚本可能覆盖生产状态、测试可能连到错误进程，以及发布脚本可能留下不可重跑恢复的部分发布。

安全相关结论中，`BE-011` 是唯一确认的 security 类运行时缺陷，需已认证操作者且利用条件较苛刻。Quick Tunnel 绕过设备 TOFU 的代码行为真实，但部署文档已经把它定义为仅依赖 `AUTH_TOKEN` 的已知边界，因此 `BE-004` 未判为 BUG。

## 3. 审计方法与覆盖

### 3.1 审计方法

1. Recon 建立架构、信任边界和高风险调用链，优先覆盖 Socket 鉴权、实例路由、历史追平、Claude SDK 生命周期、设备审批、文件边界和前端异步状态机。
2. Hunter 分成后端、Web/脚本、测试/配置三个域逐文件逐行阅读，并为每条候选记录文件哈希、行号、触发条件和跨文件调用链。
3. Skeptic 对候选逐条尝试反证，排除仅属文档、配置、测试覆盖或没有当前错误行为的项目。
4. Referee 对 47 条候选全部按 Tier 1 处理，亲自回读源代码并重新构造触发链；没有使用只比较文字证据的 Tier 2 裁决。
5. 对高影响路径使用隔离 server、临时数据目录和 fake Claude CLI 复现，不连接生产数据，不消耗真实 Claude turn。另行执行的既有测试命令并非全部无状态，其隔离缺陷已在第 7 节登记。

### 3.2 覆盖总账

| 分区 | 文件 | 行数 | Hunter 候选 | 覆盖状态 |
| --- | ---: | ---: | ---: | --- |
| 后端运行时 | 26 | 6,095 | 18 | 26/26 完整 |
| Web 与脚本 | 50 | 16,347 | 20 | 50/50 完整 |
| 测试与配置 | 92 | 15,657 | 9 | 92/92 完整 |
| **合计** | **168** | **38,099** | **47** | **168/168，0 跳过** |

逐文件路径、物理行数、SHA-256、阅读区间和 finding 双向引用位于 `.bug-hunter/coverage-all.json`。恢复审计工具临时加入的 `.gitignore` 规则后，冻结快照的 168 个文件哈希和行数与该总账全部一致。正式报告 QA 期间，另一个并发 Claude 会话随后修改了 `statusline.js` 和 `test/statusline.test.mjs`；这些快照之后的改动没有被混入本轮覆盖或裁决。文档在判断产品契约时按需阅读，例如 `docs/deployment.md` 用于裁决 `BE-004`，但纯文档行数没有冒充代码覆盖。

## 4. 确认的产品运行时 BUG

### 4.1 High

#### BE-001：显式旧实例 ID 被静默改投到当前实例

- 位置：`server.js:284-286`；影响 `user:message`、审批、effort、回答、中断、preview 和 sync 等入口。
- 触发：客户端为已经关闭的 `inst_old` 发送或重试事件，同时服务端当前查看实例已经切到 `inst_live`。
- 预期：显式且不存在的 ID 应 fail closed，返回 stale/unknown instance。
- 实际：`resolveInstanceId` 把“未提供 ID”和“显式旧 ID”都回退到 `viewingInstanceId`，消息或控制操作落到另一段会话。
- 实证：隔离复现中向已关闭的 `inst_1` 发消息，ACK 与 `user_message` 事件都显示目标被改成 `inst_3`。
- 修复方向：只允许缺省 ID 使用兼容回退；非空但未知的 ID 必须负 ACK，所有变更型 handler 共用同一 fail-closed 解析器。

#### BE-002 + WS-006：未发送消息收到成功 ACK，并被去重永久丢弃

- 位置：`server.js:1507-1514,1577-1590`、`agent.js:246-286`、`public/js/app.js:400-431,1849-1903`。
- 触发 A：队列已有两个 pending turn，第三条消息到达；`AgentSession.send()` 返回 `false`。
- 触发 B：离线输入超过 50,000 字符。客户端先入离线队列，首次重连被长度校验拒绝，第二次重连命中已登记的 `clientMessageId`。
- 预期：只有验证、附件落盘和成功入队后才能提交去重 ID；失败必须保持可辨识的失败状态。
- 实际：服务端在验证和入队前登记 ID，忽略 `send(false)`，并可无条件返回成功；失败后的同 ID 重试收到 `{ok:true,deduped:true}`。客户端随即删除 pending，消息从未进入 Claude 队列。
- 实证：隔离复现中，队列满时第三条未入队却得到 `{ok:true}`；同 ID 重试得到 `{ok:true,deduped:true}`。`WS-006` 原称“永久重试”不准确，当前真实行为是第二次重连假成功丢消息。
- 修复方向：拆分 dedup 查询与提交；仅在 `send() === true` 后提交 ID；永久校验失败与可重试传输失败使用不同 ACK；客户端在离线入队前执行相同长度/附件校验。

#### BE-009：重连重置 catch-up baseline，可让终端外部轮次形成 transcript 分叉

- 位置：`server.js:933-977,1437-1441,1559-1573`、`history.js`。
- 触发：终端在上一次 catch-up tick 后写入完整轮次，随后任意 socket 在下一 tick 前连接。
- 预期：未见过的磁盘增长应触发 `externalDirty`，下一次手机发送前替换陈旧 SDK session。
- 实际：连接无条件清空 catch-up key；下一 tick 直接以已增长的全量历史建立新 baseline 并返回，不发事件也不设置 `externalDirty`。后续手机消息继续使用旧内存上下文并写出分叉链。
- 修复方向：客户端重连不得重置服务端历史 baseline；如必须重建，要比较旧 transcript 身份/长度并把被吸收的外部增长标记到对应 AgentSession。

### 4.2 Medium

| ID | 位置 | 触发与错误行为 | 修复方向 |
| --- | --- | --- | --- |
| BE-003 | `agent.js:355-412,560-568` | 无人处理审批时没有到期 timer；过期只在后来有人提交决定时结算，idle supervisor 又因 pending permission 持续刷新活动时间，SDK Promise 可永久悬置。 | 为每个审批设置可清理的到期 timer；到期删除 Map 项、记录 expired、发 resolved 事件并 fail closed。 |
| BE-007 | `server.js:1220-1229`、`notifications.js:9-20` | 唯一在线 socket 是待审批设备时，它看不到 result，却被计入 `hasClients`，同时抑制 Web Push 与 ntfy。 | 以 approved room 的在线人数判断结果是否已有人可见。 |
| BE-008 | `server.js:1672-1710`、`agent.js:580-617` | 纯后台任务运行时 `pendingTurns` 可为 0；effort 切换只检查该字段，然后 dispose session，实际终止后台任务。 | effort 切换同时检查后台任务、审批和问题状态；完全 idle 前不得 dispose。 |
| BE-011 | `devices.js:44-50,80-84,135-145` | 设备吊销落盘失败被吞掉，UI/审计仍报告成功；下次信任检查从旧磁盘重新加载，被吊销设备立刻恢复授权。 | 持久化必须返回结果或抛错；仅在原子写成功后提交吊销，失败时明确回滚并告知操作者。 |
| BE-016 | `server.js:1262-1278,1375-1391` | 查看实例退出后只更新 `viewingInstanceId`，不更新 `viewingCwd`；替代实例再关闭时，空视图和默认路由跳回更早的旧工作区。 | 用单一 helper 原子更新 ID 与 cwd；关闭最后实例时保留最后实际查看的 cwd。 |
| BE-018 | `server.js:2184-2194` | server 已监听但 preheat 尚未完成时，客户端收到空实例快照；preheat 后注册旧实例却不广播，首条消息可被路由到 UI 看不见的旧 tab。 | preheat 选定实例后立即广播完整 snapshot；首发路由与 in-flight preheat 做同步屏障。 |
| WS-001 | `public/js/app.js:3661-3675` | 会话 A 的 history ACK 在切到 B 后到达，直接把 A 历史追加进 B DOM，并可能移除 B 的 loading card。 | 请求时捕获 view generation/实例/会话，回调不再匹配时丢弃。 |
| WS-002 | `public/js/app.js:454-475` | A 的迟到 sync ACK 在当前 B 上执行 reload 或 pending snapshot，清空 B 或展示 A 的审批/问题卡。 | 给 sync ACK 加目标/代次守卫，并让 helper 使用捕获的目标而非全局当前视图。 |
| WS-003 | `public/js/app.js:4129-4149,4214-4218` | `/push/subscribe` 非 2xx 或 PushManager 异常被 `doSubscribe` 吞掉，点击处理器仍显示订阅成功。 | 失败时返回明确状态或抛错；只有服务端确认保存后显示成功。 |
| WS-019 | `public/js/app.js:4264-4290` | 日志 A 的迟到回包在切到 B 后清空共享日志区并覆盖 B 内容。 | 给日志请求增加 generation 与目标实例校验，抽屉关闭或目标变化时丢弃旧回包。 |

`WS-001`、`WS-002`、`WS-019` 共享“异步 ACK 未绑定 view generation”的修复模式，但位于三个独立入口、产生三种独立错误行为，因此保留三个 BUG ID，并作为同一修复簇实施。

### 4.3 Low

| ID | 位置 | 触发与错误行为 | 修复方向 |
| --- | --- | --- | --- |
| BE-012 | `sessions.js:49-80`，同模式见 `approval-store.js`、`audit.js` | debounce 异步保存没有串行化；旧快照可能比新快照更晚 rename，甚至覆盖 shutdown 同步 flush。 | 使用单写者 Promise 链或带版本队列；shutdown 必须 fence 所有旧 writer。 |
| BE-013 | `doctor-runtime.js:44`、`server.js:1970-1981` | UI doctor 的生产调用从不传 `configPermsProblems`，函数却把缺失值解释为 0，任何真实权限都显示 0600 安全。 | 实际执行权限检查并传入问题数；无法检查时显示 unknown/warn，不能显示 ok。 |
| BE-014 | `server.js:430-435` | truthy 非字符串 push endpoint 先被持久化，再在 `.slice()` 抛错返回 500；畸形订阅持续污染后续推送。 | 变更状态前结构化校验 endpoint 和 keys，非法输入返回 400。 |
| BE-015 | `server.js:160-168` | `fetch` 对 ntfy 4xx/5xx 正常 resolve，代码不检查 `Response.ok`，投递失败被静默当成功。 | 检查状态码，记录脱敏失败和 metric，仅对可重试状态重试。 |
| WS-004 | `public/js/app.js:4112-4124` | 后台实例 B 的完成通知在实例判断前隐藏当前 A 的任务进度横幅。 | 只在事件实例等于当前实例时隐藏，或按实例保存进度状态。 |
| WS-005 | `public/js/app.js:3538-3566` | 切会话未清 activity/API retry 横幅，A 的状态残留到空闲 B。 | `clearView` 同步清理所有 per-view transient banner。 |
| WS-007 | `public/js/app.js:68-90,1807-1823` | 合法自定义模型名含引号、反斜杠或方括号时，被直接插入 CSS selector/HTML，`querySelector` 可抛 DOMException 并留下半更新 UI。 | 用 DOM API、`dataset`、`textContent` 构造；保留 selector 时使用 `CSS.escape`。 |

## 5. 确认的运维与测试脚本 BUG

这些缺陷不代表部署后的聊天运行时一定错误，但会让发布、诊断、smoke 或视觉回归得到错误结论，部分还会修改生产状态。

| ID | 级别 | 位置 | 具体错误行为 | 修复方向 |
| --- | --- | --- | --- | --- |
| WS-010 | High | `scripts/visual-e2e-runner.js:18-48` | 固定 3100 端口启动后只 sleep；子进程因端口占用退出时，runner 可连接已有服务并执行会话、审批和中断操作。 | 使用临时端口、child exit/error 监听和 nonce-bearing readiness。 |
| WS-012 | High | `scripts/release.sh:117-130` | 依次 push master、tag、dev，再建 GitHub Release；中途失败留下远端部分发布，重跑又会被空 diff 或既有 tag 阻断。 | 本地准备完成后用 `git push --atomic`；GitHub Release 作为幂等 reconciliation。 |
| WS-017 | High | `scripts/smoke-concurrent.js:55-80,202-230`、`smoke-multirepo.js`、`smoke-stage3-concurrent.js`、`smoke-apierror.js` | 四个 smoke 无锁重命名真实 `sessions.json`/`init-cache.json`，且未等子进程退出就恢复；子进程退出 flush 可再次覆盖刚恢复的生产文件。 | 全部状态路径指向独占临时 `CCM_DATA_DIR`；过渡期加锁、唯一备份并等待 child confirmed exit。 |
| WS-008 | Medium | `scripts/visual-e2e-runner.js:944-984`、visual mock | TC-11 计算停止按钮状态却不断言；mock 收到 interrupt 后仍继续约 16 秒发 delta/result，回归可假绿并污染后续 case。 | mock 为每实例维护 abort token；断言停止按钮、终止状态及 interrupt 后无新 delta。 |
| WS-009 | Medium | `scripts/visual-mock-server.js:1486-1517` | 延迟场景在 `await` 后读取全局 `viewingInstanceId`；中途切 tab 会把 A 的后续事件标成 B。 | dispatch 时冻结 active instance/session/cwd，全场景只使用该目标。 |
| WS-011 | Medium | `scripts/doctor.js:176-237,290-299` | `--env` 只影响 dotenv 加载，ANTHROPIC 与权限检查仍看仓库 `.env/data`，可对指定 prod 配置给出假绿。 | 统一解析 effective config paths，加载、检查和 `--fix` 全部使用同一上下文。 |
| WS-014 | Medium | `scripts/test-entrypoint-fix.js:35-43` | init 的 `sessionId` 在 envelope 顶层，脚本却检查 `payload.sessionId`，健康服务也必然超时。 | 检查顶层字段，并在 resolve/reject 时清理 listener 与 timeout。 |
| WS-015 | Medium | `scripts/smoke.js:77-78` | epoch 断言先过滤掉缺 epoch 的事件；所有业务事件都丢 epoch 时，空数组 `.every()` 仍通过。 | 先独立选出应有业务事件，断言非空，再要求每条都有合法 epoch。 |
| WS-016 | Medium | `scripts/smoke-permmode-plan-e2e.js:81-106` | 审批缺少完整性契约要求的 `op`（也未绑定 `instanceId`），因此所有 allow 都会变成 integrity mismatch deny；同时错误自动允许 ExitPlanMode，文件未创建不能证明 plan 有效。 | 回显完整 op，单独处理 ExitPlanMode，并断言 SDK mode transition 与 tool outcome。 |
| WS-020 | Medium | `scripts/smoke-m3.js:63-85` | result 在断网前已快速完成时仍要求重连后再收到同一 result；cutSeq 已越过它，测试会等 180 秒后误报失败。 | 按 `hadResultBeforeCut` 分支；未完成路径使用确定性延迟 fixture。 |
| WS-013 | Low | `scripts/manual-test-entrypoint.js:13-77` | 直接向真实 `~/.claude/projects` 写假 session，清理只在完整成功路径；异常或 SIGINT 永久留下历史污染。 | 使用临时 Claude home；至少用 `try/finally` 和 signal handler 精确清理唯一 fixture。 |
| WS-018 | Low | `scripts/test-p1.js:35-42` | E7 向不存在的 `requestId` 发 answer，不观察 ACK/状态便无条件计为通过。 | 创建真实 pending question，使用实际 ID，并断言 resolved event 和最终答案。 |

## 6. 确认的测试进程隔离 BUG

### TC-008（Medium）：本地测试可验证错误 checkout 或向错误进程发有状态事件

- 位置：`playwright.config.ts:3-4,26-30`、`tests/seed.goto-mock.spec.ts:21-28`、`test/integration/server.test.mjs:12-44,61-290`。
- Playwright 在非 CI 设置 `reuseExistingServer=true`，仅凭固定 baseURL 可达就复用；`/__reset` 的状态和服务身份没有验证。
- server integration 固定使用 3199，spawn 后不监听 early exit，只要端口上的任意兼容 `/health` 返回 `status:ok` 就宣告就绪。
- 结果：旧 checkout 或其他 CCM 监听端口时，测试可能假绿、假红，或向非本轮服务发送状态变更事件。
- 修复方向：启动时生成 nonce/build identity，readiness、reset 和后续请求必须回显同一身份；确认 child PID/nonce 属于本轮并默认关闭盲目跨 checkout 复用。

## 7. 已验证但不计入产品运行时 BUG 的工程风险

以下 8 项代码现象均经 Referee 回读确认，但按审计契约属于测试、CI 或配置治理，不满足“部署产品运行时 BUG”的分类。风险等级是工程处置优先级，不是 Referee 的产品严重度。

| ID | 工程风险 | 结论 |
| --- | --- | --- |
| TC-001 | High | `test/devices.test.mjs` 直接重命名真实 trusted/pending device 文件，未设置临时 `CCM_DATA_DIR`；中断可留下替换状态，并触发生产 watcher。 |
| TC-002 | Medium | `test/cf-access.test.mjs` 把真实 JWKS cache 换成测试 key，恢复依赖 after hook；中断或窗口内重启可让 Access 读到空/测试缓存。 |
| TC-003 | High | GitHub Actions 不运行 100 个 integration case，也不运行 108 个 Playwright P0 case；PR 可在鉴权、上传、P0 契约未执行时全绿。 |
| TC-004 | Medium | 三个 opt-in 真实 Claude 套件在首消息前等待 init，与当前 lazy-start 协议相反；重复 import ESM 单例也不能实现所称 server restart。 |
| TC-005 | Medium | 默认本地 `npm test` 的 upload case 可发真实 Claude turn，并吞掉 result 超时/错误后继续通过，既可能耗 token 又会假绿。 |
| TC-006 | Medium | 单个 Playwright case 第二次 `gotoMock` 会改指向新的错误数组，第一阶段 pageerror/console.error 变得不可达。 |
| TC-007 | Medium | test healer 被配置为在“测试正确但失败持续”时自动写 `test.fixme()`，可把产品回归变成绿色结果。 |
| TC-009 | Low | LaunchAgent 模板用 sed 和未引用的 `zsh -lc` 拼接路径；空格、`&`、`#`、引号或 XML 元字符会破坏安装。 |

## 8. 驳回项

| ID | 裁决 | 依据 |
| --- | --- | --- |
| BE-004 | `NOT_A_BUG` | 反代落到 localhost 后跳过 TOFU 的行为真实；`docs/deployment.md` 已明确 Quick Tunnel 仅依赖 `AUTH_TOKEN`，属于披露过的部署边界。文档之间仍建议统一表述。 |
| BE-005 | `NOT_A_BUG` | 直接客户端可伪造 `CF-Connecting-IP` 建新 limiter bucket，但本审计把纯限速问题列为 hard exclusion；Map 增长也没有服务失效阈值或放大证据。 |
| BE-006 | `NOT_A_BUG` | HTTP `AUTH_TOKEN` 端点确实没有 Socket.IO 同类限速，但属于同一纯限速加固项。 |
| BE-010 | `NOT_A_BUG` | thumbnail 未服务端限型/限长，但触发需要已批准完整操作者持续提交与内存成比例的大输入；没有放大或实测失效阈值。 |
| BE-017 | `NOT_A_BUG` | 合成 init 可带其他 workspace 的 `mcpServers/skillsCount`，但当前浏览器完全不消费这两个字段，没有当前错误行为。 |

测试/配置域另外 8 条 `NOT_A_BUG` 已在第 7 节以工程风险保留，没有从报告中隐藏。

## 9. 动态验证证据

以下结果是本次审计会话中的实际观察。早期命令 stdout/stderr 和两个临时复现脚本没有保存在最终工作区，因此精确计数、端口与实例 ID属于“会话内观察证据”，不能仅靠当前仓库产物独立重放；静态 coverage、Hunter、Skeptic 和 Referee JSON 则可完整追溯。后续审计应把命令、环境变量和原始输出一并保存到隔离产物目录。

| 验证 | 结果 | 解释 |
| --- | --- | --- |
| `npm run check` | 通过 | 根级与前端语法、文档一致性、visual mock registry guard 均通过。 |
| `npm run contract:check` | 通过 | 当前事件契约静态检查通过。 |
| `npm run test:unit` | 853：850 pass、3 skip、0 fail | 单元入口为绿，但并非完全无状态：`TC-001` 已确认其中的 devices suite 会操作仓库 `data/`；也不覆盖真实 Claude 生命周期。 |
| `npm test` | 926：923 pass、3 skip、0 fail | 默认可靠集成为绿，但 `TC-005` 说明其中一个 upload case 仍有真实 turn/假绿边界。 |
| `npm run test:visual` | TC-1 至 TC-22 全通过 | `WS-008` 证明 TC-11 缺关键断言，因此“全通过”不能证明中断契约正确。 |
| `npm run test:playwright:p0` | 108：106 pass、2 fail | 两处失败位于 `tests/p0/task-progress.spec.ts:55,100`，仍断言旧的只读横幅文案；归类为测试契约漂移，不计两个产品 BUG。 |
| `RUN_CLAUDE_INTEGRATION=1` 的 integration 子集（精确 invocation 未留存） | 100：79 pass、21 fail | 多数失败在首发前等待 `init`，与当前 lazy creation 协议漂移；100 是 integration case 口径，不能把它标成同时包含 unit 的完整 `npm test` 总计，也不能把 21 个失败机械地算成 21 个产品 BUG。 |
| BE-001 隔离复现 | 坐实 | 发给关闭实例的消息被改投 live 实例；ACK 与事件目标一致显示错误实例。 |
| BE-002 隔离复现 | 坐实 | 队列满时未入队却 ACK 成功；同 ID 重试再获 dedup 成功。 |

两项隔离复现使用 `127.0.0.1:33991`、临时数据目录和 fake Claude CLI，没有调用真实 Claude。复现服务已停止。

最终隔离复核时，生产 LaunchAgent 仍为 `PID 857`、`runs = 20`，审计没有重启它。`approval-requests.json`、`audit-records.json`、`cf-access-certs.json`、`pending-devices.json` 和 `trusted-devices.json` 等安全状态文件在清理前后 hash 不变；`sessions.json` 与 `init-cache.json` 在另一个真实 Claude 会话活跃期间发生了正常形态的动态更新。该时间相关性不足以单独证明写入来源，因此本轮没有覆盖或回滚这两个生产动态文件。

本节的门禁结果在审计快照和正式报告初稿上取得；第 3.2 节所述并发会话之后产生的 `statusline.js` / `test/statusline.test.mjs` 改动未被这些结果覆盖，也没有在其 TDD 中间态重复运行门禁。

## 10. 修复优先级

### P0：先保护数据和目标归属

1. `BE-001`：所有显式 stale instance ID fail closed。
2. `BE-002 + WS-006`：去重提交改到成功入队之后；前端离线入队前统一验证。
3. `BE-009`：修复 catch-up baseline 与 `externalDirty` 的跨重连一致性。
4. `WS-017`：所有自起 server 的脚本改用独占临时数据根，禁止再重命名生产状态。
5. `WS-010 + TC-008`：所有测试服务引入临时端口、child ownership 和 nonce/build identity。
6. `WS-012`：远端 refs 使用原子 push，GitHub Release 改成可重跑的幂等步骤。

### P1：修复跨会话异步状态机和生命周期

- 将 `WS-001`、`WS-002`、`WS-019` 作为一个 view-generation 修复簇，用同一代次守卫覆盖 history、sync 和 logs。
- 修复 `BE-003` 审批到期、`BE-008` 后台任务 effort 切换、`BE-016` view 坐标原子更新和 `BE-018` preheat 竞态。
- 修复 `BE-007` 通知可见性、`BE-011` 吊销持久化，以及 `WS-003` 推送订阅假成功。
- 修复 visual mock 与 smoke 的假绿/假失败：`WS-008/009/014/015/016/018/020`。

### P2：诊断、持久化和 UI 边角

- 串行化 `BE-012` 的异步持久化 writer。
- 统一 UI doctor 与 CLI doctor 的实际配置上下文：`BE-013`、`WS-011`。
- 完整校验 push subscription、检查 ntfy HTTP 状态：`BE-014`、`BE-015`。
- 清理 per-view banner 和自定义模型 DOM 构造：`WS-004`、`WS-005`、`WS-007`。
- 逐项处理第 7 节测试/CI 工程风险，恢复门禁可信度。

修复阶段应遵循仓库 TDD 规则：先为每个可达触发写失败测试，再做最小改动；涉及 `server.js` 与 `public/js/app.js` 的跨层协议修复必须同时覆盖 sender、receiver、重连和 stale callback。

## 11. 限制与剩余风险

- 本轮是行为 BUG 审计，不是依赖 CVE 扫描，也没有单独生成 STRIDE threat model；不能据此宣称供应链或全部安全风险清零。
- 33 条确认 BUG 尚未修复，相关风险仍存在于审计快照。
- 动态复现集中在最高数据完整性风险；其余 31 条由 Referee 独立回读和完整触发链确认，但没有全部在真实 Claude 环境逐条执行。
- 真实 Claude integration lane 当前有明显协议漂移和环境不稳定性，修复测试基础设施前不能把该 lane 当作可靠发布门禁。
- 报告 QA 期间出现的并发 `statusline.js` / `test/statusline.test.mjs` 修改晚于冻结快照，必须在其所属任务完成后单独验证和 review。
- 逐文件逐行覆盖证明本轮没有漏读排队文件，不等同于数学证明仓库不存在其他 BUG。

## 12. 产物索引

| 产物 | 路径 |
| --- | --- |
| 正式报告 | `docs/code-audit-2026-07-13.md` |
| 严格去重机器总账 | `.bug-hunter/findings.json` |
| 47 条原始候选 | `.bug-hunter/payloads/all-findings.json` |
| 47 条 Referee 裁决 | `.bug-hunter/referee.json` |
| Bug Hunter 原始人类报告 | `.bug-hunter/report.md` |
| 全覆盖总账 | `.bug-hunter/coverage-all.json` |
| 后端裁决 | `.bug-hunter/referee-backend.json` |
| Web/脚本裁决 | `.bug-hunter/referee-web-scripts.json` |
| 测试/配置裁决 | `.bug-hunter/referee-tests-configs.json` |

原始人类报告按 Referee 观察统计为 34 条 `REAL_BUG`；正式报告和 `findings.json` 对 `BE-002 + WS-006` 做严格根因去重后统计为 33 条。两种数字口径均已明确保留。
