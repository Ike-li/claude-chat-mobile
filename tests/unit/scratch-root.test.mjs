// scratch-root.js：无文件夹会话的 scratch 根按平台落在系统应用数据目录，永远不在 CCM 仓库里。
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { scratchRoot } from '../../app/src/shared/scratch-root.js';

test('macOS：~/Library/Application Support 下（同官方桌面端的 userData/scratch-workspaces）', () => {
  assert.equal(scratchRoot({ platform: 'darwin', home: '/Users/u', env: {} }),
    join('/Users/u', 'Library', 'Application Support', 'claude-chat-mobile', 'scratch-workspaces'));
});

test('Linux：认 XDG_DATA_HOME，缺省 ~/.local/share', () => {
  assert.equal(scratchRoot({ platform: 'linux', home: '/home/u', env: {} }),
    join('/home/u', '.local', 'share', 'claude-chat-mobile', 'scratch-workspaces'));
  assert.equal(scratchRoot({ platform: 'linux', home: '/home/u', env: { XDG_DATA_HOME: '/data/xdg' } }),
    join('/data/xdg', 'claude-chat-mobile', 'scratch-workspaces'));
});

test('Windows：认 LOCALAPPDATA', () => {
  assert.equal(scratchRoot({ platform: 'win32', home: 'C:\\Users\\u', env: { LOCALAPPDATA: 'D:\\local' } }),
    join('D:\\local', 'claude-chat-mobile', 'scratch-workspaces'));
});

test('缺省参数跟随当前 HOME（测试靠 mkdtemp 的 HOME 隔离，不碰真实家目录）', () => {
  const root = scratchRoot();
  assert.ok(root.includes('claude-chat-mobile'), root);
  assert.ok(!root.includes(join('claude-chat-mobile', 'data')), 'scratch 不能落进 CCM 仓库的 data/');
});
