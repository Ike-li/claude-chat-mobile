#!/usr/bin/env node
// tests/gates/contract-check.js —— 事件契约的双向名单闸（check 一环）。
// 守护：PROTO-01（`AGENT_EVENT_TYPES` / `INBOUND_SOCKET_EVENTS` 是唯一名单，后端 emit、
// 后端 listen、前端 handle、假后端四处与名单双向相等。少一个 type = 浏览器静默丢事件）。
// 这条不变量【由门禁守，不由 tests/invariants/ 下的用例守】——它是名单一致性，不是运行时行为；
// 再写一份用例只会造出两份会漂移的清单检查。编号写在这里，是为了让 tests/README.md 的登记表
// 与守护者之间的链接闭合（check-invariant-ids.js 会双向核对）。
import {
  checkAgentEventContract,
  formatContractProblems,
  checkInboundSocketContract,
  formatInboundContractProblems,
  checkFrontendDispatchCoverage,
  formatFrontendDispatchProblems,
} from './agent-event-contract.js';

const outbound = checkAgentEventContract();
const inbound = checkInboundSocketContract();
// 出向的第三条：后端发得出 ≠ 前端接得住。前两条都只看发送侧，漏了 handler 就是静默丢弃。
const dispatch = checkFrontendDispatchCoverage();
const failed = outbound.problems.length > 0 || inbound.problems.length > 0 || dispatch.problems.length > 0;

const output = [
  formatContractProblems(outbound),
  formatInboundContractProblems(inbound),
  formatFrontendDispatchProblems(dispatch),
].join('\n');

if (failed) {
  console.error(output);
  process.exit(1);
}

console.log(output);
