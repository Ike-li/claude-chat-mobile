import { readFileSync } from 'node:fs';

const DEFAULT_TARGET = 'scripts/visual-mock-server.js';
const REGISTRY_DISPATCH = 'if (await scenarioRegistry.run(cmd, { activeInst, requestedModel })) return;';

export function findFallbackTestCommandBranches(source) {
  const dispatchIndex = source.indexOf(REGISTRY_DISPATCH);
  if (dispatchIndex === -1) {
    throw new Error(`Missing visual mock scenario registry dispatch: ${REGISTRY_DISPATCH}`);
  }

  const tailStart = dispatchIndex + REGISTRY_DISPATCH.length;
  const firstTailLine = source.slice(0, tailStart).split(/\r?\n/).length;
  const tailLines = source.slice(tailStart).split(/\r?\n/);
  const fallbackPattern = /\bcmd\s*(?:={2,3})\s*['"`]test:[^'"`]+['"`]|\bcmd\s*\.\s*startsWith\s*\(\s*['"`]test:/;

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

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    checkVisualMockRegistry(process.argv[2]);
    console.log('visual mock registry guard OK');
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
