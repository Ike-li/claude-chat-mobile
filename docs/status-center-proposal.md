# 应用状态 — 完整可执行方案（业界研究后重构版）

> **状态**：方案 / 待机主定夺 2 处冲突。历经：需求澄清 → 做减法 → design.md 对照 → 3-agent 代码验证 → 业界设计研究（见 `status-center-design-research.md`）后**重构主次**。**未改任何产品代码**。
> **并发协调**：`server.js`/`notifications.js`/`doctor-runtime.js`/`metrics.js` 正被其他会话修改，实施前 `git` 对齐。
> **⚠️ 续接必读**：本仓库环境**污染工具输出（含 `readFileSync` 与"写入成功"回执）**。动手前读 §12 方法论 + 文件大小基准表；验证写入用 **Read 工具查第 1 行标题**（bash/node 的 boolean 与"success"会说谎）。

---

## 1. 定位与目标（研究后更新）

ccm 的本质是**终端映射**：「手机上完全平替坐在电脑前用 claude code」。

**核心设计哲学（业界研究后确立）**：不做"陈列式状态页"，而做**一瞥即知的状态原语**——像 macOS menu bar 图标 / `systemctl` 圆点 / Uptime Kuma "All Systems Operational" 色带那样：**正常时一个安静的确认，异常时凸显 + 一键直达处理**。列表是钻取进去才看的详情，不是主体。

北极星：**用户在外面，能像"瞥一眼电脑屏幕"那样一瞬间知道「一切正常 / 有事找我」，有事时一步处理。**

---

## 2. 与 design.md 的对照（2 处需机主定夺，不变）

- **背书**：补 §2 终端等价项「TodoWrite 列表可视」（全库 TodoWrite=0 已验）；内存不落盘合 §6；活跃 CLI 实时态不可得合 §8；鉴权 socket 合 §4。
- 🔴 **冲突 1 · 隧道探测撞 §6**「不做主动式健康巡检/外部监控探针」→ 默认**不做**。**需机主定**。
- 🔴 **冲突 2 · per-socket viewing 是设计缺口非过度设计**（§6「多设备各自独立会话视图」+§3「多设备状态同步」）→ 全局 `viewingInstanceId` 违背，列**独立排期项**。**需机主定**。
- 🟡 软件事件 `summary` 须脱敏（§4 最小暴露）。

---

## 3. 核心：一瞥即知的统一状态信号（原 F4 升为主）

**这是整个功能的中枢**，研究一致表明它该是核心而非附属。

### 3.1 统一判定 `whatNeedsAttention()`（同源，本次重构最该落地的一条）
一个纯函数，把「会话待处理 + 软件健康」卷成一个结论：
```
whatNeedsAttention({ instances, softwareEvents, healthVerdict }) → {
  level: 'ok' | 'attention' | 'alert',      // 正常 / 有事待处理 / 软件告警
  items: [{ kind, ref, summary, action }],  // 需要处理的项
}
```
- 输入：`instances`（各会话 awaiting/error）+ `softwareEvents`（push 失败/CF Access 失效，见 §4.2）+ `healthVerdict`（§5 搭车，可空）。
- 优先级：`alert`（软件告警）> `attention`（会话待处理）> `ok`。
- **同源**：这**一个判定**同时驱动 ①顶栏信号 ②push 通知 ③详情"需要处理"区——业界（Uptime Kuma 用同一 up/down 驱动通知与面板）验证。落地上**对齐/复用现有 `notifications.js` 的 push 判定，不另起一套**。
- 纯函数、可 `node --test`。

### 3.2 顶栏信号（一瞥即知）
- 一个信号元素：`ok` → **安静确认**（非全隐形——研究修正：Uptime Kuma 绿带证明"一切正常"的低成本确认有价值）；`attention` → 黄 + badge 计数；`alert` → 红。
- **不新造独立点**（研究 + A2 验证）：顶栏已有 `connDot`（连接质量）。二选一：① 扩展 `connDot` 语义为"连接 + whatNeedsAttention 汇总"；② `hamburgerBtn` 上加 badge 显示 `items.length`。避免顶栏双点混淆。
- 点击 → 打开钻取详情（§4）。

---

## 4. 详情层（钻取，非主体）

### 4.1 会话总览（原 F1+F2，"我的终端 tab 排"）
- **F1 会话行状态**（验证可行·极轻）：`renderSessionList` 已渲染 busy/unread/driver，补 `awaitingApproval`(⚠等审批)/`hasError`(⛔卡住)/`lastActivity`。数据在 `instances:list`（`buildInstancesList` 已产出，零后端成本）。待处理排前——**排序只在"打开抽屉那一刻"算一次**（A2 验证：全量重建 + `viewingInstanceId` 重算，选中不破坏）。
- **F2 TodoWrite 清单**（验证可行·纯前端）：识别 `tool_use.name==='TodoWrite'`，`input.todos` 渲染清单（✓/▶/○）；复用现成 `querySelector('[data-tool-use-id]')` 定位（A1 验证存在）+ 给 todo 卡加会话级标记，原地替换旧卡。
- **F2 会话行进度摘要 `▶3/5`（研究后加回·改纯前端）**：CI/Linear 证明"N/M 摘要"是业界常态。**改进**：渲染清单时前端已有 `todos`，**前端自算 `{done,total}` 存该会话前端缓存，会话行读它——不碰 `agent.js`/`server.js` 热路径**（解掉了之前砍它的唯一理由）。

### 4.2 软件事件（原 F3 降为详情·"只看坏的"）
- 研究（`systemctl --failed`）：软件报错的价值是"什么坏了"的过滤，**不必陈列** → 详情里一块"最近软件事件"。
- **接入点（A3 验证后 2 个，都低频高价值）**：① push 投递失败（`notifyOfflineClients` 返回 `{ok:false,reason}`，脱敏去 URL）② CF Access 失效（`cf-access.js` 证书拉取失败/超时）。
- **已砍**（A3 判定噪音）：disconnect（手机切后台高频）、agent error（会话级、判定不清）。
- 实现：新模块 `system-events.js`（内存环形，record/snapshot/reset，重启清零）+ 2 处 record + `io.to('approved').emit('system:events')`。喂给 §3.1 作 `softwareEvents`。

---

## 5. 软件健康结论（原 F5，降为判定的一个可选输入）

- `doctor-runtime.js` 有 `classifyHealth(...)`，但 `server.js` **只 import 未调用、无采集**（A3 抽验调用=0）→ 别的会话在做的半成品。
- **态度**：不自建采集（避开 §6「不做主动健康巡检」）。作为 `whatNeedsAttention` 的 `healthVerdict` 输入，**接好了纳入（degraded→alert），没接也不影响**，顶栏信号不依赖它兜底。

---

## 6. 改动文件清单（重构后·后端更少）

- `public/js/logic.js`（低）— **`whatNeedsAttention()`（核心同源判定）** + `sessionRowStatus` + `summarizeTodos`。全纯函数。
- `public/js/app.js`（低）— 顶栏信号 · 会话行状态+排序 · todo 清单+原地替换+**前端自算进度** · 软件事件详情 · 详情抽屉。
- `public/index.html`（低）— 顶栏信号/badge + 详情容器 + CSS。
- `system-events.js`（新，无风险）— 软件事件内存环形。
- `server.js`（**高·并发在改**）— `system:events` emit（**不再有 todoProgress，进度改前端自算**）。
- `notifications.js`（**高·并发在改**）— push 失败记一条；对齐 `whatNeedsAttention` 判定。
- `cf-access.js`（中）— CF Access 失效记一条。
- `test/*.test.mjs`（低）— 纯函数单测。

> 重构后**移除**：`agent.js` 改动（进度改前端自算、agent error 接入点砍）；隧道探测器（冲突 1）；per-socket viewing（独立排期）。**后端触碰面比上一版更小。**

---

## 7. 实施顺序（重构后·核心先行）

1. **`whatNeedsAttention()` 纯函数 + 单测**（核心中枢，先立）。
2. **顶栏信号**（消费 whatNeedsAttention，先用 instances 数据；badge/connDot 扩展）。
3. **F1 会话行状态 + 排序**（纯前端）。
4. **F2 todo 清单 + 前端自算进度**（纯前端，不碰后端）。
5. **软件事件**：`system-events.js`（纯逻辑+单测）→ 接 2 个被动点 → 详情列表 → 喂回 whatNeedsAttention。动手前 rebase。
6. **F5** 不主动做；接好后并入 healthVerdict。

每步独立可交付、可验证。

---

## 8. 验证策略（TDD）
- 纯函数（`whatNeedsAttention`/`sessionRowStatus`/`summarizeTodos`/`system-events`）放 `logic.js`/`system-events.js`，先失败测试后实现，`node --test`。
- UI：`node scripts/doctor.js` 前端语法门 + 手动浏览器 + 可选视觉 E2E。
- 生效前提：前端资源启动缓存进内存 → 改前端须**重启常驻 server**；本地 `npm run dev`。

---

## 9. 明确不做（研究坐实）
- **Netdata 化**：指标墙/时序图/告警规则引擎——运维重型设施，坚决不做（研究反面教材）。
- **软件事件陈列**：改"只看坏的"（§4.2）。
- **disconnect / agent error 接入点**：噪音（A3 验证砍）。
- **软件健康详细指标面板 / 完整日志检索 / 已连接设备 / 系统运维指标**：过度或用户不看。
- **隧道主动探测**：撞 §6（冲突 1，待定夺）。

---

## 10. 诚实的边界
- **多设备各自独立视图**：design.md 要求、全局 `viewingInstanceId` 违背 → 设计缺口，独立排期。
- **活跃 CLI 实时态**：不落盘，引导 resume。
- **账号级额度**：SDK 拿不到，不展示。
- **进程整体卡死/崩溃**：进程内报不了 → 靠 LaunchAgent KeepAlive / 客户端心跳。
- **F5 空悬**：doctor-runtime 采集未接则健康结论不可得，顶栏信号不依赖它兜底。

---

## 11. 待机主定夺
1. 🔴 **隧道断**（冲突 1）：默认遵守 design.md 不做——认可？
2. 🔴 **per-socket viewing**（冲突 2）：列独立排期项——认可？
3. **重构后的主次**（顶栏统一信号为核心 + `whatNeedsAttention` 同源判定 + 会话/软件事件为钻取详情 + 进度摘要改前端自算）——认可就可开新会话实施。

---

## 12. 环境扰动与可靠取证方法论（保留供续接）
**现象**：本环境污染工具输出——`Read`/`tail`/`cat`/`grep` 长输出被截断/插假内容/返回旧版；`node fs.readFileSync` 可能被**截断成假数据**；**连 Write 的"success"回执和 node boolean 都可能说谎**（本会话实测：重构版 Write 报成功但未落盘，靠 Read 工具查标题才发现）。
**方法论**：① node 读文件后先用 `s.length` 对照基准表确认完整再统计 ② 只输出极短结果（`| head -c 40`）③ **写入后用 Read 工具查第 1 行标题确认真落盘** ④ 多角度交叉验证 + 附证据 + 标信心，绝不编造。
**文件真实大小基准表**：
- `public/js/app.js` — 203586/4435 · `agent.js` — 57449/1126 · `server.js` — 117619/2309
- `public/js/logic.js` — 20831/450 · `public/index.html` — 61241/1150
- `notifications.js` — 6526/140 · `cf-access.js` — 4929/146 · `doctor-runtime.js` — 5663/108

---

## 13. 代码验证结论（3 agent + 主会话抽验，已完成）
- **A1（F2）**：前端有 `querySelector('[data-tool-use-id]')` 定位机制（抽验存在）；原地替换=复用定位+会话级标记，中等偏轻。
- **A2（F1/F4）**：`renderSessionList` 全量重建、选中态靠 `viewingInstanceId` 重算（抽验存在）→ 排序不破坏选中；F4 独立点=过度设计 → 改 badge/复用 connDot（本次重构已采纳为顶栏信号）。
- **A3（F3/F5）**：F3 从 4 收敛到 2（留 push/cf-access，砍 disconnect/agent error）；F5 搭车风险高（抽验 `classifyHealth` 调用=0），不阻塞。

---

## 14. 业界研究结论（指向本次重构，详见 `status-center-design-research.md`）
- **进程管理器**（PM2/systemd）：带色状态词 + 健康气味 + `--failed` 只看坏的。
- **监控面板**（Uptime Kuma/menu bar）：**一瞥即知的总信号 + push 同源**；Netdata 式指标墙是反面教材。
- **进度/通知**（CI/通知中心）：进度="N/M 摘要+展开"；"需要你处理"=聚合+badge+一键直达。
- **对三洞察**：A（两功能）→ 修正为"一个状态原语统一、下分两详情"；B（push 同源）→ 强验证，落 `whatNeedsAttention`；C（异常驱动）→ 验证，但"正常=安静确认"非全隐形。
- **净效果**：重心从"陈列列表"扶正为"一瞥即知信号为核心"，**不增复杂度、后端更少、更克制**。
