#!/usr/bin/env node
import {
  checkAgentEventContract,
  formatContractProblems,
} from './agent-event-contract.js';

const result = checkAgentEventContract();
const output = formatContractProblems(result);

if (result.problems.length > 0) {
  console.error(output);
  process.exit(1);
}

console.log(output);
