# 子 agent 实时可见 + ②③ 落地进度(交接)

> 大目标:web 移动端与 PC 终端**等价**。本轮聚焦"CLI 看子 agent 即时详细、移动端差一截"的根因修复。
> 状态时点:2026-07-14。dev 分支。**改动全在工作树、未 commit、未 push、生产未重启。**

## 研究结论(已坐实,可直接用)
- **即时流机制**:CLI/web 靠 SDK **streaming input mode**(`query()` AsyncGenerator 持久连接)实时 push,非轮询。web 主对话层已对齐(`agent.js` `inputStream()`+`consume` 的 `for await`+`includePartialMessages:true`)。唯一轮询处=`server.js:951 catchUpTick`(web 续接终端活跃会话的架构限制)。
- **子 agent 双层丢弃(核心痛点)**:① SDK `forwardSubagentText` 默认 false→只投 tool_use/tool_result 心跳,不投 text/thinking;② `agent.js` 三处 `if(parent_tool_use_id) break` 主动丢弃。→ 移动端看不到子 agent 活动,CLI 看完整嵌套 transcript。
- **打断三层(实测)**:单 `Esc`/`Ctrl+C`=`interrupt()`(停整轮,**实测也停 run_in_background 后台任务**,推翻研究推断);`Ctrl+X Ctrl+K`(按两次确认,≈机主记的"两次 ESC")=停所有后台 subagent=SDK `stopTask(taskId)`(SDK 才有按 id 停单个的粒度);`Ctrl+B`=`backgroundTasks()`=前台转后台。
- **probe 实证形态**:子 agent 消息经主流实时投递,带 `parent_tool_use_id`;`assistant` 消息带 `subagent_type`;`stream_event`(text/thinking delta)不带 subagent_type。主 agent 的 Agent tool_use 的 `input` 带 `subagent_type`/`description`。

## 已完成(TDD 绿,在工作树)
1. **切片 2a**:`agent.js` map() 加 `background_tasks_changed` 全量 reconcile `bgTasks`(+`task_started`/`task_updated` 静默),修 background bash 不进 bgTasks 的 bug。`reconcileBgTasks()` 方法。test/agent.test.mjs 覆盖。
2. **切片 2b**:`agent.js` `async stopTask(taskId)` 方法(照 interrupt 模式,disposed 保护)。测试覆盖。
3. **切片 A(子 agent 后端分流)**:`agent.js` query options 加 `forwardSubagentText:true`;三处 `parent_tool_use_id break` 改为分流 emit——stream_event 子 agent→emit text_delta/thinking_delta 带 `parentToolUseId`(不碰主 buffer);assistant 子 agent→emit tool_use 带 `parentToolUseId`+`subagentType`(正文走 stream_event 避免重复);**保留 error 不误报主会话守卫**;user 子 agent 仍 break(tool_result 留后续)。删了旧「stream_event/assistant parent_tool_use_id→跳过」两测。**test/agent.test.mjs 187 pass 0 fail;contract:check OK(类型级,新字段无需改契约)。**

## 待做
- （本波体感对等已收口；生产重启常驻 server 后真机验证 stopTask / 历史 sidechain / mirror 1s 追平）

## 已完成(续 2026-07-15)
- **切片 C(前端子 agent 可折叠卡)**:
  - `logic.js`:`isSubagentPayload` / `formatSubagentCardTitle` + `test/logic.test.mjs` 6 测
  - `app.js`:parentToolUseId 分流进 `[data-testid=subagent-card]`(默认收起)；主 Agent tool_use 预建卡；tool_result/result 标「已完成」；clearView 清 map
  - visual:`test:subagent` mock + **TC-24**（默认收起/类型标题/嵌套工具与正文/主流无 thinking 污染/点击展开）
  - 顺带修 visual mock:question requestId 递增(TC-5→5b)、`mock-session-another` history 回填(TC-7 冷切入 reload)
- **切片 2c/2d**:前端「停止」+ mock `task:stop` + TC-16 点击断言
- **③ 额度窗 UI**:状态区「查看套餐额度」
- **历史**:thinking 折叠 + sidechain 挂靠主链 Agent 重建卡

## 教训/坑
- **app.js(~4434 行)本轮 grep+Read 返回损坏输出**(重复行/错行号/断语法)。**下次读该文件小范围、多次核对,损坏就重读,绝不据损坏输出 Edit**。
- 起真 turn 的 probe:本机 claude=`/Users/raylee/.local/bin/claude`(2.1.209),未设 ANTHROPIC_API_KEY=走订阅认证;`forwardSubagentText:true` + `options.agents` 定义 + prompt 派子 agent 可复现子 agent 流。
- 改 agent.js 须重启常驻 server 才生效(生产)。
</content>
