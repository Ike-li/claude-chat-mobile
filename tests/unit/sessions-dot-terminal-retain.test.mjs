// tests/unit/sessions-dot-terminal-retain.test.mjs —— #398：抽屉收起后仍保留 terminalStateByDir，
// 好让主界面 #sessionsDot 继续做「终端需要你 / 运行中」的被动感知。
//
// app.js 里 stopSessionPanelRevalidator 是闭包，行为测不到；这条钉住「不得再 clear」的产品决定，
// 以及到期撤下的接线（有效期本身的行为在 terminal-state-expiry.test.mjs）。
// 若以后抽成可测模块，把断言换成行为层，并删掉本文件的源码扫。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { summarizeOtherWorkspaces } from '../../app/public/js/logic.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const appSrc = readFileSync(join(ROOT, 'app/public/js/app.js'), 'utf8');

function extractFunctionBody(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const brace = src.indexOf('{', start);
  assert.notEqual(brace, -1);
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(brace, i + 1);
    }
  }
  assert.fail(`unclosed function ${name}`);
}

test('stopSessionPanelRevalidator: 停轮询但不得 clear terminalStateByDir（#398）', () => {
  const body = extractFunctionBody(appSrc, 'stopSessionPanelRevalidator');
  // 停 timer 仍要做
  assert.match(body, /sessionPanelRevalidateTimer/);
  // 产品决定：保留 last-known，供主界面 #sessionsDot 被动感知
  assert.doesNotMatch(body, /terminalStateByDir\.clear\s*\(/);
  // 抽屉行 cache 的 terminal 字段仍可剥（重开防假「运行中」），与顶栏角标无关
  assert.match(body, /delete copy\.terminal/);
  // 保留不等于永久：关抽屉时排上到期撤下（有效期逻辑的行为测试在 terminal-state-expiry.test.mjs）
  assert.match(body, /terminalStateExpiry\.arm\(expireTerminalState\)/, '关抽屉没排 last-known 的到期撤下');
});

test('updateTerminalStateForDir: 每次 ack 都记一次观测，状态没变也算（#398 有效期起点）', () => {
  const body = extractFunctionBody(appSrc, 'updateTerminalStateForDir');
  const observe = body.indexOf('terminalStateExpiry.observe()');
  const earlyReturn = body.indexOf('if (next === prev) return');
  assert.notEqual(observe, -1, '没有记录观测时刻');
  assert.ok(observe < earlyReturn, '观测须在「状态没变」提前返回之前记录，否则稳定的终端态会被当成过期');
});

test('summarizeOtherWorkspaces: 保留的 terminal_waiting/busy 仍能点亮 #sessionsDot 数据源', () => {
  // 模拟抽屉已关、轮询已停、但 terminalStateByDir→drawerStateForDir 仍留下这些值
  const dirs = ['/cur', '/other'];
  assert.equal(
    summarizeOtherWorkspaces({ '/cur': 'idle', '/other': 'terminal_waiting' }, dirs, '/cur'),
    'terminal_waiting',
  );
  assert.equal(
    summarizeOtherWorkspaces({ '/cur': 'idle', '/other': 'busy' }, dirs, '/cur'),
    'busy',
  );
});
