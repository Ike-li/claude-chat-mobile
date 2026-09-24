# 契约与工程门禁
> 事件契约、import 边界、inventory、check 流水线。

- **Part**: 第三部分 · 方法论
- **Reading Time**: ~10 min
- **Estimated Tokens**: ~2329

---

契约与门禁是防止代码库在多会话、重度自动化演化过程中腐化的核心武器。将「口头约定」转化为 `npm run check` 中的硬性拦截卡口，做到违规即红灯。

## npm run check 门禁矩阵

在根目录下执行 `npm run check` 是零 Token、耗时最短的综合检查（desktop 没改动时 Swift 那一环按指纹缓存跳过，约 5 秒）。截至 dev@3f488861 共 16 道，**完整清单以 `package.json` 的 `check` 为准**：产品仓曾在文档里抄过一份清单，漂过两次，已删；新门禁忘了接线会被 `tests/unit/gate-wiring.test.mjs` 抓住。主要环节：

| 门禁脚本 / 环节 | 守护不变量与拦截范围 | 失效后果 |
| --- | --- | --- |
| npm run lint | ESLint 规则：语法正确性、无未定义引用、禁止死代码 | 代码风格散乱，隐式全局变量泄露 |
| check-import-boundaries.js | 架构分层边界（前后端绝对隔离、shared 为纯叶子、server 为唯一 sink、零循环依赖） | 分层被穿透，模块相互缠绕演变为巨型单体 |
| contract-check.js | 出向 agent:event （31 种）与入向 socket 事件在代码、前端与 Mock 中的双向一致性 | 协议静默失效，前端收不到特定类型事件 |
| doc-consistency.js · check-diagram-claims.js | 文档与代码的一致性（含契约计数）；gh-pages 架构图集里的常量、路径与基线 | 文档与图集静默过期 |
| check-n1-assumptions.js · i18n-check.js | n=1 假设面登记簿双向对齐（代码里的 // n1: 标记 ⇔ hard-rules 表）；i18n 孤儿 key | 改立场那天找不全要动的地方；词条漂移 |
| check-shell-pitfalls.js · check-config-gitignored.js | 脚本与 workflow 里的 shell 陷阱； ccm.config.json 等凭据文件必须被 gitignore（CONFIG-03） | 管道静默吞错；凭据被提交进公开仓库 |
| check-disposable-env-guard.js · check-container-config-isolation.js | 破坏性测试目录的首条 import 必须是执行位守卫；容器挂仓库根时必须覆盖 ccm.config.json | 破坏性测试在宿主机上真跑；容器读到生产配置 |
| app-build.js --test-only | desktop 的 Swift typecheck 与 CCMCore 单测 | 菜单栏代码编不过 |
| check-invariant-ids.js | 测试命名规范： tests/invariants/ 内的用例必须以 // 守护：  声明守护条目 | 不变量与测试脱节，出现无法追踪的假测试 |
| check-destructive-deletes.js | 破坏性删除防护：单文件与递归删除必须可追溯到临时目录（mkdtemp）或标明豁免 | 防止测试代码意外删除真实开发数据 |
| check-playwright-forbidden-patterns.js | E2E 反模式：禁止 test.only / skip / fixme 、 networkidle 、 waitForTimeout 与手写的 setTimeout 睡眠 | E2E 测试出现偶发假红，耗费排查精力 |
| repo-inventory.js | 文件树前缀管控：新增文件必须显式归类于受控目录前缀或文档登记 | 临时审计、提案和日志文件悄悄回堆污染主树 |

## 架构分层硬门禁：check-import-boundaries

该脚本对全仓做静态依赖分析（含动态 `import()`），强制执行以下规则，违反时它会自己说清是哪一条：

```
1. 前后端互不 import：app/public/js 与 app/src 严格禁止互相引入（唯一豁免规范化工具 canonicalize.js）。
2. shared 是纯叶子层：app/src/shared 严禁反向引入其他任何后端领域模块。
3. server 是组装根：除入口 app/server.js 和自身外，任何域模块禁止反向依赖 app/src/server。
4. 运行时禁止引入测试与工具：生产代码绝对禁止 import scripts/ 或 tests/。
5. 全局零循环依赖：任何形式的依赖环直接拦截。
```

## 测试体系与防假绿铁律

根据 `docs/testing.md` 的规范，编写与修改测试遵循三大铁律：

 
    01 
#### 测试放哪里唯一判据

在编号表中查得到编号的进 `tests/invariants/` 并标注守护行；查不到进 `tests/unit/` 且不写守护行。
 
    02 
#### 失败方向严格受控

产品的 fail-closed 是逐条选过的：配置 JSON 语法错误要抛错、不回落另一份文件；但 `trusted-devices.json` 瞬时读失败要保留上一份可用的信任表，鉴权通过后 handler 抛 500 不得计入限速。按「所有异常都拒绝」写会把后两条测反。
 
    03 
#### 必须反向证明不恒绿

在 Commit Message 的 `Tested:` 中写明曾注入什么错误使得测试变红。看着漂亮却永不变红的测试比没有更危险。
 
 

## 宿主机只跑白名单，其余进容器

为杜绝类似 2026-08-02 误删本地数据的事故重演，仓库设立了严密的物理隔离界限（由 `tests/gates/guard-host-tests.js` 守卫）：

- 宿主机允许运行白名单 ：仅允许 npm run lint 、 npm run check 、 npm run test:unit 和 npm run test:e2e （打纯内存 Mock Server）。
- 进容器运行的黑盒测试 ：所有会拉起真实后台进程、测试卸载器或执行变异测试的指令（如 test:docker 、 mutate:docker 、 test:invariants:env ），一律强制在 Docker 容器中执行，容器内 HOME 为一次性目录，物理切断对开发机家目录的破坏能力。
- 执行位守卫 ： tests/invariants/env/ 、 tests/invariants/server/ 、 tests/integration/ 下每个文件的首条 import 是 tests/setup/require-disposable-env.mjs ，不在一次性环境里就直接 exit 1； mutate 在 main() 开头调用同一份判据。它把「需要正确归类才能生效」降成「需要刻意绕过才能失效」，但不是物理隔离，真正的隔离仍然是容器。
