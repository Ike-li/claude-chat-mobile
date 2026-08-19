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

// ★ 这个函数返回的是**完整短语**，调用方不再补「前」。此前它混着两类返回值：'刚刚'/'?' 是完整的，
// '5 分钟' 是待补量词，而两个调用点都无条件补 t('前') —— 于是每次重启服务后打开服务状态，
// 那条刚记下的必然显示「刚刚前 启动」。同文件的 formatAgo 一直是把「前」烘焙进每个分支的，照它。
test.describe('formatAgoShort —— 自己就是完整短语', () => {
  test('分钟 / 小时 / 天三档都自带「前」', () => {
    assert.equal(formatAgoShort(5 * 60_000), '5 分钟前');
    assert.equal(formatAgoShort(3 * HOUR), '3 小时前');
    assert.equal(formatAgoShort(50 * HOUR), '2 天前');
  });

  test('★ 一分钟内说「刚刚」，且不能拼出「刚刚前」', () => {
    assert.equal(formatAgoShort(30_000), '刚刚');
  });

  test('非法输入不崩，也不拼出「?前」', () => {
    for (const bad of [NaN, -1, undefined]) assert.equal(formatAgoShort(bad), '?');
  });
});

// 时钟偏移是可达路径：now 来自客户端、e.ts 来自服务端，正向偏移就让差值成负数。
test.describe('formatRestartRows —— 拼出来的整句不能有「刚刚前」/「?前」', () => {
  test('★ 刚记下的那条读作「刚刚 启动」', () => {
    const view = formatRestartRows({
      restarts: { units: [], recent: [{ ts: NOW - 3000, label: 'com.ccm.server', kind: 'started' }] },
      now: NOW,
    });
    assert.doesNotMatch(view.timeline[0].text, /刚刚前/);
    assert.match(view.timeline[0].text, /刚刚 启动/);
  });

  test('★ 客户端时钟落后于服务端时不拼出「?前」', () => {
    const view = formatRestartRows({
      restarts: { units: [], recent: [{ ts: NOW + 60_000, label: 'com.ccm.server', kind: 'restarted' }] },
      now: NOW,
    });
    assert.doesNotMatch(view.timeline[0].text, /\?前/);
  });

  // ★ 「24 小时内 N 次」在这一行是当事实说的，而 N 只数「无法解释的重启」。
  // 一次崩溃 + 三次面板重启会显示成「24 小时内 1 次 · 上次 刚刚」，而「上次」指向的那次
  // 并不在这 1 次里 —— 同一行自相矛盾。手动那部分要么算进去，要么单独说清。
  test('★ 有手动重启时要说清，别让「N 次」与「上次」互相打脸', () => {
    const view = formatRestartRows({
      restarts: {
        units: [{ label: 'com.ccm.server', lastHour: 0, last24h: 1, manual24h: 3, flapping: false, lastRestartAt: NOW - 30_000 }],
        recent: [],
      },
      now: NOW,
    });
    assert.match(view.summary[0].text, /手动/, `要点明其中有手动重启：${view.summary[0].text}`);
    assert.match(view.summary[0].text, /3/, '手动的条数要给出来');
  });

  test('没有手动重启时不多嘴', () => {
    const view = formatRestartRows({
      restarts: { units: [{ label: 'com.ccm.server', lastHour: 0, last24h: 2, manual24h: 0, flapping: false, lastRestartAt: NOW - 30_000 }], recent: [] },
      now: NOW,
    });
    assert.doesNotMatch(view.summary[0].text, /手动/);
  });

  test('旧 server 不带 manual24h → 不崩、也不凭空造出「手动」字样', () => {
    const view = formatRestartRows({
      restarts: { units: [{ label: 'com.ccm.server', lastHour: 0, last24h: 2, flapping: false, lastRestartAt: NOW - 30_000 }], recent: [] },
      now: NOW,
    });
    assert.doesNotMatch(view.summary[0].text, /手动/);
  });

  test('★ 摘要行的「上次 …」同样不带重复的「前」', () => {
    const view = formatRestartRows({
      restarts: { units: [{ label: 'com.ccm.tunnel', lastHour: 0, last24h: 2, flapping: false, lastRestartAt: NOW - 30_000 }], recent: [] },
      now: NOW,
    });
    assert.doesNotMatch(view.summary[0].text, /刚刚前/);
    assert.match(view.summary[0].text, /上次 刚刚/);
  });
});
