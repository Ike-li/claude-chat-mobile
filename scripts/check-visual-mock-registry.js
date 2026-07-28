import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const DEFAULT_TARGET = 'tests/e2e/mock/server.js';
const REGISTRY_DISPATCH = 'if (await scenarioRegistry.run(cmd, { activeInst, requestedModel })) return;';

export function findFallbackTestCommandBranches(source) {
  // 不同命令族可以各自先走同一个 registry（例如 ultracode 的显式别名，随后才是
  // test:/demo: 主命令族）。只审计最后一个 dispatch 之后的手写分支；否则会把后一个
  // 命令族的入口本身误报成前一个命令族的 fallback。
  const dispatchIndex = source.lastIndexOf(REGISTRY_DISPATCH);
  if (dispatchIndex === -1) {
    throw new Error(`Missing visual mock scenario registry dispatch: ${REGISTRY_DISPATCH}`);
  }

  const tailStart = dispatchIndex + REGISTRY_DISPATCH.length;
  const firstTailLine = source.slice(0, tailStart).split(/\r?\n/).length;
  const tailLines = source.slice(tailStart).split(/\r?\n/);
  // (?:test|demo) 两个前缀都要认——只加 test: 会漏判新出现的 demo:* 场景族用同一反模式（先 startsWith
  // 分流、registry.run 之后又手写 cmd === 分支），零成本闸门形同虚设。
  const fallbackPattern = /\bcmd\s*(?:={2,3})\s*['"`](?:test|demo):[^'"`]+['"`]|\bcmd\s*\.\s*startsWith\s*\(\s*['"`](?:test|demo):/;

  return tailLines
    .map((line, index) => ({ lineNumber: firstTailLine + index, text: line.trim() }))
    .filter(({ text }) => fallbackPattern.test(text));
}

export function checkVisualMockRegistry(targetPath = DEFAULT_TARGET) {
  const source = readFileSync(targetPath, 'utf8');
  const fallbacks = findFallbackTestCommandBranches(source);
  if (fallbacks.length === 0) return;

  const details = fallbacks
    .map(({ lineNumber, text }) => `${targetPath}:${lineNumber}: ${text}`)
    .join('\n');
  throw new Error(`Found test command fallback branches after scenarioRegistry.run(). Move them into the visual mock scenario registry.\n${details}`);
}

// 用 fileURLToPath + resolve 而不是字符串拼 `file://${argv[1]}`：import.meta.url 是 percent-encoded
// 的 file URL，argv[1] 是裸路径。仓库被 clone 到含空格/中文的目录（或 CI 工作目录含空格）时两者永不
// 相等，这道闸就变成【静默 no-op】——不打印任何东西、exit 0，&& 链照常往下走。仓内其余 6 个门禁脚本
// 用的都是这个健壮写法，只有这一个是字符串拼接。
if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    checkVisualMockRegistry(process.argv[2]);
    console.log('visual mock registry guard OK');
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
