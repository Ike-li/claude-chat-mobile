---
name: ccm-accept
description: 跑 claude-chat-mobile 的验收套件（tests/acceptance，378 条用例）。Use when 机主要跑 CCM 验收或复测某几条、按改动面挑用例复跑、首跑后把判法写回用例的 check、把结果写回清单。
---

# ccm-accept —— CCM 验收编排

套件说明（分档、证据规则、用例格式、目录）在 `tests/acceptance/README.md`，开跑前读一遍。
这里只写执行顺序。所有命令在仓库根跑。

**边界，整轮都成立：**

- 被测对象是 `--target` 指向的专门检出（通常是独立 worktree）与 `ccm-accept*` 容器。生产（3000 端口的 server、主工作区）只读不碰。
- 真模型只在 E3 容器里跑。宿主机上除了 CLAUDE.md 白名单里的测试命令，只跑本套件的调度脚本（`run.mjs`、`env/up.mjs` 等）：A 档重放只连 127.0.0.1 上的 E1/E2 容器、零 token。
- 凭代码、纯函数或文档得出的结论最多 partial。`lib/report.mjs` 落盘时会强制降档，但写结论时就该按这条选证据。

## 步骤

1. **读本机配置。** `tests/acceptance/local/config.json` 里有清单链接（`artifactUrl`）、端口、真机信息。
   缺 `local/` 就先 `node tests/acceptance/setup.mjs`，让机主填好再继续。
   完成：知道被测检出路径、清单链接、这一轮要跑哪些档。

2. **预检。** `node tests/acceptance/preflight.mjs --target <被测检出>`；要跑 C 档再加 `--gateway`。
   完成：没有 ✗。⚠ 项逐条判断会不会挡住这一轮要跑的用例。

3. **定范围。** `node tests/acceptance/run.mjs --check` 必须 0 处问题。再用
   `--list --tier …`、`--cases …` 或 `--changed <ref>` 列出这一轮的用例。
   C 档必须显式写 `--tier C` 才会列出来；`run.mjs` 只列清单、不执行，这一步不花额度。
   完成：一份确定的用例清单，每条知道归哪个档、要哪个环境（`env` 字段）。

4. **起环境。** `node tests/acceptance/env/up.mjs --env <用到的环境> --target <被测检出>` 先看打印出的命令，
   再加 `--yes`。E1/E2 几十秒；E3 首次装机 8–20 分钟，后台等。
   **`--env` 含 E3 / E3proxy / E3cf（或 `all`）时，带 `--yes` 的那条会被钩子拦下来问机主——这就是本轮花额度的确认点**：
   起的是真 claude 容器，机主网关凭据会复制进去，之后在里面跑的每个回合都花真额度。机主不同意就不起 E3，
   要 E3 的用例记 not-run（原因写额度），其余照常。
   完成：`--wait` 返回 0；浏览器能打开各环境首页。

5. **按档执行。**
   - **A**：`node tests/acceptance/run.mjs [--cases …]`。产物在 `local/runs/<UTC 时间戳>/`（`replay.json`、失败的 trace 与截图）。
   - **C / D**：agent 用浏览器执行。内置浏览器为主（先读 built-in-browser skill；手机视口用 `resize_window` 的 mobile 预设）。
     附件上传改用 Claude in Chrome 的 `file_upload`：在机主的 Chrome 里**新开标签**打测试实例，已有标签和生产实例一概不碰。
     `cases/meta.json` 的 `probes` 里 `r: "no"` 的能力（切后台、通知权限、气泡长按、边缘右滑、原生文件框）浏览器做不到，相关用例归 E 档。
     后台一侧：推送看 `docker logs ccm-accept-sink-1`（日志跨重启累积，**按本轮开始时间过滤**），服务端状态用 `docker exec` 进容器查。
   - **E**：按用例逐条念步骤给机主，记下机主报告的现象和截图。
   完成：每条选中的用例都有结论（pass / partial / fail / blocked / not-run）和证据种类，没有一条悬空。

6. **首跑写回判法。** 本轮执行过、`tier` 还是 `null` 的用例，在 `cases/dNN-*.json` 里就地填上：
   - `tier`：这条以后由谁执行（A–E，见 README 的分档表）。
   - `check.how`：一两句写清怎么判——读哪个 DOM、截哪个检查点、查哪条后台记录。写给下一轮的 agent 看，不写结论。
   - `check.kind`：`agent`（C/D）或 `human`（E）。
   判法是确定断言的，写一份 `replay/dNN-<域>.accept.ts`（`import { test, expect } from './fixtures'`，test 标题以 AC 编号开头），
   跑绿之后把期望值故意改错再跑一次、确认它会红，再把这条改成 `tier: "A"`、`check.kind: "replay"`、`check.spec` 指向该文件。
   完成：`node tests/acceptance/run.mjs --check` 仍是 0 处问题。

7. **定档并落盘。** 把本轮结论攒成 JSON 数组（`[{id, status, evidence: [种类…], note}]`，种类见 `lib/evidence.mjs`），
   `node tests/acceptance/lib/report.mjs tests/acceptance/local/runs/<UTC 时间戳> <草稿.json>`。
   完成：`results.json` 与 `report.md` 已写，输出里列出的每条「降档」都核对过——要 pass 就回去补外部可观察证据。

8. **写回清单。** 用 ArtifactData（按需用 ToolSearch 加载）写进 `artifactUrl` 的数据库：`results`（文档 ID = 用例 ID）、
   `observations`、`rounds`。写之前先 `list` 一条看现有字段形状照着写；多条用 `batch`。
   本轮改过 `cases/` 的，再 `node tests/acceptance/lib/export-artifact.mjs` 生成 `local/export/data/*.js`，
   先用 Artifact `read` 读一次清单，再把这五个文件作为 `data/meta.js`、`data/cases-1..4.js` 发布到同一个链接。
   完成：清单页面上本轮用例的结论与 `results.json` 一致。

9. **报告。** 给机主：各状态计数、每条 fail 与它的证据、每条 partial / blocked 的原因（产品缺陷、环境、额度、浏览器能力边界分开说）、
   新观察项，以及没验证到的部分。

10. **收环境。** `node tests/acceptance/env/down.mjs --env all --yes`。不带 `--purge-volumes`，除非机主要求从零开始。
    完成：`docker ps` 里没有 `ccm-accept*` 在跑；E3 运行目录里的凭据副本已删（down 的输出里有）。
