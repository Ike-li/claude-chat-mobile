# 事件与端点参考
> 入向 socket 事件、agent:event 类型、HTTP 运维端点。

- **Part**: 第七部分 · 参考与规范
- **Reading Time**: ~12 min
- **Estimated Tokens**: ~1478

---

入向 Socket 事件、出向 `agent:event` 信封类型与鉴权 HTTP 运维端点。真相源唯一维护于 `app/src/shared/protocol.js`（当前基线：出向类型 **27** 种、入向事件 **46** 种）。

## 出向 agent:event 契约类型 (27 种)

所有服务端向客户端推送的事件统一封装为 `agent:event` 信封：

| 功能分类 | 事件类型枚举 (type) | 触发时机与语义 |
| --- | --- | --- |
| 流式输出与结果 | text_delta 、 thinking_delta 、 result | 文本与思考过程流式分块，轮次收尾结果 |
| 工具调用 | tool_use 、 tool_result | 工具调用参数下发与执行结果回填 |
| 人机交互与审批 | permission_request 、 question 、 request_resolved | 工具审批卡片、人机多选提问与决议完成 |
| 核心状态同步 | init 、 instances 、 mirror_state 、 status_line | 会话初使化、活跃实例全景、只读镜像锁与动态状态行 |
| 模型与配置 | models 、 effort_mode 、 permission_mode 、 slash_commands | 可用模型池、思考强度档位、权限档位与斜杠指令清单 |
| 后台任务与子代理 | task_notification 、 task_progress 、 api_retry | 后台子代理通知、进度瞬态广播与 API 限流重试提示 |
| 元数据与审计 | session_log 、 diag_log 、 history_append 、 user_message | 会话日志追加、诊断日志、镜像增量消息与本地回显 |
| 设备门禁 | device_status 、 pending_devices | 当前设备认证态与待审批新设备清单 |
| 错误处理 | error 、 system | 业务异常与系统级别通知提示 |

## 入向 Socket 契约事件 (46 种)

由客户端主动发往服务端的事件总线，受 `tests/gates/contract-check.js` 门禁进行双向严格比对校验：

| 业务领域 | 包含的入向事件 |
| --- | --- |
| 会话管理与调度 | session:list session:new session:switch session:close session:home session:history session:fork session:deletePermanent |
| 用户交互与输入 | user:message user:interrupt user:answer user:approve user:setEffort user:setPermissionMode user:setViewing |
| 设备与状态同步 | user:approveDevice user:denyDevice sync:since mirror:syncNow conn:ping client:presence |
| 已读位点共享 | read:mark read:sync user:ackUnread |
| 文件操作与工作区 | browse:list browse:read files:search files:write attachment:read |
| 代码与 Git 集成 | git:status git:diff hooks:setup |
| 后台任务管理 | task:stop task:output tool:preview tool:full |
| 系统运维与诊断 | service:status doctor:run dev:restart logs:get logs:clientError audit:get push:test config:refresh env:get env:set |

## 受控 HTTP 运维端点

| 端点路径 | 请求方法 | 鉴权与功能说明 |
| --- | --- | --- |
| /health | GET | 受 AUTH_TOKEN 鉴权保护，输出服务健康状况 JSON |
| /metrics | GET | 受 AUTH_TOKEN 鉴权保护，输出内存指标快照（零外部泄露） |
| /push/vapid-public-key | GET | 获取浏览器 Web Push 所需的 VAPID 公钥 |
| /push/subscribe | POST | 保存移动端生成的推送订阅凭据 |
