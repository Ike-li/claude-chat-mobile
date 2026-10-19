// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { ensureComposerReady, expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';
import { ANOTHER_WORKSPACE, openSessionsSidebar, openWorkspaceSession } from '../../helpers/sidebar-ui';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-06 权限审批 allow/deny 与本会话总是允许', async ({ page }) => {
    await gotoMock(page);

    // 1. 发送 test:permission 后显示权限请求 bottom sheet。
    await sendChatMessage(page, 'test:permission');
    await expect(page.locator('#permModal')).toBeVisible();
    await expect(page.locator('#permTool')).toHaveText('run_command');
    await expect(page.locator('#permCwd')).toContainText('/Users/you/code/claude-chat-mobile');
    // UX-001：普通命令去掉 JSON 引号转义，mono 纯文本
    await expect(page.locator('#permInput')).toHaveText('git push origin main');
    await expect(page.locator('#permAlways')).toBeVisible();

    // 2. 点击允许，工具卡片成功。
    await page.locator('#permAllow').click();
    await expect(page.locator('#permModal')).toBeHidden();
    // UX-019：审批留痕必须保留（不许吞）
    await expect(page.locator('#messages')).toContainText('已允许');
    await waitForIdle(page);
    await expect(page.locator('details.toolcard .t-status').last()).toHaveAttribute('aria-label', '成功');
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('Successfully pushed');

    // 3. fresh state 后点击拒绝，工具卡片拒绝。
    await gotoMock(page);
    await sendChatMessage(page, 'test:permission');
    await expect(page.locator('#permModal')).toBeVisible();
    await page.locator('#permDeny').click();
    await expect(page.locator('#permModal')).toBeHidden();
    await waitForIdle(page);
    await expect(page.locator('details.toolcard .t-status').last()).toHaveAttribute('aria-label', '已拒绝');
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('rejected by user');

    await expectNoBrowserErrors(page);
  });

  // 2026-09-22 review P1：前端曾把所有 error 都当成轮次收尾——清掉挂着的审批、工具卡标失败、熄灭 busy。
  // 可有几类 error 并不结束轮次：socket handler 抛错（不带 instanceId，落到当前 tab 上）、轮中切权限档
  // 失败、模型切换失败。服务端那一轮还在等这张审批（30 分钟 TTL），用户却已经没有地方点「允许」了。
  // 这类 error 现在带 endsTurn:false，前端只打一条提示。
  test('P0-06-NOEND 审批挂着时收到不结束轮次的 error：审批仍在，批准后这一轮照常跑完', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:permission-then-noend-error');
    await expect(page.locator('#messages')).toContainText('服务端处理 user:setPermissionMode 出错', { timeout: 5_000 });
    // 按 class 断言而不是 toBeVisible：closeSheet 当场摘掉 sheet-open 再播关闭动画，可见性检查会和动画赛跑，
    // 撞上动画中途就假绿。提示条出现时 error handler 已经跑完，class 状态是确定的。
    await expect(page.locator('#permModal'), '不结束轮次的 error 不得清掉挂着的审批').toHaveClass(/sheet-open/);

    await page.locator('#permAllow').click();
    await expect(page.locator('#permModal')).toBeHidden();
    await waitForIdle(page);
    await expect(page.locator('details.toolcard .t-status').last()).toHaveAttribute('aria-label', '成功');
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('Successfully pushed');

    await expectNoBrowserErrors(page);
  });

  test('P0-06b 本会话总是允许同类操作后不再重复弹审批', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:permission');
    await expect(page.locator('#permModal')).toBeVisible();
    await page.locator('#permAlways').check();
    await page.locator('#permAllow').click();
    await expect(page.locator('#permModal')).toBeHidden();
    await waitForIdle(page);

    await sendChatMessage(page, 'test:permission');
    await waitForIdle(page);
    await expect(page.locator('#permModal')).toBeHidden();
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('Successfully pushed');

    await expectNoBrowserErrors(page);
  });

  test('P0-06c 其它设备解决权限请求后当前审批弹窗自动关闭', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:permission-remote-resolved');
    await expect(page.locator('#permModal')).toBeVisible();
    await expect(page.locator('#permTool')).toHaveText('run_command');
    await expect(page.locator('#permInput')).toContainText('git push origin main');

    await expect(page.locator('#permModal')).toBeHidden();
    await waitForIdle(page);
    await expect(page.locator('details.toolcard .t-status').last()).toHaveAttribute('aria-label', '成功');
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('approved on another trusted device');

    await expectNoBrowserErrors(page);
  });

  test('P0-06d 本会话总是允许不会泄漏到另一会话', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:permission');
    await expect(page.locator('#permModal')).toBeVisible();
    await page.locator('#permAlways').check();
    await page.locator('#permAllow').click();
    await expect(page.locator('#permModal')).toBeHidden();
    await waitForIdle(page);

    await sendChatMessage(page, 'test:tab');
    await waitForIdle(page);
    await openSessionsSidebar(page);
    await openWorkspaceSession(page, ANOTHER_WORKSPACE, 'Another App Concurrency');
    await expect(page.locator('#pillPermText')).toContainText('Plan');

    await sendChatMessage(page, 'test:permission');
    await expect(page.locator('#permModal')).toBeVisible();
    await expect(page.locator('#permTool')).toHaveText('run_command');

    await expectNoBrowserErrors(page);
  });

  test('P0-06e 当前审批轮失败结果会关闭弹窗并恢复输入', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:permission-result-error');
    await expect(page.locator('#permModal')).toBeVisible();
    await expect(page.locator('#permTool')).toHaveText('run_command');
    await expect(page.locator('#permInput')).toContainText('git push origin main');

    await expect(page.locator('#permModal')).toBeHidden({ timeout: 10_000 });
    await waitForIdle(page);
    await expect(page.locator('#messages')).toContainText('出错：mock permission turn failed');
    const failedCard = page.locator('details.toolcard').filter({ hasText: 'run_command' }).last();
    await expect(failedCard.locator('.t-status')).toHaveAttribute('aria-label', '出错');
    await failedCard.locator('summary').click();
    await expect(failedCard.locator('.t-out')).toContainText('mock permission turn failed');

    await sendChatMessage(page, 'test:settings-echo');
    await waitForIdle(page);
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('设置回显：model=');

    await expectNoBrowserErrors(page);
  });

  test('P0-06f 审批弹窗打开时触屏 Enter 不提交且保留换行草稿', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:permission');
    await expect(page.locator('#permModal')).toBeVisible();
    await expect(page.locator('#permInput')).toContainText('git push origin main');
    await expect(page.locator('[data-testid="user-message"]')).toHaveCount(1);

    await page.locator('#input').fill('test:settings-echo');
    await expect(page.locator('#btnSend')).toBeDisabled();
    await expect(page.locator('#btnSend')).toHaveAttribute('title', '请先处理当前审批或选择');
    await page.locator('#input').press('Enter');

    await expect(page.locator('#permModal')).toBeVisible();
    await expect(page.locator('#permInput')).toContainText('git push origin main');
    await expect(page.locator('[data-testid="user-message"]')).toHaveCount(1);
    await expect(page.locator('#input')).toHaveValue('test:settings-echo\n');

    await page.locator('#permDeny').click();
    await expect(page.locator('#permModal')).toBeHidden();
    await waitForIdle(page);
    await expect(page.locator('#input')).toHaveValue('test:settings-echo\n');
    await expect(page.locator('#btnSend')).toBeEnabled();
    await page.locator('#btnSend').click();
    await waitForIdle(page);
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('设置回显：model=');

    await expectNoBrowserErrors(page);
  });

  test('P0-06g 点击审批弹窗遮罩不会关闭或提交背景草稿', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:permission');
    await expect(page.locator('#permModal')).toBeVisible();
    await expect(page.locator('#permInput')).toContainText('git push origin main');
    await expect(page.locator('[data-testid="user-message"]')).toHaveCount(1);

    await page.locator('#input').fill('draft while approving');
    // 取点避开顶栏：审批/提问挂起时导航层抬到 sheet 之上（body.nav-escape），左上角 (12,12)
    // 已归 header —— 那里点下去是切会话，不再是「被遮罩吞掉」。y=140 落在遮罩空白区。
    await page.locator('#permModal').click({ position: { x: 12, y: 140 } });

    await expect(page.locator('#permModal')).toBeVisible();
    await expect(page.locator('#permInput')).toContainText('git push origin main');
    await expect(page.locator('[data-testid="user-message"]')).toHaveCount(1);
    await expect(page.locator('#input')).toHaveValue('draft while approving');
    await expect(page.locator('#btnSend')).toBeDisabled();

    await page.locator('#permDeny').click();
    await expect(page.locator('#permModal')).toBeHidden();
    await waitForIdle(page);
    await expect(page.locator('#input')).toHaveValue('draft while approving');

    await expectNoBrowserErrors(page);
  });

  test('UX-003 审批 sheet 弹出后短暂防误触（pointer-events）', async ({ page }) => {
    // 纯视觉/交互契约：.sheet-arming 下按钮 pointer-events:none；解除后可点。
    // 不依赖真实 350ms 竞态（goto 后事件到达时间不定），直接验证 CSS + 类切换契约。
    await gotoMock(page);
    await sendChatMessage(page, 'test:permission');
    await expect(page.locator('#permModal')).toBeVisible();

    const peWhileArming = await page.locator('#permModal').evaluate((modal) => {
      modal.classList.add('sheet-arming');
      return getComputedStyle(modal.querySelector('#permAllow')).pointerEvents;
    });
    expect(peWhileArming).toBe('none');

    const peAfter = await page.locator('#permModal').evaluate((modal) => {
      modal.classList.remove('sheet-arming');
      return getComputedStyle(modal.querySelector('#permAllow')).pointerEvents;
    });
    expect(peAfter).not.toBe('none');

    // 解除后允许点击走通；等 turn 结束避免污染 worker 内后续用例
    await page.locator('#permDeny').click();
    await expect(page.locator('#permModal')).toBeHidden();
    await waitForIdle(page);
    await expectNoBrowserErrors(page);
  });

  // 验收 O70（AC-09-23）：面板出现 0.5 秒时，在输入框原来的位置点一下就批准了——原来的 350ms 窗口不够长；
  // 而且它只靠 pointer-events，键盘（焦点落到「允许」再回车）照样能批，按钮外观也看不出现在不能点。
  // 取样放在开窗那一刻的 MutationObserver 回调里同步做，不赌 Playwright 往返的耗时：负载高时一次往返
  // 就可能超过 600ms，那样测到的只是「窗口已经过了」。
  test('UX-003b 审批卡弹出后约 600ms 内「允许」「拒绝」不响应点击与键盘，且看得出不能点', async ({ page }) => {
    await gotoMock(page);
    await page.evaluate(() => {
      const modal = document.getElementById('permModal') as HTMLElement;
      const allow = document.getElementById('permAllow') as HTMLButtonElement;
      const deny = document.getElementById('permDeny') as HTMLButtonElement;
      const probe: Record<string, unknown> = { opened: null };
      (window as unknown as { __armProbe: unknown }).__armProbe = probe;
      new MutationObserver(() => {
        if (probe.opened || !modal.classList.contains('sheet-open')) return;
        const opened = performance.now();
        probe.opened = opened;
        probe.allowDisabled = allow.disabled;
        probe.denyDisabled = deny.disabled;
        probe.allowOpacity = Number(getComputedStyle(allow).opacity);
        // 键盘能触发它的前提是它能拿到焦点
        allow.focus();
        probe.allowFocusable = document.activeElement === allow;
        // 程序化点击：禁用的按钮不派发 click；没禁用就会直接走到 answerPerm
        allow.click();
        deny.click();
        new MutationObserver((_records, obs) => {
          if (allow.disabled) return;
          probe.enabledAfterMs = performance.now() - opened;
          obs.disconnect();
        }).observe(allow, { attributes: true, attributeFilter: ['disabled'] });
      }).observe(modal, { attributes: true, attributeFilter: ['class'] });
    });

    await sendChatMessage(page, 'test:permission');
    const readProbe = () => page.evaluate(() => (window as unknown as { __armProbe: Record<string, unknown> }).__armProbe);
    await expect.poll(async () => (await readProbe()).opened, { message: '审批卡应已弹出' }).not.toBeNull();
    const probe = await readProbe();
    expect(probe.allowDisabled, '开窗那一刻「允许」应是禁用的').toBe(true);
    expect(probe.denyDisabled, '开窗那一刻「拒绝」应是禁用的').toBe(true);
    expect(probe.allowFocusable, '防误触期内「允许」不该拿得到焦点（否则回车就能批）').toBe(false);
    expect(probe.allowOpacity as number, '禁用要看得出来').toBeLessThan(1);
    expect(await (await page.request.get('/__approve-log')).json(), '防误触期内的点击不得发出任何审批').toEqual([]);

    await expect(page.locator('#permAllow')).toBeEnabled();
    // 计时起点是开窗回调，它要等 showNextPerm 整段同步代码（含 openSheet 的强制重排）跑完才执行，
    // 比真正上锁晚几到几十毫秒——所以不拿 600 卡。门槛取验收里那一下的时刻：0.5 秒时的点击必须挡住。
    expect((await readProbe()).enabledAfterMs as number, '验收 O70 里 0.5 秒那一下必须落在防误触期内').toBeGreaterThanOrEqual(500);
    expect(Number(await page.locator('#permAllow').evaluate(b => getComputedStyle(b).opacity))).toBe(1);

    await page.locator('#permAllow').click();
    await expect(page.locator('#permModal')).toBeHidden();
    const after = await (await page.request.get('/__approve-log')).json();
    expect(after.map((e: { decision: string }) => e.decision)).toEqual(['allow']);
    await waitForIdle(page);
    await expectNoBrowserErrors(page);
  });

  // 验收 O28（AC-09-08 所批即所行）：前端预检已经算出「展示的不是服务端锚定的那一份」，却仍让人点「允许」。
  // 服务端按锚定指纹判，回传的是篡改后的展示值就 fail-closed 拒跑——用户点了「允许」得到的是一次拒绝，
  // 而他以为自己批准的东西本来就不该被批。现在：「允许」一直禁用，只能拒绝，或刷新重取服务端那一份。
  test('P0-06-INTEGRITY 完整性预检不符时「允许」一直禁用，只能拒绝', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:permission-tampered');
    await expect(page.locator('#permModal')).toBeVisible();
    await expect(page.locator('#permInput')).toHaveText('echo TAMPERED-DISPLAY');
    await expect(page.locator('#permIntegrityWarn')).toBeVisible();
    // 「拒绝」可点 = 防误触期已过：以它为栅栏，下面的「允许」禁用就不是防误触造成的
    await expect(page.locator('#permDeny')).toBeEnabled();
    await expect(page.locator('#permAllow')).toBeDisabled();
    await expect(page.locator('[data-testid="perm-integrity-reload"]')).toBeVisible();

    await page.locator('#permAllow').click({ force: true });
    expect(await (await page.request.get('/__approve-log')).json(), '禁用的「允许」硬点也不能发出审批').toEqual([]);

    await page.locator('#permDeny').click();
    await expect(page.locator('#permModal')).toBeHidden();
    const log = await (await page.request.get('/__approve-log')).json();
    expect(log.map((e: { decision: string }) => e.decision)).toEqual(['deny']);
    await waitForIdle(page);
    await expectNoBrowserErrors(page);
  });

  test('P0-06-INTEGRITY-RELOAD 完整性不符时「刷新重取」拿回服务端那一份，批的就是它', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:permission-tampered');
    await expect(page.locator('#permIntegrityWarn')).toBeVisible();
    await expect(page.locator('#permDeny')).toBeEnabled();

    await page.locator('[data-testid="perm-integrity-reload"]').click();
    // 刷新后的卡片来自服务端待办快照（mock 里那一份没被改写）
    await expect(page.locator('#permInput')).toHaveText('git push origin main');
    await expect(page.locator('#permIntegrityWarn')).toBeHidden();
    await expect(page.locator('#permAllow')).toBeEnabled();
    await page.locator('#permAllow').click();
    await expect(page.locator('#permModal')).toBeHidden();
    const log = await (await page.request.get('/__approve-log')).json();
    expect(log).toHaveLength(1);
    expect(log[0].decision).toBe('allow');
    expect(log[0].op?.args).toBe('git push origin main');
    await waitForIdle(page);
  });

  // 1b：「永久不再问」。CLI 在 canUseTool 的 suggestions 里给出会落盘的规则时（实测样本
  // destination=localSettings），才允许用户把这次批准变成持久规则——SDK 自己写文件，我们不碰。
  //
  // ★ 两条失败方向都在这里钉：
  //   ① 没有可落盘规则时**不得**出现「永久」选项——点了什么也不会发生，比没有更糟；
  //   ② 默认必须停在「仅本会话」——不勾任何东西就悄悄多出一份持久授权，是最坏的形态。
  test('P0-06h 没有可落盘规则时不出现「永久」选项', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:permission');
    await expect(page.locator('#permModal')).toBeVisible();

    await page.locator('#permAlways').check();
    // 勾了「总是允许」也不该冒出范围选择：这次审批根本没有规则可写
    await expect(page.locator('[data-testid="perm-persist-wrap"]')).toBeHidden();

    await expectNoBrowserErrors(page);
  });

  test('P0-06i 有可落盘规则时给「永久」选项，默认仍停在「仅本会话」', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:permission-persistable');
    await expect(page.locator('#permModal')).toBeVisible();

    // 未勾「总是允许」时范围选择不出现——它是那个勾选的细化，不是独立开关
    await expect(page.locator('[data-testid="perm-persist-wrap"]')).toBeHidden();

    await page.locator('#permAlways').check();
    const wrap = page.locator('[data-testid="perm-persist-wrap"]');
    await expect(wrap).toBeVisible();
    // ★ 默认停在「仅本会话」= 改版前的唯一行为，勾选本身不该带来持久授权
    await expect(page.locator('[data-testid="perm-scope-session"]')).toBeChecked();
    await expect(page.locator('[data-testid="perm-scope-persist"]')).not.toBeChecked();
    // 影响面必须写明白：localSettings → 本工作区
    await expect(wrap).toContainText('本工作区');

    // 取消勾选后收起并复位，避免「看不见却仍选着永久」
    await page.locator('#permAlways').uncheck();
    await expect(wrap).toBeHidden();
    await expect(page.locator('[data-testid="perm-scope-session"]')).toBeChecked();

    await expectNoBrowserErrors(page);
  });

  // ★ 持久授权不该有粘性。上一条可能是个无害的 Read，这一条可能是 rm——
  //   第一张卡片选过「永久」，第二张卡片必须回到「仅本会话」。
  //   （HTML 里 value="session" 自带 checked，所以只验首张卡片的默认值是恒绿的假绿；
  //    真正的风险在跨卡片，这条专门走两张。）
  test('P0-06j 「永久」选择不跨审批卡粘住：上一张选过，下一张回到仅本会话', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:permission-persistable');
    await expect(page.locator('#permModal')).toBeVisible();

    await page.locator('#permAlways').check();
    await page.locator('[data-testid="perm-scope-persist"]').check();
    await expect(page.locator('[data-testid="perm-scope-persist"]')).toBeChecked();

    // 用「拒绝」收场：allow + 总是允许会让 mock 记住放行，第二次就不弹审批了
    await page.locator('#permDeny').click();
    await expect(page.locator('#permModal')).toBeHidden();

    await sendChatMessage(page, 'test:permission-persistable');
    await expect(page.locator('#permModal')).toBeVisible();
    // 勾选本身也要复位
    await expect(page.locator('#permAlways')).not.toBeChecked();
    await page.locator('#permAlways').check();
    await expect(page.locator('[data-testid="perm-scope-session"]')).toBeChecked();
    await expect(page.locator('[data-testid="perm-scope-persist"]')).not.toBeChecked();

    await expectNoBrowserErrors(page);
  });

  // 2026-10-11 真会话：Claude in Chrome 的 read_page / find / computer 只带 tabId，卡片上只有工具名和
  // {"tabId":…}，看不出要动哪个网站；「总是允许此类操作」实际回传的是「本会话内允许这个网站」。
  // 第二段走一张普通卡片：标题与勾选文案是按卡片改写的，上一张的改写不得粘到下一张。
  test('P0-06k Claude in Chrome 审批卡片写出网站，勾选文案写明只在本会话放行这个网站', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:permission-chrome');
    await expect(page.locator('#permModal')).toBeVisible();

    await expect(page.locator('[data-testid="perm-title"]')).toBeVisible();
    await expect(page.locator('[data-testid="perm-title"]')).toHaveText('Claude in Chrome 想在 example.org 上读取页面');
    // 原始工具名仍在，标题是补充不是替换
    await expect(page.locator('#permTool')).toHaveText('mcp__claude-in-chrome__read_page');
    await expect(page.locator('[data-testid="perm-always-label"]')).toHaveText('本会话内允许 example.org 上的所有操作');

    await page.locator('#permDeny').click();
    await expect(page.locator('#permModal')).toBeHidden();
    await waitForIdle(page);

    await sendChatMessage(page, 'test:permission');
    await expect(page.locator('#permModal')).toBeVisible();
    await expect(page.locator('#permTool')).toHaveText('run_command');
    await expect(page.locator('[data-testid="perm-title"]'), '普通工具没有这行标题').toBeHidden();
    await expect(page.locator('[data-testid="perm-always-label"]'), '上一张 Chrome 卡片的范围文案不得粘到这张').toHaveText('总是允许此类操作');

    await expectNoBrowserErrors(page);
  });

});
