// tests/unit/models-cache.test.mjs —— 按 cwd 归键的模型清单缓存（零 token、纯逻辑）。
// 坐实核心不变量：cwd A 的模型清单【绝不】被 cwd B 的视图取到——这正是
// 「切工作区后新会话冒出上个工作区 deepseek 模型」bug 的正解。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createModelsCache,
  createCwdKeyedCache,
  isCwdDefaultModel,
  modelListSignature,
  normalizeSlashCommands,
  resolveSlashCommandsForCwd,
} from '../../app/src/agent/models-cache.js';

const DS = { models: [{ value: 'opus', displayName: 'deepseek-v4-pro[1m]' }] };
const REAL = { models: [{ value: 'opus', displayName: 'Claude Opus 4.8' }] };

test.describe('models-cache：按 cwd 归键、不跨工作区泄漏', () => {
  test('未知 cwd → null（不是空对象、更不是别区清单）', () => {
    const c = createModelsCache();
    assert.equal(c.get('/ws/a'), null);
  });

  test('核心不变量：cwd A 的清单不会被 cwd B 的视图取到', () => {
    const c = createModelsCache();
    c.set('/ws/deepseek', DS);
    assert.equal(c.get('/ws/claude-chat-mobile'), null); // ← 截图 bug 的正解：别区视图取不到
    assert.deepEqual(c.get('/ws/deepseek'), DS);          // 本区视图照常取到
  });

  test('同 cwd 覆盖更新、不增长条目', () => {
    const c = createModelsCache();
    c.set('/ws/a', DS);
    c.set('/ws/a', REAL);
    assert.deepEqual(c.get('/ws/a'), REAL);
    assert.equal(c.size, 1);
  });

  test('cwd 落空被忽略（不进无键桶）', () => {
    const c = createModelsCache();
    c.set('', DS);
    c.set(null, DS);
    c.set(undefined, DS);
    assert.equal(c.size, 0);
    assert.equal(c.get(''), null);
  });

  test('有界：超上限淘汰最旧（防 cwd 异常漂移无界增长）', () => {
    const c = createModelsCache({ max: 3 });
    c.set('/a', DS); c.set('/b', DS); c.set('/c', DS); c.set('/d', DS);
    assert.equal(c.size, 3);
    assert.equal(c.get('/a'), null);       // 最旧被淘汰
    assert.deepEqual(c.get('/d'), DS);     // 最新保留
  });

  test('序列化往返：load(toJSON()) 保形（跨重启持久化）', () => {
    const c = createModelsCache();
    c.set('/ws/a', DS); c.set('/ws/b', REAL);
    const c2 = createModelsCache();
    c2.load(c.toJSON());
    assert.deepEqual(c2.get('/ws/a'), DS);
    assert.deepEqual(c2.get('/ws/b'), REAL);
  });

  test('load 容错：null/undefined/数组/字符串/旧单全局格式 都不抛、不污染', () => {
    const c = createModelsCache();
    c.load(null); c.load(undefined); c.load([1, 2, 3]); c.load('garbage');
    c.load({ models: [] }); // 旧 c.models 单全局格式（无 cwd 键）——values 是 payload 但 key 不是真 cwd
    assert.ok(c.get('/ws/a') === null); // 不会把旧格式误当某 cwd 的清单泄漏给真实 cwd
  });

  test('delete 移除指定 cwd 条目', () => {
    const c = createModelsCache();
    c.set('/ws/a', DS);
    c.set('/ws/b', REAL);
    assert.equal(c.size, 2);
    c.delete('/ws/a');
    assert.equal(c.get('/ws/a'), null);
    assert.deepEqual(c.get('/ws/b'), REAL);
    assert.equal(c.size, 1);
  });

  test('delete 不存在的 cwd 不抛', () => {
    const c = createModelsCache();
    c.delete('/nonexistent');
    c.delete('');
    c.delete(null);
    assert.equal(c.size, 0);
  });
});

// isCwdDefaultModel：判断某次启动上报的 init.model 是否 = cwd 真实默认模型，可否入 defaultModelByCwd 缓存。
// 承重不变量：只有「未 resume（resumeId==null）且未 pin model（pinnedModel===undefined）」的启动，其 init.model
// 才等于「不带 --model 时 CLI 自选的默认」。resume-no-record 虽未 pin，但 init.model 是 CLI 从 jsonl 恢复的
// 会话模型（可能被终端 /model 改过）≠ cwd 默认 → 必须拒，否则污染缓存。
test.describe('isCwdDefaultModel：只采纳「fresh + 未 pin」启动的模型为 cwd 默认', () => {
  // 注：这条判据的现实入口只剩「fresh 新会话首 init」。历史上这里写的是 scout，但 scout 从不发消息、
  // CLI 因此不输出 init，它的 onSessionId 根本不触发（2026-09-10 实测，见 app.js openScoutInstance）。
  test('fresh 启动（resumeId=null, pinned=undefined, model 有值）→ true', () => {
    assert.equal(isCwdDefaultModel({ resumeId: null, pinnedModel: undefined, reportedModel: 'mimo-v2.5-pro[1m]' }), true);
  });
  test('fresh 新会话首 init（同上形状）→ true', () => {
    assert.equal(isCwdDefaultModel({ resumeId: null, pinnedModel: undefined, reportedModel: 'opus' }), true);
  });
  test('resume-no-record（resumeId 有值、未 pin）→ false（防污染：init.model 是会话恢复模型非 cwd 默认）', () => {
    assert.equal(isCwdDefaultModel({ resumeId: 'sess-abc', pinnedModel: undefined, reportedModel: 'sonnet' }), false);
  });
  test('resume-with-pin（resumeId + pinnedModel 都有）→ false', () => {
    assert.equal(isCwdDefaultModel({ resumeId: 'sess-abc', pinnedModel: 'opus', reportedModel: 'opus' }), false);
  });
  test('fresh 但 reportedModel 空（init 未带 model）→ false（不缓存空值）', () => {
    assert.equal(isCwdDefaultModel({ resumeId: null, pinnedModel: undefined, reportedModel: null }), false);
    assert.equal(isCwdDefaultModel({ resumeId: null, pinnedModel: undefined, reportedModel: '' }), false);
  });
  test('入参缺失/空对象安全 → false，不抛', () => {
    assert.equal(isCwdDefaultModel({}), false);
    assert.equal(isCwdDefaultModel(), false);
  });
});

// slash 命令 per-cwd：连接重放 / 切区注入的数据源。核心不变量同 models——A 区列表绝不进 B 区视图。
test.describe('normalizeSlashCommands / resolveSlashCommandsForCwd', () => {
  test('normalize：string[] 原样；{name} 抽名；空/非数组 → null', () => {
    assert.deepEqual(normalizeSlashCommands(['clear', 'model', 'git-commit']), ['clear', 'model', 'git-commit']);
    assert.deepEqual(normalizeSlashCommands([{ name: 'help' }, { name: 'effort', description: 'x' }]), ['help', 'effort']);
    assert.equal(normalizeSlashCommands([]), null);
    assert.equal(normalizeSlashCommands(null), null);
    assert.equal(normalizeSlashCommands('clear'), null);
    assert.equal(normalizeSlashCommands([{ description: 'no name' }, '', null]), null);
  });

  test('resolve：优先本 cwd 缓存；未知 cwd 不回落别区 lastInit', () => {
    const c = createCwdKeyedCache();
    c.set('/ws/a', { slashCommands: ['a-skill', 'clear'] });
    const lastInit = { cwd: '/ws/a', slashCommands: ['a-skill', 'clear', 'model'] };

    assert.deepEqual(resolveSlashCommandsForCwd(c, '/ws/a', lastInit)?.slashCommands, ['a-skill', 'clear']);
    // B 区无缓存、lastInit.cwd≠B → null（旧 #5 整字段剥离的动机：不把 A 区 skill 灌进 B）
    assert.equal(resolveSlashCommandsForCwd(c, '/ws/b', lastInit), null);
  });

  test('resolve：本 cwd 无缓存但 lastInit.cwd 命中 → 回落 lastInit（冷启动种种子）', () => {
    const c = createCwdKeyedCache();
    const lastInit = { cwd: '/ws/a', slashCommands: ['clear', 'model', 'effort'] };
    assert.deepEqual(resolveSlashCommandsForCwd(c, '/ws/a', lastInit)?.slashCommands, ['clear', 'model', 'effort']);
  });

  test('resolve：缓存可直接存 string[]（兼容 load 形态）', () => {
    const c = createCwdKeyedCache();
    c.set('/ws/a', ['clear', 'compact']);
    assert.deepEqual(resolveSlashCommandsForCwd(c, '/ws/a', null)?.slashCommands, ['clear', 'compact']);
  });

  test('resolve：缺 cache / 缺 cwd 安全 → null，不抛', () => {
    assert.equal(resolveSlashCommandsForCwd(null, '/ws/a', null), null);
    assert.equal(resolveSlashCommandsForCwd(createCwdKeyedCache(), '', { cwd: '/ws/a', slashCommands: ['x'] }), null);
    assert.equal(resolveSlashCommandsForCwd(createCwdKeyedCache(), null, null), null);
  });

  // terminalSlashCommands 必须与 slashCommands 同源取出。分成两个函数各自回落，会出现
  // 「命令来自 A 区缓存、隐藏名单来自 B 区 lastInit」的错配——那正是把两者收进一个返回值的理由。
  test('resolve：terminal 名单随命令同源返回，绝不跨源拼接', () => {
    const c = createCwdKeyedCache();
    c.set('/ws/a', { slashCommands: ['clear', 'color'], terminalSlashCommands: ['color'] });
    const lastInit = { cwd: '/ws/b', slashCommands: ['x'], terminalSlashCommands: ['statusline'] };

    const a = resolveSlashCommandsForCwd(c, '/ws/a', lastInit);
    assert.deepEqual(a.slashCommands, ['clear', 'color']);
    assert.deepEqual(a.terminalSlashCommands, ['color'], 'A 区命中缓存时，名单必须来自同一条缓存而非 lastInit');

    // 回落 lastInit 时两者也必须一起来自 lastInit
    const b = resolveSlashCommandsForCwd(createCwdKeyedCache(), '/ws/b', lastInit);
    assert.deepEqual(b.slashCommands, ['x']);
    assert.deepEqual(b.terminalSlashCommands, ['statusline']);
  });

  test('resolve：无 terminal 名单（旧 CLI / 旧缓存）→ 空数组，不是 null', () => {
    // 下游 buildSlashCommandHints 把「空名单」当作「没有要隐藏的」。这里回 null 会让
    // server 的 `...(cmds ? {} : {})` 省略字段，前端保留上一份陈旧名单——刷新后隐藏错命令。
    const c = createCwdKeyedCache();
    c.set('/ws/a', { slashCommands: ['clear'] });
    assert.deepEqual(resolveSlashCommandsForCwd(c, '/ws/a', null).terminalSlashCommands, []);
    c.set('/ws/b', ['clear', 'compact']); // 兼容 load 的裸 string[] 形态
    assert.deepEqual(resolveSlashCommandsForCwd(c, '/ws/b', null).terminalSlashCommands, []);
  });
});

// modelListSignature：清单是否变化 = 「该 cwd 的 CLI 配置是否变了」的代理信号。
// 它是 defaultModelByCwd 唯一的失效判据（scout 拿不到 init，见 app.js openScoutInstance 注释），
// 判错的后果不对称：漏判 → 新会话页一直预显一个当前开不出来的模型名；误判 → 只是少显示一行提示。
test.describe('modelListSignature：按集合比较，供 defaultModelByCwd 失效判定', () => {
  test('同一批模型、顺序不同 → 签名相同（顺序抖动不是配置变更）', () => {
    const a = { models: [{ value: 'opus' }, { value: 'sonnet' }, { value: 'default' }] };
    const b = { models: [{ value: 'default' }, { value: 'opus' }, { value: 'sonnet' }] };
    assert.equal(modelListSignature(a), modelListSignature(b));
    assert.notEqual(modelListSignature(a), ''); // 防「两边都空串」式的假相等
  });

  test('模型集合不同 → 签名不同（换网关后清单必变，这是失效的触发点）', () => {
    const official = { models: [{ value: 'default' }, { value: 'opus[1m]' }, { value: 'sonnet' }] };
    const gateway = { models: [{ value: 'default' }, { value: 'gemini-3.8-flash' }] };
    assert.notEqual(modelListSignature(official), modelListSignature(gateway));
  });

  test('少一个模型也算变（子集不等于相同）', () => {
    const full = { models: [{ value: 'a' }, { value: 'b' }, { value: 'c' }] };
    const less = { models: [{ value: 'a' }, { value: 'b' }] };
    assert.notEqual(modelListSignature(full), modelListSignature(less));
  });

  test('三种元素形态归一：裸字符串 / {value} / {displayName}', () => {
    assert.equal(modelListSignature({ models: ['opus'] }), modelListSignature({ models: [{ value: 'opus' }] }));
    // 无 value 时才回落 displayName；有 value 则以 value 为准（displayName 是给人看的，会随版本改文案）
    assert.equal(modelListSignature({ models: [{ displayName: 'opus' }] }), modelListSignature({ models: ['opus'] }));
    assert.equal(
      modelListSignature({ models: [{ value: 'opus', displayName: 'Claude Opus 4.8' }] }),
      modelListSignature({ models: ['opus'] }),
    );
  });

  test('裸数组形态也接受（payload 可能就是数组本身）', () => {
    assert.equal(modelListSignature([{ value: 'opus' }]), modelListSignature({ models: [{ value: 'opus' }] }));
  });

  test('空 / 非法 payload → 空串：调用方据此【跳过】比较——「不知道」不等于「变了」', () => {
    for (const bad of [null, undefined, {}, { models: null }, { models: [] }, [], 'opus', 42]) {
      assert.equal(modelListSignature(bad), '', `期望空串: ${JSON.stringify(bad)}`);
    }
    // 元素全是空壳时同样落空串，不能拼出一串分隔符冒充「有内容的签名」
    assert.equal(modelListSignature({ models: [{}, { value: '' }, null] }), '');
  });
});
