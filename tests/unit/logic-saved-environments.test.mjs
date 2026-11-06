// 保存的环境：新会话页 chip 该显示哪个环境、列表摘要、默认名字。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  environmentErrorText,
  environmentFromCurrent,
  findMatchingEnvironment,
  formatEnvironmentSummary,
  suggestEnvironmentName,
} from '../../app/public/js/logic.js';

const ENV = { id: 'a', name: '日常', cwd: '/r/app', model: 'opus', effort: 'xhigh', worktree: true };
const CURRENT = { cwd: '/r/app', model: 'opus', effort: 'xhigh', worktree: true };

test('findMatchingEnvironment：四项全等才算当前环境', () => {
  assert.equal(findMatchingEnvironment([ENV], CURRENT), ENV);
  for (const changed of [{ cwd: '/r/other' }, { model: 'sonnet' }, { effort: 'high' }, { worktree: false }]) {
    assert.equal(findMatchingEnvironment([ENV], { ...CURRENT, ...changed }), null, `改了 ${Object.keys(changed)} 还算匹配`);
  }
});

test('findMatchingEnvironment：选择框的空串、default 与环境里的 null 是同一个意思', () => {
  const plain = { ...ENV, model: null, effort: null, worktree: false };
  for (const model of ['', 'default', null, undefined]) {
    assert.equal(findMatchingEnvironment([plain], { cwd: '/r/app', model, effort: '', worktree: false }), plain, `model=${model}`);
  }
});

test('findMatchingEnvironment：没有环境时是 null', () => {
  assert.equal(findMatchingEnvironment([], CURRENT), null);
  assert.equal(findMatchingEnvironment(undefined, CURRENT), null);
});

test('environmentFromCurrent：存进环境前把「跟随默认」归一成 null', () => {
  assert.deepEqual(
    environmentFromCurrent({ cwd: '/r/app', model: 'default', effort: '', worktree: undefined }),
    { cwd: '/r/app', model: null, effort: null, worktree: false },
  );
});

test('formatEnvironmentSummary：文件夹 · 模型 · effort · 新 worktree', () => {
  assert.equal(formatEnvironmentSummary(ENV), 'app · opus · xhigh · 新 worktree');
});

test('formatEnvironmentSummary：没指定的项不留空段，模型写明跟随默认', () => {
  assert.equal(formatEnvironmentSummary({ ...ENV, model: null, effort: null, worktree: false }), 'app · 默认模型');
});

test('formatEnvironmentSummary：文件夹断开时直接说，设置不用再看', () => {
  assert.equal(formatEnvironmentSummary({ ...ENV, available: false }), 'app · 文件夹已断开');
});

test('suggestEnvironmentName：默认用文件夹名，重名就往后编号', () => {
  assert.equal(suggestEnvironmentName('/r/app', []), 'app');
  assert.equal(suggestEnvironmentName('/r/app', [{ name: 'app' }]), 'app 2');
  assert.equal(suggestEnvironmentName('/r/app', [{ name: 'app' }, { name: 'app 2' }]), 'app 3');
});

test('environmentErrorText：已知错误码说人话，未知的不把代码露给用户', () => {
  assert.match(environmentErrorText('duplicate_name'), /同名/);
  assert.match(environmentErrorText('out_of_range'), /文件夹/);
  assert.match(environmentErrorText('disconnected'), /连接/);
  assert.doesNotMatch(environmentErrorText('weird_code'), /weird_code/);
  assert.ok(environmentErrorText(undefined));
});
