// tests/unit/logic-composer-slash.test.mjs —— composer「/ 斜杠命令」补全列表纯逻辑（零 token）
//
// 被测对象是【补全菜单该显什么】，不是【什么命令允许执行】。两者有意分开：SDK 对
// terminal_slash_commands 的原文要求是 "Phone/remote UIs should hide these from command menus"
// ——隐藏菜单项，不是禁止执行。手输 /color 仍会照常透传给 CLI，这里不拦。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSlashCommandHints, hasSlashCommand } from '../../app/public/js/logic.js';

// 候选是 { name, description?, argumentHint? }（#456）；只关心有哪些命令的用例按名字比
const names = out => out.map(c => c.name);

test.describe('buildSlashCommandHints（斜杠补全候选）', () => {
  test('剔除 terminal 绑定命令：/color /statusline 不进手机补全菜单', () => {
    const out = buildSlashCommandHints({
      commands: ['clear', 'color', 'compact', 'statusline', 'usage'],
      terminalCommands: ['color', 'statusline'],
    });
    assert.deepEqual(names(out), ['clear', 'compact', 'usage']);
  });

  test('terminalCommands 缺失（旧 CLI 不下发该字段）→ 全量保留，不因此空掉列表', () => {
    // SDK 原文：absent on CLIs that predate the field。缺字段必须等价于「没有要隐藏的」，
    // 而不是「全部隐藏」——后者会让整个补全菜单在旧 CLI 上消失。
    const cmds = ['clear', 'color', 'compact'];
    assert.deepEqual(names(buildSlashCommandHints({ commands: cmds })), cmds);
    assert.deepEqual(names(buildSlashCommandHints({ commands: cmds, terminalCommands: [] })), cmds);
    assert.deepEqual(names(buildSlashCommandHints({ commands: cmds, terminalCommands: null })), cmds);
  });

  test('对象形态带出说明与参数提示；裸字符串（旧缓存）只有名字', () => {
    const out = buildSlashCommandHints({
      commands: [
        { name: 'clear', description: 'Clear' },
        { name: 'color', description: 'Color' },
        { name: 'review', description: 'Review a PR', argumentHint: '<pr>' },
        'compact',
      ],
      terminalCommands: ['color'],
    });
    assert.deepEqual(out, [
      { name: 'clear', description: 'Clear' },
      { name: 'review', description: 'Review a PR', argumentHint: '<pr>' },
      { name: 'compact' },
    ]);
  });

  // SDK SlashCommand.aliases：/cost、/stats 都解析到 /usage。终端里输入 /cost 能找到它，手机上也要能
  test('前缀也匹配别名：输入 /cos 看得到 /usage，选中的仍是命令本名', () => {
    const commands = [{ name: 'usage', description: 'Show usage', aliases: ['cost', 'stats'] }, { name: 'clear' }];
    assert.deepEqual(buildSlashCommandHints({ commands, prefix: 'cos' }), [{ name: 'usage', description: 'Show usage' }]);
    assert.deepEqual(names(buildSlashCommandHints({ commands, prefix: 'ST' })), ['usage']);
    assert.deepEqual(names(buildSlashCommandHints({ commands, prefix: 'cl' })), ['clear']);
  });

  test('prefix 过滤大小写不敏感，且不要求 prefix 带斜杠', () => {
    const commands = ['clear', 'compact', 'usage'];
    assert.deepEqual(names(buildSlashCommandHints({ commands, prefix: 'c' })), ['clear', 'compact']);
    assert.deepEqual(names(buildSlashCommandHints({ commands, prefix: 'CO' })), ['compact']);
    assert.deepEqual(names(buildSlashCommandHints({ commands, prefix: '' })), commands);
  });

  test('本地命令并入且不重复；terminal 名单不影响本地命令', () => {
    // LOCAL_COMMANDS 是前端自己实现的拦截项，与 SDK 的命令定义无关——
    // 即便上游哪天把同名命令标成 terminalOriented，前端这条本地实现仍然可用，不该被剔掉。
    assert.deepEqual(
      buildSlashCommandHints({ commands: ['clear'], localCommands: [{ name: 'model', description: '切换模型' }] }),
      [{ name: 'clear' }, { name: 'model', description: '切换模型' }],
    );
    assert.deepEqual(
      buildSlashCommandHints({ commands: [{ name: 'clear' }, { name: 'model', description: 'Set the model' }], localCommands: [{ name: 'model', description: '切换模型' }] }),
      [{ name: 'clear' }, { name: 'model', description: 'Set the model' }],
      'SDK 已下发同名命令时不得出现两行 /model，说明用 SDK 那份',
    );
    assert.deepEqual(
      names(buildSlashCommandHints({ commands: ['clear'], terminalCommands: ['model'], localCommands: ['model'] })),
      ['clear', 'model'],
    );
  });

  test('prefix 同样作用于本地命令', () => {
    assert.deepEqual(
      names(buildSlashCommandHints({ commands: ['clear'], localCommands: ['model'], prefix: 'mo' })),
      ['model'],
    );
  });

  test('非数组 / 空输入不抛，返回空数组', () => {
    assert.deepEqual(buildSlashCommandHints(), []);
    assert.deepEqual(buildSlashCommandHints({}), []);
    assert.deepEqual(buildSlashCommandHints({ commands: null }), []);
    assert.deepEqual(buildSlashCommandHints({ commands: 'clear' }), []);
    assert.deepEqual(names(buildSlashCommandHints({ commands: [null, '', { name: '' }, 'clear'] })), ['clear']);
  });
});

// /model、/rewind 的本地拦截看「CLI 有没有这个命令」：有就让位透传。清单从 string[] 变成对象之后，
// 照旧用 includes('model') 永远是 false，本地选择器会把 CLI 自己的 /model 截走（真机 init 清单里有 model）
test.describe('hasSlashCommand（按名字判断清单里有没有某个命令）', () => {
  test('对象与裸字符串都认；别名不算', () => {
    assert.equal(hasSlashCommand([{ name: 'model', description: 'Set the model' }], 'model'), true);
    assert.equal(hasSlashCommand(['clear', 'model'], 'model'), true);
    assert.equal(hasSlashCommand([{ name: 'usage', aliases: ['model'] }], 'model'), false);
    assert.equal(hasSlashCommand(null, 'model'), false);
  });
});
