# 验收套件（tests/acceptance）

**机主本机跑、agent 驱动、永不进 CI，不是回归套件。**

回归由 `tests/unit`、`tests/invariants`、`tests/e2e` 守，每个 PR 都跑。这里回答的是另一个问题：
**照着用户看得见的结果，把整个产品按清单验一遍。** 378 条用例，每条是「一个用户看得见的结果 +
一条不看代码就能判的通过标准」（拆分规则见 `cases/meta.json` 的 `stopRule`）。

分工：

| 谁 | 做什么 |
|---|---|
| agent 首跑 | 用浏览器执行用例，**把判法写回用例的 `check`**（DOM 断言、截图检查点、后台查询），不只留在证据文字里 |
| 脚本重放 | 判法确定的用例转成 A 档，之后由 Playwright 重放，零 token |
| agent 复跑 | 只处理重放失败的、需要判断的、本次改动涉及的 |
| 人 | E 档真机；抽查 agent 判的 pass；拍板「请你判断」类观察项 |

编排写在 `skill/SKILL.md`（setup 会把它链到 `.claude/skills/ccm-accept`）。

## 分档（`tier`）

| 档 | 谁执行 | 花不花额度 | 怎么跑 |
|---|---|---|---|
| A | 脚本重放 | 零 token | `node tests/acceptance/run.mjs`（缺省就只选 A） |
| B | 真 CLI + 假上游 | 零 token | **待建**：假 Anthropic 上游还没有 |
| C | 真模型 | **耗机主网关额度** | agent 在 E3 容器里跑真回合。`run.mjs` 要显式写 `--tier C` 才列出来，只列不跑；花额度的确认点在起 E3（见下） |
| D | agent 判断 | 只花 agent 自己的 | agent 用浏览器执行、按 `check.how` 判 |
| E | 人用真机 | — | PWA、锁屏推送、iOS Safari、触摸手势、菜单栏；agent 念步骤、记证据 |
| `null` | 未定档 | — | 首跑时由 agent 定档 |

**真模型只在容器里跑**（E3：从分发包装起的 newuser 容器）。宿主机上不跑真 Claude，也不碰生产
（3000 端口的 server 与主工作区）——被测的是 `--target` 指向的专门检出，通常是一个独立 worktree。
`run.mjs` 与 `env/up.mjs` 是宿主机侧调度：A 档重放只连 127.0.0.1 上的 E1/E2 容器、零 token。

**额度闸在起 E3 那一步，不在 `run.mjs` 上。** `node tests/acceptance/env/up.mjs --env <含 E3 / E3proxy / E3cf，或 all> --yes`
会被 PreToolUse 钩子（`tests/gates/guard-host-tests.js`）拦下来问机主：它起的是真 claude CLI 容器，
机主网关凭据会复制进去，此后在里面跑的每个回合都花真额度。`up.mjs` 缺省 `--env` 是 E1,E2，不带 `--yes`
只打印，都不触发。不放在 `run.mjs` 上，是因为它对 C 档只列清单、不执行：真回合是 agent 用浏览器（或 `docker exec`）在 E3 里
发起的，不经过 `run.mjs`；每一条花钱的路都要先有 E3，把它起起来是钩子唯一稳拦得住的那一步。钩子只认命令文本，
`bash -c`、`docker exec` 里套的写法认不出来，这是已知边界。

## 证据规则

每条结论记下证据种类（`lib/evidence.mjs` 的 `EVIDENCE_KINDS`）：

- 外部可观察：`ui` `dom` `screenshot` `sink`（ntfy 截获端）`cli` `http` `socket` `log` `fs`
- 只能说明「按代码应该如此」：`code` `pure-function` `doc`

**判 pass 却只有后三种证据时，最多算 partial。** 证据为空、种类拼错同样降档。
来历：首轮里 6 条用例界面上走不通，换成纯函数或读代码当证据仍判了 pass，被追问后才降下来。
这条由 `lib/report.mjs` 在落盘时强制执行，不靠 agent 记得。

## 用例格式

`cases/meta.json`：环境（`envs`）、浏览器能力探针结论（`probes`）、已定决策、旅程、24 个功能域、
依据缩写、拆分规则。`cases/dNN-<slug>.json`：每个功能域一份，`{"domain": N, "name": "…", "cases": [...]}`。

| 字段 | 含义 |
|---|---|
| `id` | `AC-NN-NN`，前一个 NN 必须等于所在文件的域号 |
| `t` / `pre` / `st` / `ex` | 测试点 / 前置 / 步骤 / 通过标准（`t` `st` `ex` 不得为空） |
| `b` | 依据（缩写见 `meta.basis`） |
| `env` | 环境代码数组，必须都在 `meta.envs` 里 |
| `p` | `P0` / `P1` / `P2` |
| `m` / `j` / `n` | 设计方法 / 旅程编号数组 / 备注 |
| `tier` | 见上表 |
| `check` | `null`，或 `{kind, how, spec?}`：`kind` 取 `replay`（A 档，`spec` 必填，指向 `replay/*.accept.ts`）、`agent`（C/D 档）、`human`（E 档）；`how` 一两句写清怎么判 |

`node tests/acceptance/run.mjs --check` 校验整个用例库。

## 目录

```
tests/acceptance/
├── README.md
├── setup.mjs              新电脑一键准备
├── preflight.mjs          开跑前检查（只读）
├── run.mjs                入口：选用例、交 A 档给 Playwright、列出其余档
├── cases/                 用例唯一事实源
├── replay/                A 档重放：playwright.config.ts、fixtures.ts、dNN-<域>.accept.ts
├── runbooks/              D/E 档的操作手册，按需建（见 runbooks/README.md）
├── skill/SKILL.md         agent 的编排说明
├── env/                   compose 覆盖层与 up.mjs / down.mjs
├── lib/                   cases · evidence · report · export-artifact
├── local.example/         进仓的模板，只有占位值
└── local/                 ← gitignore：真实配置、凭据、每轮产物 runs/<UTC 时间戳>/、state.json
```

清单页面（私有 artifact）是 `cases/` 的视图：`node tests/acceptance/lib/export-artifact.mjs` 生成
`local/export/data/{meta.js,cases-1..4.js}`，由 agent 发布上去。改用例只改 `cases/*.json`。

## 新电脑

```bash
git clone … && cd claude-chat-mobile && npm ci
node tests/acceptance/setup.mjs          # local.example/ → local/、secrets.json 设 600、链 skill
# 填 tests/acceptance/local/config.json 与 local/secrets.json
node tests/acceptance/preflight.mjs      # 加 --gateway 再探一次网关通不通
```

**`local/` 不随 git 走。** 换电脑时模板和脚本跟着 clone 过来，真实值要自己带过去或重填。
setup 幂等：已有的 `local/` 文件绝不覆盖；`.claude/skills/ccm-accept` 已存在且指向别处时只警告。

填写时会用到的两条命令：

```bash
# 测试专用 VAPID 密钥（填 vapidPublicKey / vapidPrivateKey）
node -e "console.log(JSON.stringify(require('web-push').generateVAPIDKeys(), null, 2))"
# E3 起来后取令牌（填 authTokens.E3；proxy 档把 lan 换成 proxy）
docker exec -w /home/node/claude-chat-mobile ccm-accept-nu-lan-1 node scripts/config.js get AUTH_TOKEN --reveal
```

## 常用命令

```bash
node tests/acceptance/run.mjs --check                 # 校验用例库，打印各档计数
node tests/acceptance/run.mjs --list --tier D         # 只列出，不执行
node tests/acceptance/run.mjs                         # 跑 A 档重放（零 token）
node tests/acceptance/run.mjs --changed origin/dev    # 只选相对 origin/dev 有变化的 A 档用例
node tests/acceptance/env/up.mjs --env E1,E2          # 只打印要执行的 compose 命令
node tests/acceptance/env/up.mjs --env E1,E2 --yes    # 真起
node tests/acceptance/env/up.mjs --env E3 --yes       # 起真 claude 容器：钩子会问机主（花额度）
node tests/acceptance/env/down.mjs --env all --yes    # 收环境（不删卷；要清空加 --purge-volumes）
```

`run.mjs` 在 CI（`GITHUB_ACTIONS` 或任何 `CI=…`）或容器里直接以 1 退出。`--changed` 认的是用例定义
与重放脚本的变化；「改了哪段产品代码 → 该复跑哪些用例」的映射还没有，由 agent 按 diff 自己挑。

`up.mjs` 缺省只打印；`--yes` 才执行。E3 的运行目录每次在系统临时目录下新建（里面有网关凭据副本），
`down.mjs` 停 E3 时删掉那份副本。

## 命名与约束

- 文件名不带 `test` / `spec` 字样；重放脚本叫 `dNN-<域>.accept.ts`，test 标题以 AC 编号开头（`run.mjs` 按编号 `--grep`）。
  不用 `.spec.ts`：在仓库根裸跑 `npx playwright test` 时默认规则会把它收进去。
- 文件头不写不变量编号的守护声明：那是 `tests/invariants/` 的准入行（`check-invariant-ids` 认它），这里的用例不是不变量。
- 递归删除必须追溯到 `mkdtemp`（`check-destructive-deletes` 门禁扫整个 `tests/`）。
- 仓库是公开的：网关地址与端口、模型名、本机路径、令牌、清单链接只进 `local/`，模板里只写占位。
- 工具代码的单测在 `tests/unit/acceptance-*.test.mjs`，只用 mkdtemp 夹具，不读真实 `cases/`：
  改用例是日常操作，不该让 CI 红。

## 为什么没有 npm script

`package.json` 随分发包原样走（`export-ignore` 只裁掉 `tests/` 等目录），装机用户拿到的 `package.json`
里若有 `accept:*`，指向的却是被裁掉的 `tests/acceptance/`，就是一条跑不了的命令。所以一律写
`node tests/acceptance/…`。
