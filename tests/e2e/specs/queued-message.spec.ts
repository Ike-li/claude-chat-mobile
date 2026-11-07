// helpers: tests/helpers/playwright.ts

import { test, expect, type Page } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';

// 手机端消息排队的前端（app/public/js/app/queued-message.js + logic/queued-message.js）。
// 状态机在真 server（src/server/message-queue.js），经 instances 广播的 queuedMessages 下发。这里测前端：
// 主按钮什么时候变、卡片三态、撤回和取回把话放回哪、服务重启时话怎么交还。
//
// mock 默认不下发 queuedMessages，等于一台没升级的后端（见 QUEUE-OLD）。/__queue-arm 打开，并让当前实例停在一轮在跑；
// 带 oldBackend=1 只开这一轮、不打开排队。这一轮怎么结束由用例用 /__queue-release、/__queue-hold 决定，不等定时器。

const btnSend = (page: Page) => page.locator('#btnSend');
const stopInline = (page: Page) => page.locator('[data-testid="btn-stop-inline"]');
const card = (page: Page) => page.locator('[data-testid="queued-card"]');
const cardStatus = (page: Page) => page.locator('[data-testid="queued-card-status"]');
const cardPreview = (page: Page) => page.locator('[data-testid="queued-card-preview"]');
const cardAction = (page: Page) => page.locator('[data-testid="queued-card-action"]');
const input = (page: Page) => page.locator('#input');

async function openRunningTurn(page: Page, { oldBackend = false } = {}) {
  await gotoMock(page);
  await sendChatMessage(page, 'test:settings-echo');
  await waitForIdle(page);
  await page.request.post(`/__queue-arm${oldBackend ? '?oldBackend=1' : ''}`);
  await expect(btnSend(page)).toHaveAttribute('data-mode', 'stop');
}

async function queueOne(page: Page, text = '接下来跑测试') {
  await input(page).fill(text);
  await expect(btnSend(page)).toHaveAttribute('data-mode', 'queue');
  await btnSend(page).click();
  await expect(card(page)).toBeVisible();
}

test.describe('消息排队', () => {
  test('QUEUE-1 运行中有草稿：主位变排队、停止退到小钮；清空草稿回到停止', async ({ page }) => {
    await openRunningTurn(page);
    await expect(stopInline(page)).toBeHidden();
    await expect(input(page)).toHaveAttribute('placeholder', /可排队一条/);

    await input(page).fill('接下来跑测试');
    await expect(btnSend(page)).toHaveAttribute('data-mode', 'queue');
    await expect(btnSend(page)).toHaveAttribute('aria-label', '排队发送');
    await expect(btnSend(page)).toBeEnabled();
    await expect(stopInline(page)).toBeVisible();

    await input(page).fill('');
    await expect(btnSend(page)).toHaveAttribute('data-mode', 'stop');
    await expect(stopInline(page)).toBeHidden();

    await expectNoBrowserErrors(page);
  });

  test('QUEUE-2 排队：卡片出现、输入框清空、这条不进消息流，请求带 queue 和会话号；回合结束才上屏', async ({ page }) => {
    await openRunningTurn(page);
    await queueOne(page);

    await expect(cardStatus(page)).toContainText('排队中');
    await expect(cardPreview(page)).toHaveText('接下来跑测试');
    await expect(cardAction(page)).toHaveText('撤回');
    await expect(input(page)).toHaveValue('');
    await expect(page.locator('#messages').getByText('接下来跑测试')).toHaveCount(0);
    const log = await (await page.request.get('/__queue-log')).json();
    expect(log).toHaveLength(1);
    expect(log[0].sessionId).toBeTruthy(); // MSG-02：对不上时按 stale 拒收，不改投
    expect(log[0].queue).toBe(true);

    // 占位之后主位回到停止，打字也不再变排队
    await input(page).fill('再来一条');
    await expect(btnSend(page)).toHaveAttribute('data-mode', 'stop');
    await input(page).fill('');

    await page.request.post('/__queue-release');
    await expect(card(page)).toBeHidden();
    await expect(page.locator('#messages').getByText('接下来跑测试')).toHaveCount(1);
    await expect(btnSend(page)).not.toHaveAttribute('data-mode', 'stop');

    await expectNoBrowserErrors(page);
  });

  test('QUEUE-3 撤回：全文回到输入框；输入框有字时拼在后面，不覆盖；回合结束不再发', async ({ page }) => {
    await openRunningTurn(page);
    const long = '长'.repeat(300);
    await queueOne(page, long);
    await expect(cardPreview(page)).toHaveText('长'.repeat(140));

    await input(page).fill('新打的');
    await cardAction(page).click();
    await expect(card(page)).toBeHidden();
    await expect(input(page)).toHaveValue(`新打的\n\n${long}`);

    await page.request.post('/__queue-release');
    await expect(page.locator('#messages').getByText('长长长')).toHaveCount(0);

    await expectNoBrowserErrors(page);
  });

  test('QUEUE-4 占位后点主位的停止：卡片转未发送、说清原因；取回不覆盖输入框', async ({ page }) => {
    await openRunningTurn(page);
    await queueOne(page);

    await input(page).fill('随手打的');
    await expect(btnSend(page)).toHaveAttribute('data-mode', 'stop');
    await btnSend(page).click();
    await expect(cardStatus(page)).toContainText('未发送');
    await expect(cardStatus(page)).toContainText('本轮已停止');
    await expect(cardAction(page)).toHaveText('取回');

    await cardAction(page).click();
    await expect(card(page)).toBeHidden();
    await expect(input(page)).toHaveValue('随手打的\n\n接下来跑测试');

    await expectNoBrowserErrors(page);
  });

  test('QUEUE-4b 有草稿时点小停止钮停的是这一轮，草稿留在输入框', async ({ page }) => {
    await openRunningTurn(page);
    await input(page).fill('还没排的草稿');
    await expect(stopInline(page)).toBeVisible();
    await stopInline(page).click();
    await expect(btnSend(page)).not.toHaveAttribute('data-mode', 'queue');
    await expect(input(page)).toHaveValue('还没排的草稿');
    await expect(card(page)).toBeHidden();

    await expectNoBrowserErrors(page);
  });

  test('QUEUE-5 服务端转未发送：各种原因都说人话，停在卡片上等用户', async ({ page }) => {
    await openRunningTurn(page);
    await queueOne(page);

    await page.request.post('/__queue-hold?reason=other_driver');
    await expect(cardStatus(page)).toContainText('终端或桌面端正在用这个会话');
    await expect(cardAction(page)).toHaveText('取回');

    await expectNoBrowserErrors(page);
  });

  test('QUEUE-6 提交时撞上别的设备占位：话回输入框，说清原因', async ({ page }) => {
    await openRunningTurn(page);
    await page.request.post('/__queue-other-device?silent=1');

    await input(page).fill('我的这条');
    await expect(btnSend(page)).toHaveAttribute('data-mode', 'queue');
    await btnSend(page).click();

    await expect(input(page)).toHaveValue('我的这条');
    await expect(page.getByText('已有一条排队消息，先处理它')).toBeVisible();

    await expectNoBrowserErrors(page);
  });

  test('QUEUE-7 另一台设备排的：卡片一样，撤回拿到全文', async ({ page }) => {
    await openRunningTurn(page);
    await page.request.post('/__queue-other-device');
    await expect(cardPreview(page)).toHaveText('别的设备排的');
    await expect(btnSend(page)).toHaveAttribute('data-mode', 'stop');

    await cardAction(page).click();
    await expect(input(page)).toHaveValue('别的设备排的这句话的全文');
    await expect(card(page)).toBeHidden();

    await expectNoBrowserErrors(page);
  });

  test('QUEUE-7b 撤回时已被别的设备取走：说清楚，不动输入框', async ({ page }) => {
    await openRunningTurn(page);
    await queueOne(page);
    await page.request.post('/__queue-vanish');

    await cardAction(page).click();
    await expect(page.getByText('已被取走或已发出')).toBeVisible();
    await expect(input(page)).toHaveValue('');

    await expectNoBrowserErrors(page);
  });

  test('QUEUE-8 MSG-03：server 重启作废排队消息，话从本地副本交还输入框', async ({ page }) => {
    await openRunningTurn(page);
    await queueOne(page);

    await page.request.post('/__queue-restart');
    await expect(card(page)).toBeHidden();
    await expect(input(page)).toHaveValue('接下来跑测试');
    await expect(page.getByText(/这条排队消息没有发出/)).toBeVisible();

    await expectNoBrowserErrors(page);
  });

  test('QUEUE-9 发出之后本地副本清掉：服务重启不会把已发出的话再放回来', async ({ page }) => {
    await openRunningTurn(page);
    await queueOne(page);
    await page.request.post('/__queue-release');
    await expect(card(page)).toBeHidden();

    await page.request.post('/__queue-restart');
    await expect(input(page)).toHaveValue('');
    const copies = await page.evaluate(() => localStorage.getItem('ccm-queued-v1'));
    expect(JSON.parse(copies ?? '[]')).toEqual([]);

    await expectNoBrowserErrors(page);
  });

  test('QUEUE-11 窄屏：主位、小停止钮、回形针在一行，不换行不溢出；小钮有 44px 热区', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await openRunningTurn(page);
    await input(page).fill('接下来跑测试');
    await expect(stopInline(page)).toBeVisible();

    const send = (await btnSend(page).boundingBox())!;
    const stop = (await stopInline(page).boundingBox())!;
    const attach = (await page.locator('#btnAttach').boundingBox())!;
    expect(stop.y + stop.height / 2).toBeCloseTo(send.y + send.height / 2, 0); // 同一行
    expect(attach.x + attach.width).toBeLessThanOrEqual(stop.x);
    expect(stop.x + stop.width).toBeLessThanOrEqual(send.x);
    expect(send.x + send.width).toBeLessThanOrEqual(375);
    expect(stop.width).toBeCloseTo(26, 0);

    // 热区不能叠到邻居身上：点回形针右缘不能停掉这一轮，点主位左缘不能变成停止（O98 的同一类）
    const hitId = (x: number, y: number) => page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.closest('button')?.id ?? null, [x, y]);
    const midY = stop.y + stop.height / 2;
    expect(await hitId(attach.x + attach.width - 1, midY)).toBe('btnAttach');
    expect(await hitId(send.x + 1, midY)).toBe('btnSend');
    expect(await hitId(stop.x + stop.width / 2, midY)).toBe('btnStopInline');
    expect(await hitId(stop.x + stop.width / 2, midY - 21)).toBe('btnStopInline'); // 纵向够 44px
    expect(await hitId(stop.x + stop.width / 2, midY + 21)).toBe('btnStopInline');

    await queueOne(page, '接下来跑测试'.repeat(40));
    const box = (await card(page).boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(375);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBe(false);

    await expectNoBrowserErrors(page);
  });

  test('QUEUE-12 英文界面：按钮和卡片没有中文', async ({ page }) => {
    await gotoMock(page);
    await page.evaluate(() => localStorage.setItem('ccm_lang', 'en'));
    await page.reload();
    await expect(page.locator('#btnMore')).toBeVisible();
    await sendChatMessage(page, 'test:settings-echo');
    await waitForIdle(page);
    await page.request.post('/__queue-arm');
    await expect(btnSend(page)).toHaveAttribute('data-mode', 'stop');

    await expect(input(page)).toHaveAttribute('placeholder', 'Task running. You can queue one message');
    await input(page).fill('next');
    await expect(btnSend(page)).toHaveAttribute('aria-label', 'Queue this message');
    await expect(stopInline(page)).toHaveAttribute('aria-label', /^[\x20-\x7e]+$/);
    await btnSend(page).click();
    await expect(cardStatus(page)).toHaveText(/^Queued/);
    await expect(cardAction(page)).toHaveText('Withdraw');

    await page.request.post('/__queue-hold?reason=quota_wall');
    await expect(cardStatus(page)).toHaveText(/^Not sent · Usage limit reached/);
    await expect(cardAction(page)).toHaveText('Take back');

    await expectNoBrowserErrors(page);
  });

  // 前端热更新先于后端重启：生产开着 ASSET_HOT_RELOAD，前端拉下来就生效，后端要重启。这段时间 instances 不带
  // queuedMessages，入口不能出现，也不能发 queue：否则草稿被清掉，旧后端再回 busy，用户白按一次。
  test('QUEUE-OLD 后端没升级：入口不出现，行为和没有这个功能时逐字相同', async ({ page }) => {
    await openRunningTurn(page, { oldBackend: true });
    await expect(input(page)).toHaveAttribute('placeholder', '当前任务运行中，完成后可发送');

    await input(page).fill('运行中打的草稿');
    await expect(btnSend(page)).toHaveAttribute('data-mode', 'stop');
    await expect(stopInline(page)).toBeHidden();
    await expect(card(page)).toBeHidden();

    await btnSend(page).click(); // 这里是停止：旧后端上有草稿时点老位置就是停止，和现在一样
    await expect(input(page)).toHaveValue('运行中打的草稿');
    const log = await (await page.request.get('/__queue-log')).json();
    expect(log).toHaveLength(0);

    await expectNoBrowserErrors(page);
  });
});

// 手机上回车是换行，只有物理键盘回车才发送，这两条要用非触屏环境。
test.describe('消息排队 · 物理键盘', () => {
  test.use({ hasTouch: false, isMobile: false, viewport: { width: 1280, height: 800 } });

  test('QUEUE-10 回车：运行中有草稿走排队，占位后提示，话留在输入框', async ({ page }) => {
    await openRunningTurn(page);
    await input(page).fill('回车排队');
    await input(page).press('Enter');
    await expect(card(page)).toBeVisible();
    await expect(cardPreview(page)).toHaveText('回车排队');

    await input(page).fill('第二条');
    await input(page).press('Enter');
    await expect(page.getByText('已有一条排队消息，先处理它')).toBeVisible();
    await expect(input(page)).toHaveValue('第二条');

    await expectNoBrowserErrors(page);
  });

  test('QUEUE-OLD-2 后端没升级：回车不发 queue，提示和草稿都和现在一样', async ({ page }) => {
    await openRunningTurn(page, { oldBackend: true });

    await input(page).fill('运行中打的草稿');
    await input(page).press('Enter');
    await expect(input(page)).toHaveValue('运行中打的草稿');
    await expect(page.getByText('当前任务运行中，完成后可发送').first()).toBeVisible();
    const log = await (await page.request.get('/__queue-log')).json();
    expect(log).toHaveLength(0);

    await expectNoBrowserErrors(page);
  });
});
