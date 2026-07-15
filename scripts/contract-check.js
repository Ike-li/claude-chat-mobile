#!/usr/bin/env node
import {
  checkAgentEventContract,
  formatContractProblems,
  checkInboundSocketContract,
  formatInboundContractProblems,
} from './agent-event-contract.js';

const outbound = checkAgentEventContract();
const inbound = checkInboundSocketContract();
const failed = outbound.problems.length > 0 || inbound.problems.length > 0;

const output = [formatContractProblems(outbound), formatInboundContractProblems(inbound)].join('\n');

if (failed) {
  console.error(output);
  process.exit(1);
}

console.log(output);
