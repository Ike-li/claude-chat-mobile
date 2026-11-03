// app/public/js/app/terminal-state-expiry.js —— 抽屉关着时终端 last-known 的有效期（#398）。
// 钉两件事：满 ttl 撤下；截止时刻只由最后一次观测决定，重复 arm（回前台、反复开关抽屉）不续命。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLastKnownExpiry } from '../../app/public/js/app/terminal-state-expiry.js';

// 手摇时钟：now 可拨，定时器按到期时刻排队，advance 时依次触发
function fakeClock() {
  let t = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimer: id => { timers.delete(id); },
    advance(ms) {
      const until = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, v]) => v.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
      }
      t = until;
    },
  };
}

function mount() {
  const clock = fakeClock();
  const expiry = createLastKnownExpiry({ ttlMs: 60_000, ...clock });
  let expired = 0;
  const onExpire = () => { expired++; };
  return { clock, expiry, onExpire, expired: () => expired };
}

test('最后一次观测满 ttl 才撤下：关抽屉时排的到期不提前、不遗漏', () => {
  const { clock, expiry, onExpire, expired } = mount();
  expiry.observe();             // t=0 抽屉里拿到终端态
  clock.advance(20_000);
  expiry.arm(onExpire);         // t=20s 关抽屉
  clock.advance(39_999);
  assert.equal(expired(), 0, '未满 60s 就撤下了');
  clock.advance(1);
  assert.equal(expired(), 1, '满 60s 仍未撤下');
});

test('重复 arm 不续命：回前台/反复开关抽屉只按同一个截止时刻重排', () => {
  const { clock, expiry, onExpire, expired } = mount();
  expiry.observe();             // t=0
  clock.advance(10_000);
  expiry.arm(onExpire);         // t=10s 关抽屉
  clock.advance(40_000);
  expiry.arm(onExpire);         // t=50s 回前台又走了一次 stop
  clock.advance(10_000);        // t=60s
  assert.equal(expired(), 1, '截止时刻被重复 arm 往后推了');
  clock.advance(60_000);
  assert.equal(expired(), 1, '重排后不应再触发第二次');
});

test('新观测推后截止时刻；已过期的快照 arm 时立即撤下', () => {
  const { clock, expiry, onExpire, expired } = mount();
  expiry.observe();             // t=0
  clock.advance(50_000);
  expiry.observe();             // t=50s 抽屉轮询又拿到一次
  expiry.arm(onExpire);
  clock.advance(59_999);
  assert.equal(expired(), 0, '新观测没有推后截止时刻');
  clock.advance(1);
  assert.equal(expired(), 1);

  const late = mount();
  late.expiry.observe();        // t=0
  late.clock.advance(5 * 60_000);
  late.expiry.arm(late.onExpire); // 页面在后台放了 5 分钟才回来
  late.clock.advance(0);
  assert.equal(late.expired(), 1, '早已过期的快照应立即撤下');
});

test('cancel 后不再触发', () => {
  const { clock, expiry, onExpire, expired } = mount();
  expiry.observe();
  expiry.arm(onExpire);
  expiry.cancel();
  clock.advance(120_000);
  assert.equal(expired(), 0);
});
