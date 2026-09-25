# 硬性规则与技术债索引

> **定位**：维护者在改代码前应对照的「产品 + 架构 + 工程」硬约束清单。  
> **产品立场（2026-08 仍有效）**：**n=1 自托管**——单用户、权限等同本机账号，不做多租户 / 多账号隔离。  
> **与其它文档的关系**：
>
> | 文档 | 管什么 |
> |------|--------|
> | [架构说明](architecture.md) | Web/CLI 双通道、单驾驶员、事件信封 |
> | [展示契约](display-contracts.md) | 模型 / effort / statusline 允许的变换 |
> | 本文 | **不变量、n=1 取舍、已决「不做」、门禁锚点** |
>
> 历史 design 规格文档已下线。代码注释里残留的 design 文档路径 / `AD-*` / `NFR-*` / `SP-*` 引用，以**本文 + 当前实现 + 单测**为准，不必再找那份文件。

---

## 1. 产品边界（改这些等于换产品）

| 规则 | 说明 | 锚点 |
|------|------|------|
| 终端等价 | Web ≈ 本机对 claude 打字；CLI 有什么 Web 就有什么 | `CLAUDE.md`、Agent SDK |
| 单用户 = 主机所有者 | 无多用户/租户隔离；鉴权通过 ≈ 本机启动 claude 的权限 | [README 安全边界](../README.md#安全边界) |
| 不是远程桌面 / 共享 TTY / 多租户托管 | 不附着终端 stdin/stdout | [architecture.md](architecture.md) |
| 尽量不重复造轮子 | 功能先看 Claude Code CLI / Agent SDK | `CLAUDE.md` |
| **不替用户决定怎么后台运行** | 启动只有两条入口，互不相关：**headless** = 终端 `npm start`（全平台基线）；**macOS desktop** = `CCM.app`（常驻/重启/日志都在菜单里）。macOS 之外不做官方常驻适配，文档只指路。`desktop/launchd/` 模板和 `service.js` 是桌面端背后的实现，不是第三条入口。维护者本机的 Docker playground（`docker-compose.playground.yml`）是测试基础设施，与 `test:docker` 并列，**不是**产品入口，用户装机路径不走它 | 2026-08-15 维护者确认；2026-08-17 维护者确认 desktop 单独入口；[deployment.md](deployment.md) |
| **可选功能由用户开关，不猜** | 桌面控制台、两个 bridge、`LOG_TERMINAL`、推送……默认全关，装机向导逐项问。非交互模式下两类失败模式分开处理：**会动全局的**（`--hooks` 写 `~/.claude`、`--desktop` 跑 swiftc）缺省即 `off`；**静默回落会扩大攻击面的**（`--work-dir` 回落 `$HOME` = 整个家目录挂给远程入口）直接拒绝。取值非法（`--hooks=maybe`）一律拒绝，不猜意图 | `scripts/setup.js` `resolveSetupPlan`；`tests/unit/setup.test.mjs` |
| **对模型通路零假设** | 不关心 claude CLI 接的是哪个上游——官方订阅 / API key / Bedrock / Vertex / 第三方网关，一视同仁。**禁止任何 `ANTHROPIC_BASE_URL` 匹配、厂商白名单或上游探测**；唯一允许据以调整行为的信号是 CLI 自报的能力位（如 `rate_limits_available`），因为那是 CLI 说的、不是我们猜的。`ANTHROPIC_*` 启动期剥除是为「配置文件不许压过 shell 的 provider 凭据」（终端等价），不是限制上游。官方 Remote Control 在网关 / API key 配置下整条不可用，而本项目全功能可用——**这正是它存在的主要理由之一** | 2026-09-01 维护者确认；`app/src/agent/agent.js` 的 `USAGE_THIRD_PARTY_INTERVAL_MS` 头注「不猜 ANTHROPIC_BASE_URL」；`app/src/shared/child-env.js`；[getting-started.md](getting-started.md) |
| **不新增持久化层** | 消息内容的真相源**永远**是 `~/.claude/projects/<dir>/<id>.jsonl`，CCM 一条都不存（`sessions.json` 只有索引与指针）。新增持久化必须**同时**满足：① claude 侧不存在该概念（设备信任 / 推送订阅 / 审计这类 web 特有物）② 不能从 transcript 重建。缓存类不受此限，但**必须可随时删除、损坏即当作没有**。唯一的反向例外：往 claude 的 jsonl 追加一行 `entrypoint-marker`，那是互通性所需（让 CLI `/resume` 看得到 web 建的会话），不是 CCM 的存储 | 2026-09-01 维护者确认；`app/src/sessions/history.js`；`app/src/server/app.js` 的 entrypoint 写入；[architecture.md](architecture.md) 状态表 |
| **鉴权是启动前提** | 没有 `AUTH_TOKEN` 就**不启动**，任何绑定模式都一样，`BIND_MODE=loopback` 也不例外——本机浏览器打开同样是 web 访问。纯空白 token 一并拒绝（它 truthy 但形同虚设）。**鉴权面 = 数据面与操作面**，不含静态壳：`index.html` 与前端 JS 必须登录前可取，那是登录门本身。本机 loopback 仍免**设备审批**（第二因子，见 §6），但不免 token | 2026-09-01 维护者确认；`app/src/shared/bind-host.js` `resolveBindPlan` 的 `token_required`；`tests/invariants/bind-host.test.mjs` |
| **公网入口：一条基线、一个受管加层** | 基线 = `AUTH_TOKEN` + 逐设备审批，对所有拓扑（局域网 / 加密隧道 / 反代 / 直连 / Cloudflare）相同；**Cloudflare Access 是可选加层**：开着时它管的公网 Host 改认 Access 身份——替代 `AUTH_TOKEN`，缺省也替代设备审批（见 §6）；关掉它回到基线，不是「退化」。产品**受管**的第三方进程只有 `cloudflared`（unit 模板、install/uninstall、菜单栏主服务位）；Tailscale / WireGuard / 反代等**一等支持但不受管**：文档配方、向导提示、doctor 检测，产品不装、不起、不保活。`ACCESS_PROFILE` 是纯声明（只影响 doctor 的针对性检查，不改运行时）；限速来源不随 `ACCESS_PROFILE` 变，采信边缘注入头只有两条路：Access 层启用时公网 Host 的 `CF-Connecting-IP`，以及 `TRUSTED_PROXY=loopback` 显式 opt-in 的反代 `X-Forwarded-For` 末跳；默认不采信任何转发头（`AUTH-04`，失败方向是合桶不是拆桶）；鉴权侧由 `authStrategy` 保证核心不依赖任何具体 IdP。**这不是插件机制**——策略仍在仓内、仍受全部门禁约束（插件化已于 2026-08-14 否决） | 2026-09-01 维护者确认；2026-09-06 维护者确认基线口径（用户反馈不想用 Cloudflare）；`app/src/auth/auth-strategy.js`；`app/src/ops/service-units.js` 的 `tunnel`；[deployment.md](deployment.md) |

---

## 2. n=1 取舍（有意瘦身，不是漏做）

下列设计在 **「每实例单用户 / 一人为主」** 下成立。若目标变成多租户、团队账号、或「一人多机同时看不同会话且互不串台」，应**先改本文立场**再开大改，而不是在局部打补丁。

**下面两张表是 n=1 假设面的登记簿**：每行一个 ID，代码里对应位置写 `// n1: <ID> 理由`，由 `npm run check` 的 `tests/gates/check-n1-assumptions.js` 双向校验（登记了却没标记 → 红；标了却没登记 → 红）。改立场那天，`grep -rn '// n1:' app/src/ app/public/js/` 就是要逐个处理的清单。

> 门禁只保证**已登记的**不漂移，**发现不了新增的未登记假设**——n=1 依赖没有语法特征，一个新的全局单例在语法上与普通模块级变量毫无区别。新增假设点仍得靠 review 时想起来登记。

### 2.1 全局查看上下文

| ID | 单例 | 含义 | 持有者 |
|----|------|------|--------|
| `N1-VIEWING-INSTANCE` | `viewingInstanceId` | 服务端当前查看 tab；全员共享 | `app/src/server/app.js` |
| `N1-VIEWING-CWD` | `viewingCwd` | 当前工作区上下文；新建会话 / statusline / 白名单缺省 | 同上 |
| `N1-MIRROR-LOCK` | `mirrorReadonly` + 全局广播 | 只读镜像锁是**全局单值**，非 per-连接 | `app/src/server/mirror-engine.js` |
| `N1-MIRROR-VIEW-FE` | 前端镜像视图 | 按 `viewingInstanceId` 分流渲染 | `app/public/js/app.js` |

**已知缺陷（n=1 接受）**：两台设备同时看不同会话时，会话 B 的 `mirror_state` 可能误解锁正看 A 的一端。见 §5 AD-5。

### 2.2 进程内易失态

| ID | 状态 | 取舍 | 持有者 |
|----|------|------|--------|
| `N1-RATE-LIMIT` | 鉴权限速 Map | 内存；重启清零（残余风险可接受） | `app/src/server/app.js` 的 `rlStates` |
| `N1-METRICS` | `/metrics` 计数 | 内存；重启清零；**JSON 快照**，非 Prometheus 文本（单用户无 scraper 的默认运维面） | `app/src/ops/metrics.js` |
| `N1-USAGE-SNAPSHOT` | 额度 / rate 快照 | 单例、不分账号 | `app/src/ops/statusline.js`（`usage-snapshot.js` 自身是纯函数，状态由调用方持有） |
| `N1-MSG-DEDUP` | 消息去重 | 内存即可 | `app/src/server/app.js` 的 `messageDedupState`（`message-dedup.js` 同为纯函数） |

**硬约束**：历史回显走鉴权 `session:history`；**不开无鉴权 HTTP 数据端点**。

### 2.3 安全哲学

| 规则 | 说明 |
|------|------|
| 已鉴权 ≠ 限操作面 | 限速只挡鉴权口暴破；用户即 root，对操作面限速违背产品目的 |
| 工作区白名单 | 路径门，不决定 Claude 工具是否自动放行 |
| 范围内文件不敏感过滤 | `.env` 等照读——与「用户即 root」一致 |
| 子进程 env 不做白名单裁剪 | 指**继承环境**：与终端 claude 一致，第三方网关靠 shell `ANTHROPIC_*` 或 CLI settings 文件的 `env` 块（SDK 会话的 `settingSources` 含 user/project/local，写法见 getting-started「官方订阅与第三方网关」）。`app/src/shared/child-env.js` 有三处例外——滤掉值为空串的键、追加 `CCM_STATUSLINE_ORIGIN` / `CCM_HOOKS_ORIGIN` 两个 origin 标记（后者是 hooks 桥判「这是 web 驱动的子进程、别重复推送」的依据），以及**剥掉 CCM 自己的控制面密钥**（`AUTH_TOKEN` 与 `VAPID_*` / `NTFY_*` / `CF_ACCESS_*` 三组前缀，2026-09-17 安全审查 H1，红线登记为 `AUTH-06`）。第三条**不是对「不做白名单裁剪」的削弱，而是对它的补齐**：本条规则要的是「与终端 claude 一致」，而 server 会把 `ccm.config.json` 的值投影进 `process.env`（`ops/config.js` 的投影循环），于是子进程实际拿到的**比终端更宽**——普通终端里的 claude 环境里根本没有这几个键。剥掉之后才真的等宽。判据是「这个键属于 CCM 还是属于 claude」，`ANTHROPIC_*` / `CLAUDE_CODE_*` / 代理变量一律原样透传，第三方网关路径不受影响。剥离不只对 SDK 会话：server 自己在工作区里跑的 git（变更面板、状态栏）与 `claude --version` 走同一份 `childEnv()`——仓库配置能让 git 执行任意命令（`core.fsmonitor` 等），而 `.git/config` 对模型可写，只剥 SDK 那一路等于留了条绕行（2026-09-22 review P2）。另有一个**叠加层**方向相反：worktree 网关隔离读出的 `resolvedEnv` 经 `agent.js` 的 `filterSafeResolvedEnv` 只放行 `ANTHROPIC_*` / `CLAUDE_CODE_*` 才叠加上去，防 worktree settings 覆盖 `PORT` / `AUTH_TOKEN` / `CCM_DATA_DIR` 等服务端变量 |

---

## 3. 架构不变量

### 3.1 单驾驶员

详见 [架构说明 · 单驾驶员模型](architecture.md#单驾驶员模型)。摘要：

1. Web 驾驶时该 `AgentSession` 写入；前端一轮一条。  
2. 检测到 CLI 外部写入 → Web 只读镜像。  
3. CLI 仍在跑 → Web 不向同一会话发消息。  
4. 终端静默后解锁；Web 接管前若有 external 增长 → dispose + resume 吸收再发。  

**有意不修的边界**：本地 turn 的 busy→idle 吸收窗口内撞进的终端写入可能被吞（须切会话重载）。完整闭合见 §5 SP-10。

### 3.2 事件契约

| 项 | 规则 |
|----|------|
| 出向 | 唯一信封 `agent:event`（`type` + `seq` + `epoch` + …） |
| type 白名单 | **`app/src/shared/protocol.js` 的 `AGENT_EVENT_TYPES` 为唯一真相源**（当前 31 种） |
| 入向 | 同文件 `INBOUND_SOCKET_EVENTS`（当前 61 个） |
| 门禁 | `npm run check` → `tests/gates/contract-check.js` / `agent-event-contract.js` |
| 改 type | 必须同时改 protocol + 真实 emit 路径 + mock + 前端 handler（否则 check 红） |

### 3.3 状态落点与模块边界

| 规则 | 门禁 |
|------|------|
| 新状态**不要**再进 `app/public/js/app.js` / `app/src/server/app.js` 顶层 | 约定 + review |
| 前端：`app/public/js/app/*` 工厂 + context | 样板 `event-dispatch.js` |
| 后端：所属域模块；`app/src/server` 仅组装根；`app/src/shared` 叶子 | `tests/gates/check-import-boundaries.js` |
| 运行时不得 import `scripts/` / `tests/` | 同上 |
| 零循环依赖 | 同上 |

### 3.4 展示（摘要，细节见 display-contracts）

- 条数/语义对齐 TUI；禁止偷偷合并、用 Web 偏好冒充 CLI 态。  
- Statusline **禁止** CLI/Web 字段混拼（额度账号级回落是唯一例外且须标非实时）。  
- 改契约：先改 `tests/unit/display-contracts.test.mjs`。

---

## 4. 工程硬规则

### 4.1 分支

- **`dev` = 开发主线**。日常改动走 feature 分支 → PR → `dev`，一个小改动一个 PR；不在 `dev` 上直接提交。**GitHub 默认分支是 `master` 而不是 `dev`**（理由见下条），所以开 PR 必须显式 `--base dev`。
- **`master` = 对外发布的稳定版本**，只接受 `scripts/release.sh` 开的 `dev` → `master` 发版 PR。开了 `enforce_admins`，**谁都不能直推**；`quality` 里另有一道 step 拦住 head 不是 `dev` 的 PR。
- 两条分支的 required checks 相同（`quality` / `unit-test (20)` / `unit-test (24)` / `e2e`），**approvals = 0**：单人仓库不能自我 approve，设成 1 会让所有 PR 永远合不进去。PR 的作用是强制 CI + 提供可读的变更面。
- 发版顺序：bump → 推 `dev` → 等真 CI 绿 → 开发版 PR → 等 PR 检查绿 → 合并 → 在合并后的 `master` HEAD 上打 tag → 建 Release。**tag 必须在合并之后打**：PR 合并没有 ff-only，合出来是 merge commit，tag 打早了就指不到 `master` 的 HEAD。
- 其它分支 worktree 在仓库外兄弟目录，不是本树源码。
- **`master` 归档即最新发布**：装机 `curl` 直接指向 GitHub 对 `master` 的源码归档（§4.1.1），所以 `master` 上不得出现未发版的提交。这条此前靠人守，2026-09-12 破过一次——dependabot 的 PR 默认开到默认分支（当时是 `master`），合进去就带上了未发版提交。当时的止血是三道齐上：`.github/dependabot.yml` 的 `target-branch: dev`、默认分支改为 `dev`、以及 `quality` 里那道「只有 `dev` 能进 `master`」。
- **同日稍后默认分支又切回了 `master`**，现在靠两道：`target-branch: dev` 与 `quality` 那道闸。切回的理由是另一条同样硬的约束——装机拉的是 `master`，而**默认分支决定了访客在仓库首页看到哪份 README**；停在 `dev` 会让首页展示的内容领先于任何人能装到的版本（README 重写合进 `dev` 的那一刻就分叉了）。撤掉的那道是冗余而非唯一：原事故的直接成因是 dependabot 把 PR 开到默认分支，而那条路已被 `target-branch: dev` 写死堵上（它不读默认分支设置），`quality` 那道闸也仍然显式报错拦住任何 head 不是 `dev` 的 PR。**代价是开 PR 时默认 base 变成 `master`，要显式 `--base dev`**；且默认分支是仓库设置，被改回去不会有任何提示——这正是 `dependabot.yml` 里那条注释说「两道一起用」的原因，那份文件在代码评审里看得见，而仓库设置看不见。

### 4.1.1 分发形态（GitHub 对 `master` 的源码归档：裁剪过的源码树，不是 npm 包、不上传资产）

装机 `curl` 直接拉 `https://github.com/<repo>/archive/refs/heads/master.tar.gz`：GitHub 现场 `git archive`、遵守被归档那棵树里 `.gitattributes` 的 `export-ignore`（2026-09-08 实测：dev 归档与本地 `git archive origin/dev` 逐项一致；`git archive --remote` 走 GitHub 被 422 拒绝，那条路不通）。发版不打包、不上传任何 Release 资产；`master` 只由 `release.sh` ff 前进，所以 `master` 归档就是最新发布（§4.1）。规则必须已经在被归档的那棵树里——树里没有规则的老 tag 归档不裁剪。裁掉什么由 `.gitattributes` 的 `export-ignore` 决定：**一条 `/tests/**` 前缀就裁掉了用例 + 测试基建（`tests/infra/`）+ 全部门禁（`tests/gates/`）**，另加 `.github/`、`.claude/`、`CLAUDE.md`、`AGENTS.md`、`.gitattributes`、`.dockerignore`、`eslint.config.js`、**`docs/` 下的 `testing.md`**（它通篇引用已被裁掉的 `tests/` 路径与 `mutate:docker`、`test:invariants:*`，留在分发树里全是死引用；这里刻意不把它写成连写路径——`doc-consistency` 的裸提及检测不区分「链接」与「字面提及」，写全了这句解释自己就会在分发树里变成一条指向被裁文件的死链，用户跑 `doctor` 的 D9 见红）与 `scripts/` 里四个维护者工具；**留下**运行时 + 用户运维命令（`setup`/`doctor`/`device`/`config`/`service`/`uninstall`/两个桥）+ `docs/` 下**除 `testing.md` 外**的文档 + `desktop/`。

- **为什么门禁住在 `tests/` 下**：此前它们散在 `scripts/`，「哪些是门禁」这份名单要在 `.gitattributes`（17 行）、`tests/unit/dist-manifest.test.mjs` 的正则、`repo-inventory.js` 的规则表**三处各存一份**——加一个门禁脚本要改三个地方，漏了任何一处都没有机制会发现。收进目录后三者全部退化成目录前缀，不需要维护。
- **两个不能移的例外**：`scripts/doc-consistency.js` 与 `scripts/collect-source-files.js` 被 `scripts/doctor.js` import，而 `tests/**` 是被裁掉的——移进去等于用户跑 `doctor` 直接 `ERR_MODULE_NOT_FOUND`。已由 `dist-manifest.test.mjs` 单列断言保护。
- **验证必须基于工作区 tree，不是 `HEAD`**：`git archive HEAD` 打包的是上一次提交的文件树，配上这一次的裁剪规则就是两边不同源——移动了文件而测试恒绿。见 `tests/helpers/worktree-tree.mjs`。

- **不用 `npm pack`**：实测 npm 无条件排除 `package-lock.json`（写进 `files` 字段也没用），而分发包的装机路径 `npm ci --omit=dev` 靠它复现依赖树；且本包 `private: true`、无 `main`/`bin`，本就不是给人 `npm install` 的。
- **`package.json` 原样进包，不改写**：`export-ignore` 是文件级的，改写只能靠发版时自己打包再上传（2026-09-03 至 09-08 曾这么做：按可达性删 scripts、删 `devDependencies`）。改为 GitHub 归档后放弃改写，代价是包内 `npm run` 仍列出几十条跑不了的 `test`/`check`/`lint`/`mutate` 类命令、`devDependencies` 也还在；运行、`npm ci --omit=dev`、`setup`、`doctor` 都不受影响，装机文档明写这一点。换来的是删掉整条自造流水线（解包重打、macOS bsdtar 写 pax xattr 头的绕法、发版自检、资产上传）与「Release 在、资产空」的半发布态（2026-09-08 实测 v1.6.2 的 `latest/download` 就是 302→404）。**别再提议把改写做回来**：要么重开上传流水线，要么让用户机跑一个被裁掉的维护者脚本，两条都比一句文档说明贵。
- **实测记录（2026-09-08）**：与 GitHub dev 归档逐项一致的树上跑**真实** `npm ci --omit=dev` 通过（142 包，eslint/playwright 未装）。2026-09-03 那条「改写后的 `package.json` 起 server、`/health` ok」的记录随改写一起作废。
- **名单方向是黑名单**，与 §4.2 的白名单相反：那里漏判 = 在宿主机跑破坏性命令（致命），这里漏判 = 多带几个文件（无害），而误排除 = 用户下载到跑不起来的包（致命）。所以宁可多带。
- 不变量由 `tests/unit/dist-manifest.test.mjs` 用 `git check-attr` 钉住（生产闭包零裁剪 · 测试树全裁 · 分发树里 doctor 的 D9 全绿 · 零 devDependency 泄漏），闭包算法在 `scripts/dist-manifest.js`。
- 唯一跨界依赖：`scripts/doctor.js` import 门禁模块 `doc-consistency.js` 与 `collect-source-files.js`，两者必须留在包里，已单列断言保护。

### 4.2 测试跑在哪（白名单，非黑名单）

**宿主机只允许**这 11 条（真相源 `tests/gates/guard-host-tests.js` 的 `HOST_ALLOWED_SCRIPTS`）：`lint` · `lint:fix` · `check` · `test:unit` · `test:invariants` · `test:coverage` · `test:e2e` · `test:visual` · `test:playwright` · `test:e2e:parallel` · `app:test`。末五条：`test:coverage` 与 `test:unit` 逐字同档（同一份 preload-env、同一批 `tests/unit/*.test.mjs`，只多一个 `--experimental-test-coverage`），`test:visual` / `test:playwright` 是 `test:e2e` 的同源别名，`test:e2e:parallel` 是它的分片编排（每个分片就是一条 `npm run test:e2e --`），`app:test` 是 `check` 自身的一环。

> ⚠ **`test:invariants` 的两个兄弟不在名单上**，别照后缀类推：`test:invariants:server` 起真 `app/server.js` 子进程；`test:invariants:env` 跑卸载器，隔离依赖被测代码认注入的 `home`/`root`/`appPath`，回落即打在真实家目录上。两条都进容器（`test:docker` 已含）。

**其余一律容器**：`test:docker` · `test:docker:playground` · `mutate:docker` 等。维护者 playground（干净 Linux HOME、发 loopback 端口、fake-claude）走 `npm run playground:up` / `npm run test:docker:playground`，镜像仍是 `Dockerfile.test`。

**单独授权例外**：`RUN_CLAUDE_INTEGRATION=1` · `npm run test:smoke`。

根因：2026-08-02 宿主机 `mutate` 误删 `~/.claude/projects`。钩子实现见 `tests/gates/guard-host-tests.js`。

### 4.3 `npm run check` 包

覆盖面导览，**逐项以 `package.json` 的 `check` 为准**（这行漂过两次：加门禁时没人会回头数散文里的项数）：ESLint · import 边界 · 双向事件契约 · 文档一致性（含契约计数）· 架构图漂移（gh-pages 图集的常量/路径/基线）· n=1 假设面登记簿（§2）· i18n 孤儿 key · 破坏性删除 · 不变量编号（`invariants/` 的 `// 守护：` 行与编号表双向对齐）· Playwright 禁止模式 · desktop swiftc typecheck + CCMCore 单测（`app-build --test-only`）· 未分类文件（inventory）。

链上成员由 `tests/unit/gate-wiring.test.mjs` 钉住：`tests/gates/` 下的门禁要么挂在 check 上，要么在那份 `NOT_IN_CHECK` 白名单里写明理由。新写一个门禁忘了接线会红——**一个不被执行的门禁比没有门禁更危险，它占着「这块有人守」的位置**。

删除豁免标记（不通用）：

- 测试 recursive：`// safe-rm: 理由`（须可追溯 mkdtemp）  
- 生产单文件路径难审计：`// safe-path: 理由`  
- **为单文件批的豁免不放行 recursive**

Playwright 禁止：`test.only` / `skip` / `fixme` · `networkidle` · `waitForTimeout`。

### 4.4 生产运维

- 桌面端占着端口：**勿再手动 `npm start` 撞端口**。  
- 改配置/代码：桌面端菜单里 server 一行点「重启」；headless 停掉当前 `npm start` 再起。  
- **例外**：工作区列表热加载（`ccm.config.json` 的 `WORKDIRS` 或旧版 `workdirs.json`）；被移除目录仅拒新开。哪些项可热加载由 `env-schema.js` 的 `reload` 标记决定（缺省 `restart`，当前唯一 `hot` 是 `WORKDIRS`）。

### 4.5 产品 UX 已决

- 重启/空闲回收后停**空首页**，只展示最近列表，**不自动** `session:switch`。  
- dispose / resume 失败默认**禁止跨工作区闪回**（用户主动关 tab 可允许）。  
- 忙碌中禁止 externalDirty 的 dispose+resume 置换（SRV-003）。  
- 服务状态面板只渲染判定化告警，不展示裸计数器（原始数留 `/metrics`）。
- 重启历史两条路径**互斥**：macOS 走 launchctl 快照比对（还能看到隧道等其它 unit），其余平台走 server 自身启动记录。双写会让同一次重启进两条、flapping 阈值虚高一倍。  
- 推送 body 最小化（SEC-04）；完成类通知在前台在线时可不推。
- 额度墙「到点自动继续」**重启即作废、不落盘**（同 CLI 退出即作废；与 APPROVAL-02 同立场：重启时残留的待执行动作不再执行）。它是在无人值守时替用户开一轮，「重启后自动开跑」比「重启后要手动点一下」更难预期。别为「更可靠」加持久化，取舍见 [architecture.md](architecture.md#额度墙到点自动继续)。

### 4.6 配置文件

| 规则 | 说明 |
|------|------|
| 单一事实源 | schema 在 `app/src/ops/env-schema.js`，读写与类型归一在 `app/src/ops/config-file.js`。加一个配置项只改前者 |
| 格式 | `ccm.config.json`（结构化 JSON）。**存在时优先，缺失才回落 `.env`**；旧部署零改动 |
| 读写同源 | 面板/CLI 写入的文件必须与启动时读的是同一份。写错源不是报错而是**假成功**——用户看到「已写入」、重启毫无变化（同 CF_ACCESS_* 被 dotenv 吞那次） |
| 优先级 | shell env > 配置文件 > 内置默认。`ANTHROPIC_*` 只认真实 shell export，写进文件照样剥除 |
| 必须 gitignore | 与 `.env` 同等敏感且本仓 **public**；规则在 `.gitignore`（`ccm.config.json` / `ccm.config.*.json` / `ccm.config.json.*` 三条）。**由 `CONFIG-03` 钉住**（`tests/gates/check-config-gitignored.js`，在 check 链上，逐条跑 `git check-ignore` + 三条反向锚点；**必须是门禁不能是 `tests/invariants/` 下的用例**——它依赖 git 元数据，而 linked worktree 检出的 `.git` 在容器里解析不到，同 `inventory:check` 那条）——2026-09-17 之前这里确实没有任何测试或门禁，删掉那三行不会让任何东西变红。gitleaks 钩子不是替代品：它扫的是「内容像不像凭据」，`CONFIG-03` 管的是「路径会不会被收进来」 |
| 迁移是显式动作 | 没有任何代码路径会自动创建 `ccm.config.json`（`setup` 与 `config migrate` 除外，两者都是用户发起） |
| 未登记键：**读宽写严** | 读取侧原样放行进 `process.env`（claude 子进程继承它，`HTTPS_PROXY` / `CLAUDE_CONFIG_DIR` 这类才有效），只打一行提示；写入侧 (`config set` / 面板) 仍只认 `WRITABLE_KEYS`。**这个不对称是有意的**——别为了「一致性」把两侧统一：统一到严，第三方网关用户静默失效；统一到宽，面板变成任意键写入面 |
| CLI 值解析不复用 `coerceToSchemaType` | `parseCliValue` 自己认 `true/false/on/off/yes/no/1/0`。复用会出事：`TOGGLE_OFF` 的 off 字面量是 `'off'`，`set WEB_STATUSLINE=false` 经 coerce 会**变成开** |

---

## 5. 已评估不做的技术债（无新证据别重开）

| ID | 内容 | 决定 | 登记处 |
|----|------|------|--------|
| **AD-5** | per-(sessionId, connId) 镜像锁 + `readonly_changed` 定向下发 | **不做**（2026-07-12 维护者确认，Phase 8） | `mirror-engine.js`、`app.js` 注释 |
| **SP-10** | busy→idle 吸收完整闭合（前端 uuid 幂等 + live 记 uuid） | **不做**（同上） | `history.js` `catchUpStep` 头注 |
| **OQ-09** | 审批时延等「人机/价值」埋点遥测 | **拒绝**；管道健康指标可走 `/metrics` | `metrics.js` |
| **UP-1** | 让 web 端 slash 像终端那样 inline 跑（见 §5.1） | **做不到**（上游约束，2026-08-05 查证） | `agent.js#_claimSessionIdEarly` 注释 |
| **DT-1** | 仓库里放编译好的 `CCM.app` 供下载 | **不做**（2026-08-16）：本地编译产物**无 quarantine 属性**，双击即开；下载来的必被打上 quarantine，首次打开必撞 Gatekeeper。根治要 Apple 开发者账号做公证（$99/年），对自托管工具不成比例；教用户 `xattr -d` 绕过等于教他关掉一层安全机制 | `docs/getting-started.md#为什么不直接发一个编译好的-app` |

**重开条件（任一条）**：

1. 产品明确放弃 n=1，或实测「一人多机看不同会话」成为常态痛点；或  
2. 有可测复现 + 愿意承担 AD-5 / SP-10 全链路改动面。  

否则：**别因「设计验证通过」或「理论上更干净」重启这两项。**

### 5.1 web 端 slash 命令恒 fork（UP-1，上游既定行为，不是 bug）

`/code-review` 这类内置 skill 在 web 端**从来没有 inline 跑过**，也不会有。CLI 2.1.222 的判据：

```js
$Dl(e) = printOutputFormat ∉ {text,json}
       && CLAUDE_CODE_REPORT_FINDINGS
       && options.tools.some(r => r.name === "ReportFindings" || r.aliases?.includes(…))
// 真 → getContext 返回 "inline"；否则 "fork"
```

**判据是「宿主有没有 `ReportFindings` 工具」**（其描述原文：*so the host UI can render them*）。
终端有 → 结果直接渲染进对话；ccm 作为 SDK host 没有 → CLI 认定渲染不了 → fork 出去跑完只给一坨文本。

| 事实 | 证据 |
|---|---|
| web 14 次全 fork、终端 1 次 inline，**同为 xhigh 档** | 全盘 15 次调用扫描（2026-08-05） |
| 不是回归、不是档位、不是 ccm 代码 | 同上 |
| 整轮 `stream_event` = 0（两个转发开关都开着） | 隔离 SDK 探针 |
| `init` 132s 才到，`rate_limit_event` 9.5s 就带 `session_id` | 同上 |

**接不上的原因**（查过，别重开）：工具名匹配是精确匹配，SDK 自定义工具走 MCP、名字带 `mcp__` 前缀；
`CLAUDE_CODE_REPORT_FINDINGS` 是内部 flag，`sdk.d.ts` 未暴露。要通得等上游开口子。

**因此 fork 是既成前提**，我们只在此前提下改善可见性（三处，均已落地）：
sessionId 不独等 `init`（`_claimSessionIdEarly`）· 看门狗豁免本地命令在途（45 分钟上限）·
扫 `<sessionId>/subagents/` 喂既有 `bgTasks`（只喂进度不喂正文——单文件可达 762KB）。

> **判据陷阱**：判 inline/fork 只看「slash 之后**紧接着的下一条**主链条目」。
> 用「主链 assistant 累计数」会把用户后续对话算进来，得出不存在的回归转变点（2026-08-05 踩过）。

---

## 6. 安全分层（互不替代）

详见 [架构说明 · 鉴权与范围边界](architecture.md#鉴权与范围边界)（完整分层图与各层互不替代的边界）。摘要：

**入口凭据：AUTH_TOKEN（必备，无它不启动）‖ 公网 IdP 策略（可选加层，当前唯一实现 CF Access）**，按 Host 二选一 → 设备信任 → 工作区范围门 → CLI permissions.allow + Web 权限档 → Agent 审批 ‖ 文件编辑器直写（独立范围/大小/哈希/审计）。

第一层是**前提而非选项**（§1「鉴权是启动前提」）：没有 token 连 server 都起不来。**但「起得来」不等于「每个连接都持有令牌」**：IdP 开着时，它管的公网 Host 只认 IdP 凭据（JWT），`AUTH_TOKEN` 在那条路上既不要求也不放行（带着正确 token、没有 JWT 照样 401）。所以下游判据的前提按入口分两种：IdP 管的公网 Host 上是「对方已过 IdP」，其余入口上是「对方已持令牌」。凡是要把 `AUTH_TOKEN` 交出去、或以「反正对方有 token」为由放宽的逻辑，都得先看连接走的是哪条——2026-09-22 review 查出 `connect:qr` 把明文 token 回给了本不持有它的 Access 会话，推理起点正是旧版这里写的「下游永远已持令牌」。第二层写成「公网 IdP 策略」而不是具体产品名，是因为核心代码只认 `app/src/auth/auth-strategy.js` 的接口形状；CF Access 是当前唯一实现，换 IdP 不该动核心。它是**可选的**：第一层 + 第三层就是公网基线（§1「公网入口」）。加层开着时，在它管的公网 Host 上替代第一层，默认档下也替代第三层（`DEVICE_APPROVAL_SCOPE=all` 时第三层照查）；关着时这两层照常生效——两种状态都是完整防线，doctor 不把「未开加层」算成缺陷。

第三层（设备信任）对**本机样连接**放行——peer 是 loopback 且 Host 也是 loopback 名。那是第二因子的豁免，不是 token 的豁免。**Host 是客户端填的头**：纯 TCP 转发（`ssh -R`、frp tcp）不按 Host 路由，远程来客自填 `Host: localhost` 即可满足两个条件（peer 本来就是 loopback）。TCP 层面区分不了真本机与隧道转发，故不再往判据里加条件，而是把 `DEVICE_APPROVAL_SCOPE=all` 定成**覆盖全部路径的总开关**（含 Access 那条与本机样那条；2026-09-17 安全审查 H1，`DEVICE-01`）。默认值不变——翻默认等于给既有安装投递一次远程锁死。

Fail-closed 要点：无 token 拒绝启动、路径不可达、审批指纹不符、审批/提问 TTL 到期、重启后 pending 审批。

---

## 7. 改规则时怎么动

| 你想改的 | 动作 |
|----------|------|
| 展示语义 | `display-contracts` 测试 → 实现 → [display-contracts.md](display-contracts.md) |
| 事件名/type | `app/src/shared/protocol.js` → emit/handler/mock → `npm run check` |
| 模块分层 | `check-import-boundaries` 规则 + 拆依赖 |
| n=1 立场 / AD-5 / SP-10 | **先改本文 §2 / §5 与维护者确认**，再开实现 |
| 仅措辞 | 改本文 + 必要时 `CLAUDE.md` / README 导航；跑 `npm run check` |

---

## 8. 速查

```
产品：n=1 单用户 · 终端等价 · 非多租户 · 非共享 TTY（假设面登记簿见 §2，枚举用 grep -rn '// n1:' app/src/ app/public/js/）
架构：单驾驶员 · agent:event 闭合（protocol.js）· viewing 全局单值
状态：新逻辑不进 app.js 顶层 · import 边界硬闸
安全：六层分立（§6）· fail-closed · 推送 body 最小化
展示：不混拼 · 不猜 · 先改 display-contracts 测试
工程：dev 分支 · 宿主机白名单 11 条（§4.2，真相源 guard-host-tests.js）· 其余 docker · check 全绿
债：AD-5 / SP-10 在 n=1 下不做；无新证据不重开
上游：web slash 恒 fork（UP-1，判据＝宿主无 ReportFindings）；只改可见性，别当 bug 修
```
