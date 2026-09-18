# 在线演示站 `/demo/`

线上地址：<https://ike-li.github.io/claude-chat-mobile/demo/>

让人在浏览器里摸一遍产品界面，不用先装。**跑的是主仓 `app/public/` 的真前端**，一行业务代码都没改；
假的只有后端——一层几百行的浏览器内 shim。

## 它是怎么接上的

产品里 `<script src="/socket.io/socket.io.js">` 由 Socket.io server 自动提供。静态站没有这个 server，
于是那一行正好当注入点：构建时换成 `demo-socket.js`，暴露同名的全局 `io()`。前端 47 处 socket
调用全部落进 shim，而它自己不知道后端是假的。

这么选是为了把漂移面压到最小：前端永远从 `dev` 现拉，**唯一**会与真 server 分叉的是 shim 一个文件。

## 目录

| 路径 | 是什么 |
|---|---|
| `_src/demo-data.js` | 假数据：会话列表、模型、脚本化回复 |
| `_src/demo-socket.js` | 假后端：socket.io 客户端 API + 协议应答 |
| `_src/demo-overlay.js` | 首屏「这是演示」说明卡（双语，跟随 `ccm_lang`） |
| `_build/build.cjs` | 构建：拉前端 → 重写路径 → 注入 shim |
| `_build/verify.mjs` | 验收：真浏览器打开，断言 UI 到达可用状态 |
| 其余顶层条目 | 构建产物，别手改，`build.cjs` 会整个覆盖 |

## 改完要跑的两条

```bash
node demo/_build/build.cjs      # 默认从 dev 拉；--ref <分支> 可换
node demo/_build/verify.mjs     # 六条验收，全绿才 push；--headed 看着它跑
```

`verify.mjs` 从主 worktree 借 Playwright（gh-pages 是孤儿分支、没有 npm 工程），
所以主仓得先 `npm ci` 过。

## 演示里哪些是真的

**真的**：整个前端。渲染、路由、i18n、主题、会话抽屉、审批模态、markdown、代码高亮、
statusline、模型/思考强度/权限模式的所有交互逻辑，都是产品本身的代码在跑。

**假的**：所有数据和回复。回复按关键词匹配 `_src/demo-data.js` 里的脚本，不会调用任何模型。

**四个工作区**（`WORKSPACES`）各有一个常驻实例、自己的 git 分支与 ctx，会话按 `cwd` 归属。
切工作区、切会话、在某个工作区行新建会话都会走 `_rebind()` 重发整套视图——**只改 sessionId
不切工作区**的话，顶栏项目名和 statusline 的分支会留在上一个项目上，`verify.mjs` 里有两条
断言专门盯这个。

**设置与状态**的六行摘要是 `logic/general-nav.js` 现算的，不是写死的字符串：
`service` 给 null 那一行就退化成「状态读取中」，整页看着像坏了。所以 shim 喂了完整的
`service`（startedAt / versions / 两个桥）、设备表、MCP 清单、env 配置组、doctor 结果、
审计记录和日志。六个二级页现在都有内容。

**文件浏览**按 `cwd` 取树（`FILE_TREE` 存扁平路径清单，`listDir` 现算某一层），所以切工作区
浏览的是另一个项目。下钻、读文件、`@` 补全候选、搜索走同一份数据。几个关键文件有真内容，
其余给一条说明——不伪造代码。

> 根目录前端发的 `relPath` 是 **`'.'` 而不是空串**。当成普通目录名去匹配前缀会把整棵树滤空，
> 症状是打开即「空目录」，看着像树根本没配（踩过，`listDir` 里有归一化）。

**思考档位**由 `models` 事件的 `supportedEffortLevels` 决定，SDK 认的是 **`low..max`**
（`logic/models-effort.js` 的 `effortLevelSubtitle` 里 max 的副文案是「最深入更慢更贵」）。
`ultracode` **不要**写进这个数组——前端的 `withUltracodeTier` 会在支持 `xhigh` 的模型上自己追加。
漏一档在界面上完全看不出异常，只是那一格不存在（踩过：漏了 `max`）。

**后台任务**由脚本里的 `{ task: … }` beat 播：按步发 `task_progress`（`transient` 在**信封**上，
不在 payload 里），末尾发 `task_notification`。`task:output` 取得回输出，`task:stop` 停第二次
回 `ok:false`（对齐真 server 的 `stopTask`）。注意 `task_started` **不在** `AGENT_EVENT_TYPES`
的 31 种里——它是 CLI→server 侧的过滤字段，别当事件发。

**仍然空着**：上传、rewind、子代理流水。ack 照回，面板打得开但列表为空。

**已知且有意保留**：`/push/vapid-public-key` 一条 404。演示站没有推送服务，404 正是这件事的
正确语义，前端已经优雅处理。塞一个假 key 反而会让它走进没测过的分支。

## 隐私与暴露面

演示站是公开页面，下面这些是**发布前实测过**的，不是设计意图：

```bash
node demo/_build/audit-privacy.mjs   # 跑一遍真实操作，记录全部出站请求与本地存储
```

- **零第三方请求**：实测 77 个请求全部同源，没有任何一个带 body。往输入框里发一段
  canary 字符串，它不出现在任何请求的 URL 或 body 里。
- **`connect-src 'none'`**：`build.cjs` 往 `<head>` 注入 CSP meta，比产品的响应头更严
  （产品要 `'self' ws: wss:`，演示站的后端在浏览器内，不需要任何连接）。
  这让「不会把你输入的东西发出去」从**代码没写**升级成**浏览器强制**——哪怕将来谁
  往 shim 里加了一行上报也发不出去。唯一的可见副作用：推送订阅要拉的
  `/push/vapid-public-key` 被拦下，console 里每次加载留两行 CSP 违规。
  加 CSP 之前它是一条 404，现在请求根本不发出去（实测 404 资源数从 1 降到 0）。
  演示站没有推送服务，这两种表现都是正确语义。
- **不注册 Service Worker**：前端用绝对路径 `register('/sw.js')`，在项目站下解析到
  组织站根（不属于本仓库）→ 404。实测「未注册任何 SW」。顺带说，那个 `sw.js` 自己
  第一行就写着 *Web Push only. No caching, no offline*。
- **localStorage 里有什么**：`device_token`（前端自生成的随机值）、未读位点、本地日志、
  slash 命令缓存。全是访问者自己浏览器里的本地状态，且零网络出口意味着它们无法转化为
  外泄。注意 `*.github.io` 是**组织级 origin**，同账号的其它项目站共享 localStorage——
  键名带 `ccm` 前缀，冲突概率低，但别在演示站里存任何新东西。
- **假数据全部是占位**：路径一律 `/Users/you/…`，IP 用 RFC 5737 文档保留段
  （`203.0.113.7`），`AUTH_TOKEN` / `CF_ACCESS_AUD` 只给 `masked: {set, length}` 元数据、
  没有任何真值，设备名是通用机型。**改数据时守住这条**。
- **meta 形态的 CSP 拿不到 `frame-ancestors`**（浏览器只认响应头），而 GitHub Pages
  不允许自定义头，所以点击劫持这一格没有防护。演示站没有任何会改变真实状态的操作，
  这里接受该限制，不假装它被挡住了。

## 什么时候会坏

shim 是平行实现，主仓改了这些地方它不会自己跟上：

- `AGENT_EVENT_TYPES` 增删、或水合序列（init / models / permission_mode / effort_mode /
  instances / status_line）的形状变了
- `logic/general-nav.js` 改了 L1 摘要的判据（它决定六行各自要什么字段）
- `#input` / `#btnSend` / `#btnSessions` / `#btnGeneralSettings` / `#permModal` / `#permAllow` /
  `#generalSheetBody` / `#topContextPill` / `#workspaceTabFiles` / `#fileBrowseBody` /
  `#taskProgressBanner` 这些 id 改名
- `browse:list` 的 `relPath` 约定变了（现在根目录传 `'.'`）
- 会话行的时间字段改名 —— 现在是 `lastUsedAt`，写成 `updatedAt` 每一行都会被标成
  「新会话（未保存）」（踩过）
- `/socket.io/socket.io.js` 这个 script 标签的引入方式变了 —— 这条 `build.cjs` 会**直接报错中止**，
  不会静默产出一个连不上的站

前几类都由 `verify.mjs` 兜住：**发版前跑一次，红了就照着断言修 shim**。

十五条断言都做过反向注入（改坏 shim 确认对应断言会红），不是摆着好看的：

| 注入 | 变红的 |
|---|---|
| `_seq` 改成固定值 | 流式回复、审批（水合仍绿——走 `_ctrl` 不参与去重） |
| `instanceId` 置成不匹配的非空值 | 同上两条（置 `null` 反而全绿，判据方向见 shim 头注释） |
| `session:new` 去掉切工作区 | 工作区那两条 |
| `service` 置 `null` | 设置面板那条（报「缺运行时长」） |
| `listDir` 去掉 `'.'` 归一化 | 文件浏览那条（报「空目录」） |
| task beat 的 `steps` 置空 | 后台任务那条 |
