#!/usr/bin/env node
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
