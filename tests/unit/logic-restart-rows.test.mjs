// tests/unit/logic-restart-rows.test.mjs —— 服务状态面板「重启记录」段的行渲染
//
// 这一段存在的理由：launchd 只保留 LastExitStatus（最后一次怎么退出的），那是**瞬时值**，
// 回答不了「这正常吗」。机主机器上的实证——隧道恒为 -9，因为自建看门狗 com.ccm.tunnel-watch
// 每 30s 检测 en0 的 DHCP 漂移、变了就 kickstart -k（-k 先 SIGKILL）。
// 用瞬时值告警等于每天误报一次，而恒亮的告警会训练用户忽略它。
// 频率 + 时间线才分得清：每天一次是路由器换 IP，一小时内三次才是真出事。
import test from 'node:test';
import assert from 'node:assert/strict';

import { formatAgoShort, formatRestartRows } from '../../public/js/logic.js';

const NOW = 1786600000000;
const HOUR = 3600_000;

test.describe('formatRestartRows', () => {
  test('没有任何记录 → empty（面板显示「暂无记录」而不是空白）', () => {
    assert.equal(formatRestartRows({ restarts: null, now: NOW }).empty, true);
    assert.equal(formatRestartRows({ restarts: { units: [], recent: [] }, now: NOW }).empty, true);
    assert.equal(formatRestartRows({}).empty, true);
  });

  // ★ 机主机器上的真实模式
  test('每天一次的看门狗重启 → 出现在摘要里但不标黄', () => {
    const view = formatRestartRows({
      restarts: {
        units: [{ label: 'com.ccm.tunnel', lastHour: 0, last24h: 1, flapping: false, lastRestartAt: NOW - 2 * HOUR }],
        recent: [],
      },
      now: NOW,
    });
    assert.equal(view.summary.length, 1);
    assert.equal(view.summary[0].alert, false, '例行重启不该标黄');
    assert.match(view.summary[0].text, /24 小时内 1 次/);
    assert.match(view.summary[0].text, /2 小时前/, '要说清上次是什么时候');
  });

  test('1 小时内多次 → 标黄并点明频率', () => {
    const view = formatRestartRows({
      restarts: {
        units: [{ label: 'com.ccm.tunnel', lastHour: 4, last24h: 4, flapping: true, lastRestartAt: NOW - 60_000 }],
        recent: [],
      },
      now: NOW,
    });
    assert.equal(view.summary[0].alert, true);
    assert.match(view.summary[0].text, /1 小时内重启 4 次/);
  });

  test('24 小时内没重启过的 unit 不占位置（面板只列有事的）', () => {
    const view = formatRestartRows({
      restarts: {
        units: [
          { label: 'com.ccm.server', lastHour: 0, last24h: 0, flapping: false, lastRestartAt: null },
          { label: 'com.ccm.tunnel', lastHour: 0, last24h: 2, flapping: false, lastRestartAt: NOW - HOUR },
        ],
        recent: [],
      },
      now: NOW,
    });
    assert.deepEqual(view.summary.map((s) => s.label), ['com.ccm.tunnel']);
  });

  test('时间线按服务端给的顺序渲染，每条带「多久前 + 干了什么」', () => {
    const view = formatRestartRows({
      restarts: {
        units: [],
        recent: [
          { ts: NOW - 10 * 60_000, label: 'com.ccm.tunnel', kind: 'restarted' },
          { ts: NOW - 3 * HOUR, label: 'com.ccm.server', kind: 'stopped' },
          { ts: NOW - 3 * HOUR + 1000, label: 'com.ccm.server', kind: 'started' },
        ],
      },
      now: NOW,
    });
    assert.equal(view.timeline.length, 3);
    assert.match(view.timeline[0].text, /10 分钟前 重启/);
    assert.match(view.timeline[1].text, /3 小时前 停止/);
    assert.match(view.timeline[2].text, /启动/);
  });

  test('未知 kind 不崩，原样显示', () => {
    const view = formatRestartRows({
      restarts: { units: [], recent: [{ ts: NOW, label: 'x', kind: 'weird' }] },
      now: NOW,
    });
    assert.match(view.timeline[0].text, /weird/);
  });
});

test.describe('formatAgoShort', () => {
  test('分钟 / 小时 / 天三档', () => {
    assert.equal(formatAgoShort(30_000), '刚刚');
    assert.equal(formatAgoShort(5 * 60_000), '5 分钟');
    assert.equal(formatAgoShort(3 * HOUR), '3 小时');
    assert.equal(formatAgoShort(50 * HOUR), '2 天');
  });

  test('非法输入不崩', () => {
    assert.equal(formatAgoShort(NaN), '?');
    assert.equal(formatAgoShort(-1), '?');
    assert.equal(formatAgoShort(undefined), '?');
  });
});
