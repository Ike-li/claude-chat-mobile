// test/sessions.test.mjs —— sessions.js 单测
// sessions.js 在模块初始化时读 data/sessions.json，故用动态 import 在 before() 备份文件后再加载，
// 保证测试在空白状态下运行，after() 恢复原文件。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// 彻底隔离：CCM_SESSIONS_FILE 指向临时文件，单测永不碰真实 data/sessions.json。
// 旧实现用 rename 备份真实文件 + after() 恢复——测试一中断 after 不跑，就把测试数据留在真实文件、污染生产状态。
let S;        // sessions 模块（动态 import）
let TMP_DIR;  // 临时隔离目录

test.describe('sessions.js 单元测试', () => {
  test.before(async () => {
    TMP_DIR = mkdtempSync(join(tmpdir(), 'ccm-sessions-test-'));
    process.env.CCM_SESSIONS_FILE = join(TMP_DIR, 'sessions.json'); // 必须在 import 前设——sessions.js 加载即 load(FILE)
    S = await import('../sessions.js');
  });

  test.after(() => {
    delete process.env.CCM_SESSIONS_FILE;
    if (TMP_DIR) rmSync(TMP_DIR, { recursive: true, force: true });
  });

  // ── getCurrent / setCurrent ──────────────────────────────────────────────

  test('getCurrent: 未知 cwd 返回 null', () => {
    assert.equal(S.getCurrent('/no/such/cwd'), null);
  });

  test('setCurrent + getCurrent: 设置后可取回', () => {
    S.setCurrent('/proj/a', 'sess-001');
    assert.equal(S.getCurrent('/proj/a'), 'sess-001');
  });

  test('setCurrent: 传 null 清除该 cwd 的指针', () => {
    S.setCurrent('/proj/b', 'sess-002');
    assert.equal(S.getCurrent('/proj/b'), 'sess-002');
    S.setCurrent('/proj/b', null);
    assert.equal(S.getCurrent('/proj/b'), null);
  });

  test('setCurrent: 不同 cwd 互不干扰', () => {
    S.setCurrent('/proj/x', 'sess-x');
    S.setCurrent('/proj/y', 'sess-y');
    assert.equal(S.getCurrent('/proj/x'), 'sess-x');
    assert.equal(S.getCurrent('/proj/y'), 'sess-y');
  });

  // ── upsertSession ────────────────────────────────────────────────────────

  test('upsertSession: 新会话插入到列表头部', () => {
    S.upsertSession({ id: 'new-1', title: '第一个', cwd: '/proj/c', model: 'claude-sonnet-4-6' });
    S.upsertSession({ id: 'new-2', title: '第二个', cwd: '/proj/c', model: 'claude-sonnet-4-6' });
    const sessions = S.getState().sessions;
    assert.equal(sessions[0].id, 'new-2');
    assert.equal(sessions[1].id, 'new-1');
  });

  test('upsertSession: 不重复插入同一 id', () => {
    S.upsertSession({ id: 'dedup', title: '去重测试', cwd: '/proj/c', model: null });
    S.upsertSession({ id: 'dedup', title: '再次插入', cwd: '/proj/c', model: null });
    const count = S.getState().sessions.filter(s => s.id === 'dedup').length;
    assert.equal(count, 1);
  });

  test('upsertSession: 更新已有条目的 model 和 lastUsedAt', () => {
    S.upsertSession({ id: 'update-me', title: '原标题', cwd: '/proj/d', model: 'old-model' });
    const before = S.getSession('update-me').lastUsedAt;
    S.upsertSession({ id: 'update-me', title: '新标题', cwd: '/proj/d', model: 'new-model' });
    const after = S.getSession('update-me');
    assert.equal(after.model, 'new-model');
    assert.ok(after.lastUsedAt >= before);
  });

  test('upsertSession: 已有真实标题不被新标题覆盖', () => {
    S.upsertSession({ id: 'keep-title', title: '原始标题', cwd: '/proj/d', model: null });
    S.upsertSession({ id: 'keep-title', title: '试图覆盖', cwd: '/proj/d', model: null });
    assert.equal(S.getSession('keep-title').title, '原始标题');
  });

  test('upsertSession: 占位标题 "新会话" 可被回填', () => {
    S.upsertSession({ id: 'backfill', title: '新会话', cwd: '/proj/d', model: null });
    S.upsertSession({ id: 'backfill', title: '真实标题', cwd: '/proj/d', model: null });
    assert.equal(S.getSession('backfill').title, '真实标题');
  });

  test('upsertSession: 标题超 40 字符截断', () => {
    const long = 'A'.repeat(60);
    S.upsertSession({ id: 'long-title', title: long, cwd: '/proj/e', model: null });
    assert.equal(S.getSession('long-title').title.length, 40);
  });

  test('upsertSession: 同步更新 currentByCwd', () => {
    S.upsertSession({ id: 'curr-sync', title: '同步指针', cwd: '/proj/f', model: null });
    assert.equal(S.getCurrent('/proj/f'), 'curr-sync');
  });

  // ── getSession ────────────────────────────────────────────────────────────

  test('getSession: 找到已存在的会话', () => {
    S.upsertSession({ id: 'find-me', title: '查找', cwd: '/proj/g', model: 'claude-haiku-4-5' });
    const s = S.getSession('find-me');
    assert.ok(s);
    assert.equal(s.id, 'find-me');
    assert.equal(s.cwd, '/proj/g');
    assert.equal(s.model, 'claude-haiku-4-5');
  });

  test('getSession: 不存在的 id 返回 null', () => {
    assert.equal(S.getSession('nonexistent-xyz'), null);
  });

  test('getSession: null 参数返回 null', () => {
    assert.equal(S.getSession(null), null);
    assert.equal(S.getSession(undefined), null);
  });

  // ── getState ─────────────────────────────────────────────────────────────

  test('getState: 返回包含 sessions 数组和 currentByCwd 的对象', () => {
    const state = S.getState();
    assert.ok(Array.isArray(state.sessions));
    assert.equal(typeof state.currentByCwd, 'object');
  });

  // 注：原 defaultModelForCwd 单测已随该函数删除（A1，2026-06-22）——空首页不再推断/显示模型，
  // 改显「不指定（沿用当前）」、首条消息后由 init.model 校正。空首页权限/思考强度档解析在 server.js
  // （新会话用 CLI 启动默认、不继承），属需起服务端的集成行为，不在此纯逻辑单测覆盖。
});
