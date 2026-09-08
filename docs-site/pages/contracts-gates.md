# 契约与工程门禁
> 事件契约、import 边界、inventory、check 流水线。

- **Part**: 第三部分 · 方法论
- **Reading Time**: ~10 min
- **Estimated Tokens**: ~1583

---

契约与门禁是防止代码库在多会话、重度自动化演化过程中腐化的核心武器。将「口头约定」转化为 `npm run check` 中的硬性拦截卡口，做到违规即红灯。

## npm run check 门禁矩阵

在根目录下执行 `npm run check` 是零 Token、耗时最短（本地通常 5–15 秒）的综合健康检查。它由以下核心环节链接而成：

| 门禁脚本 / 环节 | 守护不变量与拦截范围 | 失效后果 |
| --- | --- | --- |
| npm run lint | ESLint 规则：语法正确性、无未定义引用、禁止死代码 | 代码风格散乱，隐式全局变量泄露 |
| check-import-boundaries.js | 架构分层边界（前后端绝对隔离、shared 为纯叶子、server 为唯一 sink、零循环依赖） | 分层被穿透，模块相互缠绕演变为巨型单体 |
| contract-check.js | 出向 agent:event （27 种）与入向 socket 事件在代码、前端与 Mock 中的双向一致性 | 协议静默失效，前端收不到特定类型事件 |
| check-invariant-ids.js | 测试命名规范： tests/invariants/ 内的用例必须以 // 守护：  声明守护条目 | 不变量与测试脱节，出现无法追踪的假测试 |
| check-destructive-deletes.js | 破坏性删除防护：单文件与递归删除必须可追溯到临时目录（mkdtemp）或标明豁免 | 防止测试代码意外删除真实开发数据 |
| check-playwright-forbidden-patterns.js | E2E 测试反模式：禁止不稳定选择器、无等待断言等脆弱代码 | E2E 测试出现偶发假红，耗费排查精力 |
| repo-inventory.js | 文件树前缀管控：新增文件必须显式归类于受控目录前缀或文档登记 | 临时审计、提案和日志文件悄悄回堆污染主树 |

## 架构分层硬门禁：check-import-boundaries

该脚本对全仓执行静态 AST 依赖分析（包含动态 `import()` 扫描），强制执行以下铁律：

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

产品的 Fail-Closed 是逐条权衡的（如配置读取异常保留 last-good），按盲目拒绝编写会把测试测反。
 
    03 
#### 必须反向证明不恒绿

在 Commit Message 的 `Tested:` 中写明曾注入什么错误使得测试变红。看着漂亮却永不变红的测试比没有更危险。
 
 

## 宿主机只跑白名单，其余进容器

为杜绝类似 2026-08-02 误删本地数据的事故重演，仓库设立了严密的物理隔离界限（由 `tests/gates/guard-host-tests.js` 守卫）：

- 宿主机允许运行白名单 ：仅允许 npm run lint 、 npm run check 、 npm run test:unit 和 npm run test:e2e （打纯内存 Mock Server）。
- 进容器运行的黑盒测试 ：所有会拉起真实后台进程、测试卸载器或执行变异测试的指令（如 test:docker 、 mutate:docker 、 test:invariants:env ），一律强制在 Docker 容器中执行，容器内 HOME 为一次性虚拟挂载，物理切断对开发机家目录的破坏能力。
