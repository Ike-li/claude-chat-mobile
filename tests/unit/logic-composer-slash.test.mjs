// tests/unit/logic-composer-slash.test.mjs —— composer「/ 斜杠命令」补全列表纯逻辑（零 token）
//
// 被测对象是【补全菜单该显什么】，不是【什么命令允许执行】。两者有意分开：SDK 对
// terminal_slash_commands 的原文要求是 "Phone/remote UIs should hide these from command menus"
// ——隐藏菜单项，不是禁止执行。手输 /color 仍会照常透传给 CLI，这里不拦。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSlashCommandHints } from '../../app/public/js/logic.js';

test.describe('buildSlashCommandHints（斜杠补全候选）', () => {
  test('剔除 terminal 绑定命令：/color /statusline 不进手机补全菜单', () => {
    const out = buildSlashCommandHints({
      commands: ['clear', 'color', 'compact', 'statusline', 'usage'],
      terminalCommands: ['color', 'statusline'],
    });
    assert.deepEqual(out, ['clear', 'compact', 'usage']);
  });

  test('terminalCommands 缺失（旧 CLI 不下发该字段）→ 全量保留，不因此空掉列表', () => {
    // SDK 原文：absent on CLIs that predate the field。缺字段必须等价于「没有要隐藏的」，
    // 而不是「全部隐藏」——后者会让整个补全菜单在旧 CLI 上消失。
    const cmds = ['clear', 'color', 'compact'];
    assert.deepEqual(buildSlashCommandHints({ commands: cmds }), cmds);
    assert.deepEqual(buildSlashCommandHints({ commands: cmds, terminalCommands: [] }), cmds);
    assert.deepEqual(buildSlashCommandHints({ commands: cmds, terminalCommands: null }), cmds);
  });

  test('对象形态 {name,description} 与裸字符串等价（E2E mock 发对象、真 SDK 发字符串）', () => {
    const out = buildSlashCommandHints({
      commands: [{ name: 'clear', description: 'Clear' }, { name: 'color', description: 'Color' }],
      terminalCommands: ['color'],
    });
    assert.deepEqual(out, ['clear']);
  });

  test('prefix 过滤大小写不敏感，且不要求 prefix 带斜杠', () => {
    const commands = ['clear', 'compact', 'usage'];
    assert.deepEqual(buildSlashCommandHints({ commands, prefix: 'c' }), ['clear', 'compact']);
    assert.deepEqual(buildSlashCommandHints({ commands, prefix: 'CO' }), ['compact']);
    assert.deepEqual(buildSlashCommandHints({ commands, prefix: '' }), commands);
  });

  test('本地命令并入且不重复；terminal 名单不影响本地命令', () => {
    // LOCAL_COMMANDS 是前端自己实现的拦截项，与 SDK 的命令定义无关——
    // 即便上游哪天把同名命令标成 terminalOriented，前端这条本地实现仍然可用，不该被剔掉。
    assert.deepEqual(
      buildSlashCommandHints({ commands: ['clear'], localCommands: ['model'] }),
      ['clear', 'model'],
    );
    assert.deepEqual(
      buildSlashCommandHints({ commands: ['clear', 'model'], localCommands: ['model'] }),
      ['clear', 'model'],
      'SDK 已下发同名命令时不得出现两行 /model',
    );
    assert.deepEqual(
      buildSlashCommandHints({ commands: ['clear'], terminalCommands: ['model'], localCommands: ['model'] }),
      ['clear', 'model'],
    );
  });

  test('prefix 同样作用于本地命令', () => {
    assert.deepEqual(
      buildSlashCommandHints({ commands: ['clear'], localCommands: ['model'], prefix: 'mo' }),
      ['model'],
    );
  });

  test('非数组 / 空输入不抛，返回空数组', () => {
    assert.deepEqual(buildSlashCommandHints(), []);
    assert.deepEqual(buildSlashCommandHints({}), []);
    assert.deepEqual(buildSlashCommandHints({ commands: null }), []);
    assert.deepEqual(buildSlashCommandHints({ commands: 'clear' }), []);
    assert.deepEqual(buildSlashCommandHints({ commands: [null, '', { name: '' }, 'clear'] }), ['clear']);
  });
});
