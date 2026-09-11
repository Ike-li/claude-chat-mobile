// tests/unit/disposable-env-gate.test.mjs —— 执行位守卫接线闸的判据
//
// 【为什么这道闸需要自己的测试】它守的东西（那行 import 在不在、在不在第一条）本身极其安静：
// 判据写松了，36 个文件照样"全部合规"，而保护一条都没接上。这正是 check 链里最容易出现的
// 假绿形态——闸绿着，管辖面却是空的。
//
// 【不测什么】main() 的目录扫描与退出码由 check 链每次跑真实文件覆盖；这里只测判据函数。
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSource, GUARDED_DIRS } from '../gates/check-disposable-env-guard.js';

const GUARD_1 = "import '../setup/require-disposable-env.mjs';";
const GUARD_2 = "import '../../setup/require-disposable-env.mjs';";

test.describe('判据：守卫必须存在，且必须是第一条 import', () => {
  test('守卫是第一条 → 合规', () => {
    assert.equal(checkSource(`// 文件头注释\n${GUARD_1}\nimport test from 'node:test';\n`), null);
  });

  test('两种相对深度都认（integration 一层 / invariants/server 两层）', () => {
    assert.equal(checkSource(`${GUARD_2}\nimport x from 'y';\n`), null);
  });

  test('完全没有守卫 → 报缺少', () => {
    assert.match(checkSource("import test from 'node:test';\n"), /缺少执行位守卫/);
  });

  // ★ 这一条是「加了但没生效」的形态：看起来完全正常，保护却是空的。
  test('守卫排在第二条 → 报位置，并点名是谁抢在了前面', () => {
    const why = checkSource(`import { readFileSync } from 'node:fs';\n${GUARD_1}\n`);
    assert.match(why, /第 2 条 import/);
    assert.match(why, /node:fs/, '必须点名抢在前面的那条，否则修的人不知道动什么');
  });

  test('空文件 / 无任何 import → 报缺少（不是「没 import 就不用守」）', () => {
    assert.match(checkSource(''), /缺少执行位守卫/);
    assert.match(checkSource('const x = 1;\n'), /缺少执行位守卫/);
  });
});

test.describe('判据不该被这些形态骗过', () => {
  test('行注释里的 import 不计入顺序', () => {
    assert.equal(checkSource(`// import { a } from 'b';\n${GUARD_1}\nimport c from 'd';\n`), null);
  });

  // ★ 同一行内闭合的块注释必须先剥掉再判定。漏掉这条 import，守卫就会被算成第一条 —— fail-open。
  test('/* 注释 */ import x —— 那条 import 必须计入，不能整行跳过', () => {
    const why = checkSource(`/* 说明 */ import { readFileSync } from 'node:fs';\n${GUARD_1}\n`);
    assert.match(why ?? '', /第 2 条 import/,
      '同行块注释后面的 import 被漏掉了 —— 守卫会被误判成第一条');
  });

  test('块注释里的 import 不计入顺序', () => {
    assert.equal(checkSource(`/*\nimport { a } from 'b';\n*/\n${GUARD_1}\n`), null);
  });

  test('单行块注释不会把后面整段吞掉', () => {
    // 若把 /* ... */ 误判成块注释起点，守卫那行会被当成注释吞掉 → 报缺少
    assert.equal(checkSource(`/* 一行注释 */\n${GUARD_1}\n`), null);
  });

  test('动态 import 不算静态 import，不影响「第一条」的判定', () => {
    assert.equal(checkSource(`${GUARD_1}\nconst m = await import('./x.js');\n`), null);
  });

  // 名字相近的预加载器不是守卫——判据松到认它，等于整道闸失效。
  test('preload-env 不能被当成守卫', () => {
    assert.match(checkSource("import '../setup/preload-env.mjs';\n"), /缺少执行位守卫/);
  });

  test('把守卫写成裸字符串或注释掉都不算数', () => {
    assert.match(checkSource("'../setup/require-disposable-env.mjs';\n"), /缺少执行位守卫/);
    assert.match(checkSource(`// ${GUARD_1}\n`), /缺少执行位守卫/);
  });
});

test('管辖目录表非空，且每条都写了为什么必须进容器', () => {
  assert.ok(GUARDED_DIRS.size >= 3, `管辖面塌了：只剩 ${GUARDED_DIRS.size} 条`);
  for (const [dir, why] of GUARDED_DIRS) {
    assert.ok(why && why.length > 10, `${dir} 的理由太短，看的人无法据此判断新目录该不该进表`);
  }
});
