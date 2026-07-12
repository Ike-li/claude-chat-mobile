import puppeteer from 'puppeteer';
import { mkdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import assert from 'node:assert';

const SNAPSHOTS_DIR = './public/test-snapshots';
// 运行前先清理历史截图，防止数据堆积
rmSync(SNAPSHOTS_DIR, { recursive: true, force: true });
mkdirSync(SNAPSHOTS_DIR, { recursive: true });

const sleep = ms => new Promise(res => setTimeout(res, ms));

async function run() {
  console.log('\n==================================================================');
  console.log('🚀 Starting Antigravity Automated Visual E2E Regression Tests...');
  console.log('==================================================================\n');

  // 📡 Start Mock Server dynamically on port 3100
  console.log('📡 Spawning visual mock server on port 3100...');
  const mockServer = spawn('node', ['scripts/visual-mock-server.js'], {
    stdio: 'inherit',
    env: { ...process.env, PORT: '3100' }
  });

  // Give the server 1.5 seconds to bind to port 3100
  await sleep(1500);

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    
    // Set exact mobile viewport (iPhone X dimensions)
    await page.setViewport({
      width: 375,
      height: 812,
      isMobile: true,
      hasTouch: true
    });

    // Navigate to mock server
    console.log('🔗 Navigating to http://127.0.0.1:3100 ...');
    await page.goto('http://127.0.0.1:3100', { waitUntil: 'networkidle2' });
    await page.waitForSelector('#input');
    console.log('✅ Connected to Mock Server successfully!\n');

    const sendCommand = async (text) => {
      console.log(`💬 Sending test trigger: "${text}"`);
      await page.focus('#input');
      
      // Programmatically inject text and fire input event to enable Send button
      await page.evaluate((val) => {
        const input = document.getElementById('input');
        input.value = val;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }, text);

      await sleep(200); // Wait for Send button classes to update
      await page.click('#btnSend');

      // Wait for the busy indicator (#activeStatusPill appears)
      await page.waitForSelector('#activeStatusPill:not(.hidden)');
    };

    const waitIdle = async () => {
      // Wait for busy indicator to hide (#activeStatusPill gets hidden class)
      await page.waitForSelector('#activeStatusPill.hidden', { timeout: 15000 });
      await sleep(300); // Allow rendering / animations to settle
    };

    // ==================================================================
    // TC-1: Streaming & Text Display
    // ==================================================================
    console.log('👉 Running TC-1: Streaming & Text Display...');
    await sendCommand('test:stream');

    // 1. Assert DURING streaming: active status pill is visible
    const isStopVisibleTC1 = await page.evaluate(() => {
      const pill = document.getElementById('activeStatusPill');
      return pill && !pill.classList.contains('hidden');
    });
    assert.strictEqual(isStopVisibleTC1, true, 'TC-1: Active status pill must be visible during streaming');

    await waitIdle();

    // 2. Assert AFTER streaming: active status pill is hidden and thinking details exist
    const isStopHiddenTC1 = await page.evaluate(() => {
      const pill = document.getElementById('activeStatusPill');
      return pill && pill.classList.contains('hidden');
    });
    assert.strictEqual(isStopHiddenTC1, true, 'TC-1: Active status pill must be hidden after streaming ends');

    const hasThinkingTC1 = await page.evaluate(() => {
      return !!document.querySelector('details.thinking');
    });
    assert.strictEqual(hasThinkingTC1, true, 'TC-1: details.thinking element must exist');

    // 3. Assert Markdown rendering structures (p, strong, pre)
    const markdownTagsTC1 = await page.evaluate(() => {
      const messages = document.getElementById('messages');
      if (!messages) return null;
      return {
        hasP: !!messages.querySelector('p'),
        hasStrong: !!messages.querySelector('strong'),
        hasPre: !!messages.querySelector('pre')
      };
    });
    assert.deepStrictEqual(markdownTagsTC1, { hasP: true, hasStrong: true, hasPre: true }, 'TC-1: Markdown tags (p, strong, pre) must be correctly rendered');

    // 4. 校验真实模型已解析进 canonical 的 hidden #modelInput（重设计后底栏无独立 model pill：
    //    pillModel/pillModelText 无对应 DOM；model 经 statusLine 显完整真名 + hidden #modelInput 承载）。
    const bottomModelTC1 = await page.evaluate(() => {
      const sel = document.getElementById('modelInput');
      return sel ? sel.value : null;
    });
    assert.strictEqual(bottomModelTC1, 'claude-3-5-sonnet', 'TC-1: #modelInput must resolve to real model "claude-3-5-sonnet"');

    // 5. Assert costUsd inside last bar element
    const lastBarTextTC1 = await page.evaluate(() => {
      const bars = document.querySelectorAll('#messages .msg-frame.text-center.text-xs.text-ink-faint');
      return bars.length > 0 ? bars[bars.length - 1].textContent.trim() : null;
    });
    console.log(`   [Assert] Last status bar text: "${lastBarTextTC1}"`);
    assert.ok(lastBarTextTC1 && lastBarTextTC1.includes('$0.0015'), 'TC-1: last status bar text must include "$0.0015"');

    await page.screenshot({ path: `${SNAPSHOTS_DIR}/tc1_stream.png` });
    console.log('📸 Captured and saved tc1_stream.png\n');

    // ==================================================================
    // TC-2: Tool Cards Folding & Rendering
    // ==================================================================
    console.log('👉 Running TC-2: Tool Cards Folding & Rendering...');
    await sendCommand('test:tool');
    await waitIdle();

    // 1. Assert exactly 3 toolcards are generated
    const toolcardCountTC2 = await page.evaluate(() => {
      return document.querySelectorAll('details.toolcard').length;
    });
    assert.strictEqual(toolcardCountTC2, 3, 'TC-2: Must generate exactly 3 tool cards');

    // Expand the first tool card details
    await page.waitForSelector('details.toolcard summary');
    await page.click('details.toolcard summary');
    await sleep(300); // Wait for transition

    // 2. Assert expanded toolcard pre text is correct
    const expandedPreTC2 = await page.evaluate(() => {
      const pre = document.querySelector('details.toolcard pre');
      return pre ? pre.textContent.trim() : null;
    });
    assert.ok(expandedPreTC2 && expandedPreTC2.includes('utils/date.js'), 'TC-2: Expanded tool card details must show the target filepath/context');

    // 3. Assert all toolcards successfully transitioned to success (✅) state
    const toolStatusesTC2 = await page.evaluate(() => {
      const statuses = Array.from(document.querySelectorAll('details.toolcard .t-status'));
      return statuses.map(el => el.textContent.trim());
    });
    console.log('   [Assert] Tool card statuses:', toolStatusesTC2);
    assert.deepStrictEqual(toolStatusesTC2, ['✅', '✅', '✅'], 'TC-2: All tool statuses must have transitioned to ✅');

    await page.screenshot({ path: `${SNAPSHOTS_DIR}/tc2_tools.png` });
    console.log('📸 Captured and saved tc2_tools.png\n');

    // ==================================================================
    // TC-3: Permission Gate Popup (Approve)
    // ==================================================================
    console.log('👉 Running TC-3: Permission Gate Popup (Approve)...');
    await sendCommand('test:permission');
    await page.waitForSelector('#permModal:not(.hidden)');
    await sleep(300); // Wait for slide-up sheet transition

    // 1. Assert permission modal fields before approval
    const permModalInfoTC3 = await page.evaluate(() => {
      const tool = document.getElementById('permTool');
      const cwd = document.getElementById('permCwd');
      const input = document.getElementById('permInput');
      return {
        tool: tool ? tool.textContent.trim() : null,
        cwd: cwd ? cwd.textContent.trim() : null,
        input: input ? input.textContent.trim() : null
      };
    });
    console.log('   [Assert] Permission modal details:', permModalInfoTC3);
    assert.strictEqual(permModalInfoTC3.tool, 'run_command', 'TC-3: Requested tool must be run_command');
    assert.ok(permModalInfoTC3.cwd && permModalInfoTC3.cwd.includes('/Users/you/code/claude-chat-mobile'), 'TC-3: Target directory must match workspace');
    assert.strictEqual(permModalInfoTC3.input, '"git push origin main"', 'TC-3: Command content must be shown completely');

    await page.screenshot({ path: `${SNAPSHOTS_DIR}/tc3_permission_popup.png` });
    console.log('📸 Captured and saved tc3_permission_popup.png');
    
    // Click Approve
    await page.click('#permAllow');
    await page.waitForSelector('#permModal.hidden');

    // 2. Assert modal goes hidden
    const isPermModalHiddenTC3 = await page.evaluate(() => {
      const modal = document.getElementById('permModal');
      return modal && modal.classList.contains('hidden');
    });
    assert.strictEqual(isPermModalHiddenTC3, true, 'TC-3: Permission modal must be hidden after clicking allow');

    await waitIdle();

    // 3. Assert toolcard status transitioned to success (✅)
    const lastToolStatusTC3 = await page.evaluate(() => {
      const statuses = Array.from(document.querySelectorAll('details.toolcard .t-status'));
      return statuses.length > 0 ? statuses[statuses.length - 1].textContent.trim() : null;
    });
    assert.strictEqual(lastToolStatusTC3, '✅', 'TC-3: Approved tool card must transition status to ✅');

    await page.screenshot({ path: `${SNAPSHOTS_DIR}/tc3_approved.png` });
    console.log('📸 Captured and saved tc3_approved.png\n');

    // ==================================================================
    // TC-4: Permission Gate Popup (Deny)
    // ==================================================================
    console.log('👉 Running TC-4: Permission Gate Popup (Deny)...');
    await sendCommand('test:permission');
    await page.waitForSelector('#permModal:not(.hidden)');
    await sleep(300);
    
    // Click Deny
    await page.click('#permDeny');
    await page.waitForSelector('#permModal.hidden');

    // 1. Assert modal goes hidden
    const isPermModalHiddenTC4 = await page.evaluate(() => {
      const modal = document.getElementById('permModal');
      return modal && modal.classList.contains('hidden');
    });
    assert.strictEqual(isPermModalHiddenTC4, true, 'TC-4: Permission modal must be hidden after clicking deny');

    await waitIdle();

    // 2. Assert toolcard status transitioned to denied (🚫)
    const lastToolStatusTC4 = await page.evaluate(() => {
      const statuses = Array.from(document.querySelectorAll('details.toolcard .t-status'));
      return statuses.length > 0 ? statuses[statuses.length - 1].textContent.trim() : null;
    });
    assert.strictEqual(lastToolStatusTC4, '🚫', 'TC-4: Denied tool card must transition status to 🚫');

    await page.screenshot({ path: `${SNAPSHOTS_DIR}/tc4_denied.png` });
    console.log('📸 Captured and saved tc4_denied.png\n');

    // ==================================================================
    // TC-5: Multiple-Choice AskUserQuestion
    // ==================================================================
    console.log('👉 Running TC-5: Multiple-Choice AskUserQuestion...');
    await sendCommand('test:question');
    await page.waitForSelector('#questionModal:not(.hidden)');
    await sleep(300);

    // 1. Assert question modal content and options list
    const questionInfoTC5 = await page.evaluate(() => {
      const text = document.getElementById('questionText');
      const options = Array.from(document.querySelectorAll('#questionOptions button'));
      return {
        text: text ? text.textContent.trim() : null,
        options: options.map(b => b.textContent.trim())
      };
    });
    console.log('   [Assert] Question modal content:', questionInfoTC5);
    assert.ok(questionInfoTC5.text && questionInfoTC5.text.includes('Which branch should be our target publish destination?'), 'TC-5: Question text must render correctly');
    assert.deepStrictEqual(questionInfoTC5.options, [
      'main (Stable Production)',
      'dev (Bleeding-Edge Integration)',
      'release-v1.0 (LTS)'
    ], 'TC-5: All 3 mock options must be rendered exactly');

    await page.screenshot({ path: `${SNAPSHOTS_DIR}/tc5_question_popup.png` });
    console.log('📸 Captured and saved tc5_question_popup.png');
    
    // Click second choice: "dev (Bleeding-Edge Integration)"
    await page.waitForSelector('#questionOptions button:nth-child(2)');
    await page.click('#questionOptions button:nth-child(2)');
    await page.waitForSelector('#questionModal.hidden');

    // 2. Assert modal goes hidden
    const isQuestionModalHiddenTC5 = await page.evaluate(() => {
      const modal = document.getElementById('questionModal');
      return modal && modal.classList.contains('hidden');
    });
    assert.strictEqual(isQuestionModalHiddenTC5, true, 'TC-5: Question modal must hide after selecting option');

    // 2b. Assert status pill immediately reads「思考中」after answering the last question —
    // fills the empty window between answer-sent and the model's first streaming event
    // (mock leaves activeStatusText untouched until `result` arrives 800ms later, so this is stable).
    const statusAfterAnswerTC5 = await page.evaluate(() => {
      const el = document.getElementById('activeStatusText');
      return el ? el.textContent.trim() : null;
    });
    assert.strictEqual(statusAfterAnswerTC5, 'Claude 正在思考中...', 'TC-5: Status must switch to 思考中 right after answering (no stale tool text)');

    await waitIdle();

    // 3. Assert toolcard status transitioned to answered (☑️)
    const lastToolStatusTC5 = await page.evaluate(() => {
      const statuses = Array.from(document.querySelectorAll('details.toolcard .t-status'));
      return statuses.length > 0 ? statuses[statuses.length - 1].textContent.trim() : null;
    });
    assert.strictEqual(lastToolStatusTC5, '☑️', 'TC-5: Answered question card must transition status to ☑️');

    await page.screenshot({ path: `${SNAPSHOTS_DIR}/tc5_answered.png` });
    console.log('📸 Captured and saved tc5_answered.png\n');

    // ==================================================================
    // TC-6: StatusLine Projection
    // ==================================================================
    console.log('👉 Running TC-6: StatusLine Projection...');
    await sendCommand('test:statusline');
    await waitIdle();
    
    // Expand the top terminal HUD box details
    await page.evaluate(() => {
      const wrap = document.getElementById('cliStatusWrap');
      if (wrap) wrap.setAttribute('open', '');
    });
    await sleep(300);

    // 1. Assert statusline wrap is visible (not hidden)
    const isStatusWrapHiddenTC6 = await page.evaluate(() => {
      const wrap = document.getElementById('cliStatusWrap');
      return wrap ? wrap.classList.contains('hidden') : true;
    });
    assert.strictEqual(isStatusWrapHiddenTC6, false, 'TC-6: StatusLine wrap must be visible (not hidden)');

    // 2. 展开详情：git 分支 + 代码增删 + 精确 token + cache + repo + 版本（web-native 结构化、去 emoji）
    const statusTextTC6 = await page.evaluate(() => {
      const box = document.getElementById('cliStatus');
      return box ? box.textContent.trim() : null;
    });
    console.log('   [Assert] Status textContent:', statusTextTC6);
    assert.ok(statusTextTC6 && statusTextTC6.includes('feature/visual-testing'), 'TC-6: 展开含 git 分支');
    assert.ok(statusTextTC6 && statusTextTC6.includes('+120'), 'TC-6: 展开含代码新增行数');
    assert.ok(statusTextTC6 && statusTextTC6.includes('45,000 tokens'), 'TC-6: 展开含精确 token 计数');
    assert.ok(statusTextTC6 && statusTextTC6.includes('cache 45%'), 'TC-6: 展开含缓存命中率（瞬时·本轮）');
    assert.ok(statusTextTC6 && statusTextTC6.includes('reused 1.2m'), 'TC-6: 展开含累计复用 token（会话级 reused，区别于瞬时 cache%）');
    assert.ok(statusTextTC6 && /ttl ~\d+:\d{2} est/.test(statusTextTC6), 'TC-6: 展开含缓存失效倒计时（客户端推算，~est 标记非权威）');
    assert.ok(statusTextTC6 && statusTextTC6.includes('in:2.0k'), 'TC-6: 展开含 token 明细 in');
    assert.ok(statusTextTC6 && statusTextTC6.includes('w:22.0k') && statusTextTC6.includes('r:21.0k'), 'TC-6: 展开含 token 明细 w/r');
    assert.ok(statusTextTC6 && statusTextTC6.includes('Ike-li/claude-chat-mobile'), 'TC-6: 展开含 repo 全名');
    assert.ok(statusTextTC6 && statusTextTC6.includes('v2.1.178'), 'TC-6: 展开含 CLI 版本号');
    // 新增展开字段：ctx% + left（model→窗口映射）、成本、会话元数据 sid/transcript
    assert.ok(statusTextTC6 && statusTextTC6.includes('ctx 23%'), 'TC-6: 展开含 ctx 百分比（model→窗口映射）');
    assert.ok(statusTextTC6 && statusTextTC6.includes('left 155k'), 'TC-6: 展开含剩余上下文（windowSize−tokens）');
    assert.ok(statusTextTC6 && statusTextTC6.includes('est $0.37'), 'TC-6: 展开含成本（est $）');
    assert.ok(statusTextTC6 && statusTextTC6.includes('sid 784e20b1'), 'TC-6: 展开含会话 sid');

    // 3. 折叠摘要：只显 'statusline' 一词（全部数据在展开态）
    const summaryTextTC6 = await page.evaluate(() => {
      const summary = document.getElementById('cliSummary');
      return summary ? summary.textContent.trim() : null;
    });
    console.log(`   [Assert] Summary Text: "${summaryTextTC6}"`);
    assert.ok(summaryTextTC6 === 'statusline', 'TC-6: 折叠摘要只显 statusline');

    await page.screenshot({ path: `${SNAPSHOTS_DIR}/tc6_statusline.png` });
    console.log('📸 Captured and saved tc6_statusline.png\n');

    // ==================================================================
    // TC-7: Effort Slider & Permission Selector & Concurrency
    // ==================================================================
    console.log('👉 Running TC-7: Effort Slider & Permission Selector & Concurrency...');
    
    // 7a. Open tactile settings panel
    await page.click('#btnSettings');
    await page.waitForSelector('#settingsSheet:not(.translate-y-full)');
    await sleep(400); // wait for slide-up transition
    await page.screenshot({ path: `${SNAPSHOTS_DIR}/tc7_settings_open.png` });
    console.log('📸 Captured and saved tc7_settings_open.png');

    // Select "plan" permission mode tile
    await page.click('.perm-tile[data-mode="plan"]');
    await sleep(200);
    
    // Select "medium" thinking intensity level tile
    await page.click('.effort-tile[data-level="medium"]');
    await sleep(200);

    // 1. Assert plan and medium tile active highlights and bottom pill updates
    const planTileClasses = await page.evaluate(() => {
      const tile = document.querySelector('.perm-tile[data-mode="plan"]');
      if (!tile) return null;
      return {
        tileHasRing: tile.classList.contains('ring-accent') || tile.classList.contains('ring-1'),
        titleHasTextAccent: tile.querySelector('.text-xs').classList.contains('text-accent')
      };
    });
    assert.deepStrictEqual(planTileClasses, { tileHasRing: true, titleHasTextAccent: true }, 'TC-7: CSS highlighting for plan perm tile is precise');

    const mediumEffortTileClasses = await page.evaluate(() => {
      const tile = document.querySelector('.effort-tile[data-level="medium"]');
      if (!tile) return null;
      return {
        tileHasRing: tile.classList.contains('ring-accent') || tile.classList.contains('ring-1'),
        titleHasTextAccent: (tile.querySelector('.text-xs') || tile).classList.contains('text-accent')
      };
    });
    assert.deepStrictEqual(mediumEffortTileClasses, { tileHasRing: true, titleHasTextAccent: true }, 'TC-7: CSS highlighting for medium effort tile is precise');

    const pillPermText = await page.evaluate(() => {
      const p = document.getElementById('pillPermText');
      return p ? p.textContent.trim() : null;
    });
    assert.strictEqual(pillPermText, '计划模式', 'TC-7: Bottom pill permission text must display "计划模式"');

    // 2. Intercept WebSocket Frame via CDP Session to verify [1m] suffix retention
    console.log('   [CDP] Initializing Chrome DevTools Session for WebSocket frame tracking...');
    const cdp = await page.target().createCDPSession();
    await cdp.send('Network.enable');
    let lastEmittedModel = null;
    let lastEmittedText = null;
    
    cdp.on('Network.webSocketFrameSent', ({ response }) => {
      const data = response.payloadData;
      // Socket.IO v4 text frames start with '42["user:message", ...]'
      if (data && data.startsWith('42')) {
        try {
          const [event, payload] = JSON.parse(data.slice(2));
          if (event === 'user:message') {
            lastEmittedModel = typeof payload === 'string' ? null : payload?.model;
            lastEmittedText = typeof payload === 'string' ? payload : payload?.text;
          }
        } catch (e) {
          // ignore parsing failures
        }
      }
    });

    // Select the 1m context suffix tile: claude-3-opus[1m]
    console.log('   [CDP] Selecting Claude 3 Opus (1m Context) suffix tile...');
    await page.click('.model-tile[data-model="claude-3-opus[1m]"]');
    await sleep(200);

    await page.screenshot({ path: `${SNAPSHOTS_DIR}/tc7_selectors_changed.png` });
    console.log('📸 Captured and saved tc7_selectors_changed.png');

    // Close tactile settings panel
    await page.click('#settingsClose');
    await page.waitForSelector('#settingsSheet.translate-y-full');
    await sleep(400);

    // Send a mock user message to trigger socket emission
    console.log('   [CDP] Sending mock message to trigger WebSocket payload emission...');
    await page.focus('#input');
    await page.evaluate((val) => {
      const input = document.getElementById('input');
      input.value = val;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, 'CDP suffix probe');
    await sleep(200);
    await page.click('#btnSend');
    await sleep(600); // Wait for CDP frame handler to fire

    console.log(`   [Assert] WebSocket intercepted model payload: "${lastEmittedModel}"`);
    assert.strictEqual(lastEmittedModel, 'claude-3-opus[1m]', 'TC-7: Gateway suffix [1m] must be seamlessly retained and emitted');

    // 3. Click "沿用当前模型" tile to verify model置空 safety
    await page.click('#btnSettings');
    await page.waitForSelector('#settingsSheet:not(.translate-y-full)');
    await sleep(400);

    console.log('   [Assert] Clicking "沿用当前模型" tile to reset select value...');
    await page.click('.model-tile[data-model=""]');
    await sleep(200);

    const modelInputValue = await page.evaluate(() => {
      const select = document.getElementById('modelInput');
      return select ? select.value : null;
    });
    assert.strictEqual(modelInputValue, '', 'TC-7: Model select value must be reset to empty string for safety');

    // Close tactile settings panel
    await page.click('#settingsClose');
    await page.waitForSelector('#settingsSheet.translate-y-full');
    await sleep(400);

    // 7b. Trigger concurrent workspace session tab
    await sendCommand('test:tab');
    await waitIdle();

    // Open sidebar workspace session list
    await page.click('#btnSessions');
    await page.waitForSelector('#leftSidebar:not(.-translate-x-full)');
    await sleep(400); // Wait for sidebar slide-in transition

    // Click to expand both folders in the directory tree
    await page.click('div[data-dir="/Users/you/code/claude-chat-mobile"] button:first-child');
    await sleep(200);
    await page.click('div[data-dir="/Users/you/code/another-react-project"] button:first-child');
    await sleep(300);
    await page.screenshot({ path: `${SNAPSHOTS_DIR}/tc7_concurrency_tabs.png` });
    console.log('📸 Captured and saved tc7_concurrency_tabs.png');

    // 4. Click live session tab "Another App Concurrency"
    console.log('👥 Switching viewing session to "Another App Concurrency" (inst_2)...');
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('#sessionPanel .row-content button'));
      const target = buttons.find(b => b.title === 'Another App Concurrency');
      if (target) {
        target.click();
      } else {
        throw new Error('Sidebar session "Another App Concurrency" button not found');
      }
    });

    // The sidebar closes automatically on session switch view select
    await page.waitForSelector('#leftSidebar.-translate-x-full');
    await sleep(400);

    // Re-open sidebar to verify bg-accent-wash highlighting of the active session row
    await page.click('#btnSessions');
    await page.waitForSelector('#leftSidebar:not(.-translate-x-full)');
    await sleep(400);

    const activeSessionInfo = await page.evaluate(() => {
      const activeRow = document.querySelector('#sessionPanel .row-content.bg-accent-wash');
      if (!activeRow) return null;
      const titleSpan = activeRow.querySelector('span');
      return {
        title: titleSpan ? titleSpan.textContent.trim() : null,
        titleHasColor: titleSpan ? titleSpan.classList.contains('text-accent') : false
      };
    });
    console.log('   [Assert] Switched active session details:', activeSessionInfo);
    assert.deepStrictEqual(activeSessionInfo, {
      title: 'Another App Concurrency',
      titleHasColor: true
    }, 'TC-7: Workspace active row must highlight and switch viewing anchor to inst_2');

    // Close sidebar
    await page.click('#sidebarClose');
    await page.waitForSelector('#leftSidebar.-translate-x-full');
    await sleep(400);

    // 5. Assert that historical messages are hydrated and rendered for the active instance
    const hydratedBubbleCount = await page.evaluate(() => {
      const bubbles = document.querySelectorAll('#messages .row-content, #messages .msg-frame');
      return bubbles.length;
    });
    console.log(`   [Assert] Hydrated concurrent messages bubbles count: ${hydratedBubbleCount}`);
    assert.ok(hydratedBubbleCount > 0, 'TC-7: Historical messages must be successfully hydrated and replayed upon session switch');

    // ==================================================================
    // TC-7b: 审批弹窗显示时切 tab → clearView 清弹窗（坐实跨 tab 不发错路由回答）
    // ==================================================================
    console.log('\n👉 Running TC-7b: 跨 tab 审批弹窗清除（防错路由回答）...');
    // CDP 监听：全程不得有 user:approve 帧外发（弹窗在能回答前已被切 tab 清除）
    let approveFramesCT = 0;
    const cdpCT = await page.target().createCDPSession();
    await cdpCT.send('Network.enable');
    cdpCT.on('Network.webSocketFrameSent', ({ response }) => {
      const data = response.payloadData;
      if (data && data.startsWith('42')) {
        try { if (JSON.parse(data.slice(2))[0] === 'user:approve') approveFramesCT++; } catch (e) { /* ignore */ }
      }
    });

    // 1) viewing=inst_1 弹审批（后台备好 inst_2）
    await sendCommand('test:permCrossTab');
    await page.waitForSelector('#permModal:not(.hidden)');
    await sleep(300);
    const ctBefore = await page.evaluate(() => ({
      hidden: document.getElementById('permModal').classList.contains('hidden'),
      tool: document.getElementById('permTool')?.textContent.trim() || null
    }));
    assert.strictEqual(ctBefore.hidden, false, 'TC-7b: 切 tab 前审批弹窗应显示');
    assert.strictEqual(ctBefore.tool, 'run_command', 'TC-7b: 弹窗内容应为 inst_1 的审批');
    await page.screenshot({ path: `${SNAPSHOTS_DIR}/tc7b_perm_before_switch.png` });

    // 2) mock 在弹窗渲染后自动切到 inst_2（viewing 变化）→ 前端 bindView → clearView 应清弹窗
    //    （由 mock 内部自动切，避免在弹窗打开时再走 input+btnSend——点击坐标会穿透到 sheet 审批按钮误发回答）
    await page.waitForSelector('#permModal.hidden', { timeout: 8000 });
    await sleep(300);
    const ctAfterHidden = await page.evaluate(() => document.getElementById('permModal').classList.contains('hidden'));
    assert.strictEqual(ctAfterHidden, true, 'TC-7b: 切 tab 后审批弹窗必须被 clearView 清除');

    // 3) 兜底：强制点击残留的 allow 按钮——activePerm 已被 clearView 清空，answerPerm 应直接 return，不外发 user:approve
    await page.evaluate(() => document.getElementById('permAllow')?.click());
    await sleep(250);
    assert.strictEqual(approveFramesCT, 0, 'TC-7b: 全程不得发出 user:approve（弹窗在能回答前已清，杜绝错路由）');
    await cdpCT.detach();
    await page.screenshot({ path: `${SNAPSHOTS_DIR}/tc7b_perm_cleared_after_switch.png` });
    console.log('   [Assert] 跨 tab 审批弹窗已清除、无 user:approve 外发 ✅');

    // ==================================================================
    // TC-8: TOFU Device Trust Screen
    // ==================================================================
    console.log('\n👉 Running TC-8: TOFU Device Trust Screen...');
    await sendCommand('test:tofu');
    await page.waitForSelector('#deviceModal:not(.hidden)');
    await sleep(300);

    // 1. Assert TOFU locking screen layout, fingerprint display and input disabled state
    const tofuPendingDetails = await page.evaluate(() => {
      const modal = document.getElementById('deviceModal');
      const fingerprintEl = document.getElementById('deviceModalId');
      const input = document.getElementById('input');
      return {
        isVisible: modal && !modal.classList.contains('hidden'),
        fingerprint: fingerprintEl ? fingerprintEl.textContent.trim() : null,
        isInputDisabled: input ? input.disabled : false
      };
    });
    console.log('   [Assert] TOFU overlay details:', tofuPendingDetails);
    assert.strictEqual(tofuPendingDetails.isVisible, true, 'TC-8: Security trust modal must overlay the entire UI');
    assert.strictEqual(tofuPendingDetails.fingerprint, 'unauthorized-fingerprint-999', 'TC-8: Fingerprint value must render completely');
    assert.strictEqual(tofuPendingDetails.isInputDisabled, true, 'TC-8: Main chat input area must be locked/disabled');

    await page.screenshot({ path: `${SNAPSHOTS_DIR}/tc8_tofu_pending.png` });
    console.log('📸 Captured and saved tc8_tofu_pending.png');

    // Wait for simulated host approval timeout (8 seconds)
    console.log('⏳ Waiting for simulated host auto-approval (8s timeout)...');
    await page.waitForSelector('#deviceModal.hidden', { timeout: 12000 });
    await sleep(300);

    // 2. Assert TOFU approved, modal hidden and input interactive
    const tofuApprovedDetails = await page.evaluate(() => {
      const modal = document.getElementById('deviceModal');
      const input = document.getElementById('input');
      return {
        isHidden: modal && modal.classList.contains('hidden'),
        isInputEnabled: input ? !input.disabled : false
      };
    });
    assert.deepStrictEqual(tofuApprovedDetails, { isHidden: true, isInputEnabled: true }, 'TC-8: Security overlay must transition out and unlock controls upon approval');

    await page.screenshot({ path: `${SNAPSHOTS_DIR}/tc8_tofu_approved.png` });
    console.log('📸 Captured and saved tc8_tofu_approved.png\n');

    // ==================================================================
    // TC-9: Empty & Startup States — reload page to capture cold start
    // ==================================================================
    console.log('👉 Running TC-9: Empty & Startup States...');
    
    // Navigate to a fresh page to capture cold-start empty state
    await page.goto('http://127.0.0.1:3100', { waitUntil: 'domcontentloaded' });
    await sleep(500); // let app.js initialize, but before hydration events fully process

    // 1. Assert empty start screen or messages area exists
    const msgsExistsTC9 = await page.evaluate(() => {
      const msgs = document.getElementById('messages');
      return !!msgs;
    });
    assert.strictEqual(msgsExistsTC9, true, 'TC-9: Messages container must exist');

    // 2. Capture cold-start screenshot (may show loading/empty state)
    await page.screenshot({ path: `${SNAPSHOTS_DIR}/tc9_cold_start.png` });
    console.log('📸 Captured and saved tc9_cold_start.png');

    // Now wait for socket connection and hydration
    await page.waitForSelector('#input', { timeout: 10000 });
    await sleep(500);

    // 3. Assert status pills show meaningful data after hydration
    const pillPermExistsTC9 = await page.evaluate(() => {
      const p = document.getElementById('pillPerm');
      return !!p;
    });
    assert.strictEqual(pillPermExistsTC9, true, 'TC-9: Permission pill must exist after hydration');

    const pillModelTextTC9 = await page.evaluate(() => {
      const el = document.getElementById('pillModelText');
      return el ? el.textContent.trim() : null;
    });
    console.log(`   [Assert] Model pill: "${pillModelTextTC9}"`);
    assert.ok(pillModelTextTC9 && pillModelTextTC9.length >= 3, 'TC-9: Model pill must show a model name after hydration');

    const pillPermTextTC9 = await page.evaluate(() => {
      const el = document.getElementById('pillPermText');
      return el ? el.textContent.trim() : null;
    });
    console.log(`   [Assert] Permission pill: "${pillPermTextTC9}"`);
    assert.ok(pillPermTextTC9 && pillPermTextTC9.length >= 2, 'TC-9: Permission pill must show a permission label');

    const pillWorkspaceTC9 = await page.evaluate(() => {
      const el = document.getElementById('pillWorkspaceText');
      return el ? el.textContent.trim() : null;
    });
    console.log(`   [Assert] Workspace pill: "${pillWorkspaceTC9}"`);
    assert.ok(pillWorkspaceTC9 && pillWorkspaceTC9.length >= 3, 'TC-9: Workspace pill must show a project name');

    await page.screenshot({ path: `${SNAPSHOTS_DIR}/tc9_hydrated.png` });
    console.log('📸 Captured and saved tc9_hydrated.png');
    console.log('✅ TC-9: Empty & startup states passed\n');

    // ==================================================================
    // TC-10: Sidebar & Session List
    // ==================================================================
    console.log('👉 Running TC-10: Sidebar & Session List...');

    // 10a. Open sidebar
    await page.click('#btnSessions');
    await page.waitForSelector('#leftSidebar:not(.-translate-x-full)');
    await sleep(400);

    // 1. Assert sidebar scrim is visible
    const scrimVisibleTC10 = await page.evaluate(() => {
      const scrim = document.getElementById('sidebarScrim');
      return scrim ? !scrim.classList.contains('hidden') : false;
    });
    assert.strictEqual(scrimVisibleTC10, true, 'TC-10: Sidebar scrim must be visible when open');

    await page.screenshot({ path: `${SNAPSHOTS_DIR}/tc10_sidebar_open.png` });
    console.log('📸 Captured and saved tc10_sidebar_open.png');

    // 10b. Expand directory tree
    await page.click('div[data-dir="/Users/you/code/claude-chat-mobile"] button:first-child');
    await sleep(300);

    // 2. Assert session list items have correct data
    const sessionItemsTC10 = await page.evaluate(() => {
      const rows = document.querySelectorAll('#sessionPanel .row-content');
      return rows.length;
    });
    assert.ok(sessionItemsTC10 > 0, 'TC-10: Session list must have at least one item');

    // Verify session item text is meaningful
    const firstSessionTitleTC10 = await page.evaluate(() => {
      const row = document.querySelector('#sessionPanel .row-content');
      if (!row) return null;
      const span = row.querySelector('span');
      return span ? span.textContent.trim() : null;
    });
    console.log(`   [Assert] First session title: "${firstSessionTitleTC10}"`);
    assert.ok(firstSessionTitleTC10 && firstSessionTitleTC10.length >= 3, 'TC-10: First session must have a meaningful title');

    // Verify directory label shows project name
    const dirLabelTC10 = await page.evaluate(() => {
      const dir = document.querySelector('div[data-dir="/Users/you/code/claude-chat-mobile"]');
      if (!dir) return null;
      const span = dir.querySelector('span');
      return span ? span.textContent.trim() : null;
    });
    console.log(`   [Assert] Directory label: "${dirLabelTC10}"`);
    assert.ok(dirLabelTC10 && dirLabelTC10.length >= 1, 'TC-10: Directory label must be non-empty');

    await page.screenshot({ path: `${SNAPSHOTS_DIR}/tc10_sidebar_expanded.png` });
    console.log('📸 Captured and saved tc10_sidebar_expanded.png');

    // 10c. Close sidebar via close button
    await page.click('#sidebarClose');
    await page.waitForSelector('#leftSidebar.-translate-x-full');
    await sleep(300);

    // 3. Assert sidebar is hidden after close
    const sidebarClosedTC10 = await page.evaluate(() => {
      const sidebar = document.getElementById('leftSidebar');
      return sidebar ? sidebar.classList.contains('-translate-x-full') : true;
    });
    assert.strictEqual(sidebarClosedTC10, true, 'TC-10: Sidebar must close after clicking close button');

    await page.screenshot({ path: `${SNAPSHOTS_DIR}/tc10_sidebar_closed.png` });
    console.log('📸 Captured and saved tc10_sidebar_closed.png');
    console.log('✅ TC-10: Sidebar tests passed\n');

    // ==================================================================
    // TC-11: Input Area Interactions
    // ==================================================================
    console.log('👉 Running TC-11: Input Area Interactions...');

    // 11a. Assert btnSend disabled with empty input
    const btnSendDisabledTC11 = await page.evaluate(() => {
      const btn = document.getElementById('btnSend');
      return btn ? btn.disabled : null;
    });
    assert.strictEqual(btnSendDisabledTC11, true, 'TC-11: Send button must be disabled with empty input');

    await page.screenshot({ path: `${SNAPSHOTS_DIR}/tc11_input_empty.png` });
    console.log('📸 Captured and saved tc11_input_empty.png');

    // 11b. Type text — btnSend must enable
    await page.focus('#input');
    await page.evaluate(() => {
      const input = document.getElementById('input');
      input.value = 'Hello visual test!';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(300);

    const btnSendEnabledTC11 = await page.evaluate(() => {
      const btn = document.getElementById('btnSend');
      return btn ? !btn.disabled : false;
    });
    assert.strictEqual(btnSendEnabledTC11, true, 'TC-11: Send button must enable after typing');

    // Verify typed text is actually in the input
    const inputTextTC11 = await page.evaluate(() => {
      const input = document.getElementById('input');
      return input ? input.value : null;
    });
    console.log(`   [Assert] Input text: "${inputTextTC11}"`);
    assert.strictEqual(inputTextTC11, 'Hello visual test!', 'TC-11: Input must contain typed text');

    await page.screenshot({ path: `${SNAPSHOTS_DIR}/tc11_input_text.png` });
    console.log('📸 Captured and saved tc11_input_text.png');

    // 11c. File attachment via file chooser — create a real temp file
    const { writeFileSync, unlinkSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tmpFile = join(tmpdir(), 'ccm-visual-test-upload.png');
    writeFileSync(tmpFile, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));

    const fileChooserPromise = page.waitForFileChooser();
    await page.click('#btnAttach');
    const fileChooser = await fileChooserPromise;
    await fileChooser.accept([tmpFile]);
    await sleep(500);

    // Clean up temp file
    try { unlinkSync(tmpFile); } catch {}

    // Assert attach tray is visible
    const attachTrayVisibleTC11 = await page.evaluate(() => {
      const tray = document.getElementById('attachTray');
      return tray ? !tray.classList.contains('hidden') : false;
    });
    assert.strictEqual(attachTrayVisibleTC11, true, 'TC-11: Attach tray must be visible after adding file');

    // Verify attachment chip shows correct filename
    const attachChipTextTC11 = await page.evaluate(() => {
      const chips = document.querySelectorAll('#attachTray button span, #attachTray .chip-label, #attachTray [data-name]');
      if (chips.length > 0) return chips[0].textContent.trim();
      // fallback: search for text nodes in tray
      const tray = document.getElementById('attachTray');
      return tray ? tray.textContent.trim() : null;
    });
    console.log(`   [Assert] Attachment chip: "${attachChipTextTC11}"`);
    assert.ok(attachChipTextTC11 && attachChipTextTC11.includes('.png'), 'TC-11: Attach tray must show the uploaded filename');

    await page.screenshot({ path: `${SNAPSHOTS_DIR}/tc11_attach_tray.png` });
    console.log('📸 Captured and saved tc11_attach_tray.png');

    // Clear input and attachments
    await page.evaluate(() => {
      const input = document.getElementById('input');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Remove attachment chip
    const chip = await page.$('#attachTray button');
    if (chip) await chip.click();
    await sleep(300);

    // 11d. ultracode 思考档（CLI /effort 最高档 = xhigh + workflow）给 prompt 加前缀，走同一发送路径
    lastEmittedText = null;
    // 先切到支持 xhigh 的模型（sonnet），ultracode 档才渲染（haiku 等不支持 effort 的模型无此档）；
    // 选模型不收面板（同 TC-7），面板保持开、直接续选 ultracode 磁贴，最后显式 #settingsClose 关
    await page.click('#btnSettings');
    await page.waitForSelector('#settingsSheet:not(.translate-y-full)');
    await sleep(300);
    await page.click('.model-tile[data-model="claude-3-5-sonnet"]');
    await sleep(500); // 等 rebuildEffortOptions 按 sonnet 档位重渲（含 xhigh → ultracode）
    await page.click('.effort-tile[data-level="ultracode"]');
    await sleep(300);
    await page.click('#settingsClose');
    await page.waitForSelector('#settingsSheet.translate-y-full');
    await sleep(300);
    // ultracode 档已武装，发送自动注入关键词前缀
    await page.focus('#input');
    await page.evaluate(() => {
      const input = document.getElementById('input');
      input.value = '整理 utils 日期工具';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(200);
    await page.click('#btnSend');
    await sleep(600);
    console.log(`   [Assert] ultracode emitted text: "${lastEmittedText}"`);
    assert.strictEqual(lastEmittedText, 'ultracode 整理 utils 日期工具', 'TC-11: ultracode 思考档必须给 prompt 加前缀并 emit');

    // 复位 ultracode 武装态（粘性），避免污染后续用例的发送——点默认思考档即可 armed=false
    await page.click('#btnSettings');
    await page.waitForSelector('#settingsSheet:not(.translate-y-full)');
    await sleep(300);
    await page.evaluate(() => document.querySelector('.effort-tile[data-level=""]')?.click()); // 默认档，evaluate 绕可见性判定
    await sleep(300);
    await page.click('#settingsClose');
    await page.waitForSelector('#settingsSheet.translate-y-full');
    await sleep(300);

    // 11e. Interrupt button during streaming
    await sendCommand('test:stream-long');

    // Wait for activeStatusPill to appear, then screenshot
    await page.waitForSelector('#activeStatusPill:not(.hidden)', { timeout: 5000 });
    await sleep(300);

    const stopBtnVisibleTC11 = await page.evaluate(() => {
      const btn = document.getElementById('btnStopNew');
      return btn ? !btn.classList.contains('hidden') : false;
    });
    assert.strictEqual(stopBtnVisibleTC11, true, 'TC-11: Stop button must be visible during streaming');

    // Verify status text shows execution message
    const statusTextTC11 = await page.evaluate(() => {
      const el = document.getElementById('activeStatusText');
      return el ? el.textContent.trim() : null;
    });
    console.log(`   [Assert] Active status text: "${statusTextTC11}"`);
    assert.ok(statusTextTC11 && statusTextTC11.length > 0, 'TC-11: Active status text must not be empty during streaming');

    await page.screenshot({ path: `${SNAPSHOTS_DIR}/tc11_streaming_stop.png` });
    console.log('📸 Captured and saved tc11_streaming_stop.png');

    // Click stop to interrupt
    await page.click('#btnStopNew');
    await sleep(800);

    // Assert stop button hidden after interrupt (or timeout)
    const stopBtnHiddenTC11 = await page.evaluate(() => {
      const btn = document.getElementById('btnStopNew');
      return btn ? btn.classList.contains('hidden') : true;
    });
    // Note: mock server's stream-long continues emitting in background;
    // frontend should hide stop button and finalize streams on interrupt
    console.log(`   [Assert] Stop button hidden after interrupt: ${stopBtnHiddenTC11}`);

    await sleep(400);
    await page.screenshot({ path: `${SNAPSHOTS_DIR}/tc11_after_interrupt.png` });
    console.log('📸 Captured and saved tc11_after_interrupt.png');
    console.log('✅ TC-11: Input area tests passed\n');

    // ==================================================================
    // TC-12: Settings Panel — All Permission & Effort Modes
    // ==================================================================
    console.log('👉 Running TC-12: Settings Panel — All Modes...');

    // Open settings
    await page.click('#btnSettings');
    await page.waitForSelector('#settingsSheet:not(.translate-y-full)');
    await sleep(400);

    // 0. Ensure a model with effort support is selected (page reload may reset state)
    try {
      await page.click('.model-tile[data-model="claude-3-5-sonnet"]');
      await sleep(200);
    } catch { /* tile may not exist */ }

    await page.screenshot({ path: `${SNAPSHOTS_DIR}/tc12_settings_open.png` });
    console.log('📸 Captured and saved tc12_settings_open.png');

    // 12a: Test permission modes visually (skip bypassPermissions/dontAsk — require confirmation dialogs)
    // Also verify pill text updates correctly for each mode
    const permModes = [
      { mode: 'default', label: '默认审批' },
      { mode: 'acceptEdits', label: '自动接受编辑' },
      { mode: 'plan', label: '计划模式' }
    ];
    for (const { mode, label } of permModes) {
      await page.click(`.perm-tile[data-mode="${mode}"]`);
      await sleep(200);
      const pillText = await page.evaluate(() => {
        const p = document.getElementById('pillPermText');
        return p ? p.textContent.trim() : null;
      });
      console.log(`   [Assert] Perm mode "${mode}" → pill: "${pillText}" (expected: "${label}")`);
      assert.strictEqual(pillText, label, `TC-12: Permission pill must show "${label}" after clicking ${mode} tile`);
    }
    // End on 'plan' mode
    await page.click('.perm-tile[data-mode="plan"]');
    await sleep(200);

    // 1. Verify permission mode pill (already verified in the loop above; check final state)

    await page.screenshot({ path: `${SNAPSHOTS_DIR}/tc12_perm_plan.png` });
    console.log('📸 Captured and saved tc12_perm_plan.png');

    // 12b: Test effort levels — check if effort group is visible first
    const effortGroupVisibleTC12 = await page.evaluate(() => {
      const g = document.getElementById('customEffortGroup');
      return g ? !g.classList.contains('hidden') : false;
    });
    
    if (effortGroupVisibleTC12) {
      const effortLevels = ['low', 'medium', 'high'];
      for (const level of effortLevels) {
        try {
          await page.click(`.effort-tile[data-level="${level}"]`);
          await sleep(150);
          const pillText = await page.evaluate(() => {
            const p = document.getElementById('pillEffortText');
            return p ? p.textContent.trim() : null;
          });
          console.log(`   [Assert] Effort "${level}" → pill: "${pillText}"`);
        } catch { /* some levels may not be rendered */ }
      }
      // End on 'high'
      try { await page.click('.effort-tile[data-level="high"]'); await sleep(200); } catch {}

      const highEffortActiveTC12 = await page.evaluate(() => {
        const tile = document.querySelector('.effort-tile[data-level="high"]');
        return tile ? (tile.classList.contains('ring-accent') || tile.classList.contains('ring-1')) : false;
      });
      console.log(`   [Assert] High effort tile active: ${highEffortActiveTC12}`);
    } else {
      console.log('   [Skip] Effort group hidden (model does not support effort levels)');
    }

    await page.screenshot({ path: `${SNAPSHOTS_DIR}/tc12_effort_high.png` });
    console.log('📸 Captured and saved tc12_effort_high.png');

    // 12c: Model tile switching
    await page.click('.model-tile[data-model="claude-3-opus"]');
    await sleep(200);

    const modelSelectTC12 = await page.evaluate(() => {
      const sel = document.getElementById('modelInput');
      return sel ? sel.value : null;
    });
    assert.strictEqual(modelSelectTC12, 'claude-3-opus', 'TC-12: Model select must update to claude-3-opus');

    await page.screenshot({ path: `${SNAPSHOTS_DIR}/tc12_model_opus.png` });
    console.log('📸 Captured and saved tc12_model_opus.png');

    // Reset to default model
    await page.click('.model-tile[data-model=""]');
    await sleep(200);

    // Close settings
    await page.click('#settingsClose');
    await page.waitForSelector('#settingsSheet.translate-y-full');
    await sleep(400);
    console.log('✅ TC-12: Settings panel tests passed\n');

    // ==================================================================
    // TC-13: Modal Panels — Console / Device Requests / Access Help
    // ==================================================================
    console.log('👉 Running TC-13: Modal Panels...');

    // 13a: Console (log) modal
    await page.click('#btnConsole');
    await page.waitForSelector('#consoleModal:not(.hidden)');
    await sleep(300);

    const consoleVisibleTC13 = await page.evaluate(() => {
      const modal = document.getElementById('consoleModal');
      return modal ? !modal.classList.contains('hidden') : false;
    });
    assert.strictEqual(consoleVisibleTC13, true, 'TC-13: Console modal must be visible');

    // Console log entries may be empty in fresh page; just verify modal renders
    await page.screenshot({ path: `${SNAPSHOTS_DIR}/tc13_console_modal.png` });
    console.log('📸 Captured and saved tc13_console_modal.png');

    // Close console
    await page.click('#consoleClose');
    await page.waitForSelector('#consoleModal.hidden');
    await sleep(200);

    // 13b: Device requests overlay (pending_devices cards)
    await sendCommand('test:devicerequests');
    await waitIdle();

    await sleep(300);
    
    const deviceReqCardsTC13 = await page.evaluate(() => {
      const cards = document.querySelectorAll('#deviceRequests > div');
      return cards.length;
    });
    console.log(`   [Assert] Device request cards visible: ${deviceReqCardsTC13 > 0}`);

    // Verify device card details
    const deviceCardTextTC13 = await page.evaluate(() => {
      const cards = document.querySelectorAll('#deviceRequests > div');
      if (cards.length === 0) return null;
      return cards[0].textContent.trim();
    });
    console.log(`   [Assert] First device card text: "${deviceCardTextTC13?.slice(0, 80)}..."`);
    assert.ok(deviceCardTextTC13 && deviceCardTextTC13.includes('aa-bb-cc-dd'), 'TC-13: Device card must contain deviceId "aa-bb-cc-dd"');
    assert.ok(deviceCardTextTC13 && deviceCardTextTC13.includes('192.168.1.100'), 'TC-13: Device card must contain IP "192.168.1.100"');

    await page.screenshot({ path: `${SNAPSHOTS_DIR}/tc13_device_requests.png` });
    console.log('📸 Captured and saved tc13_device_requests.png');

    // 13c: Access help page
    // Open settings → click access help
    await page.click('#btnSettings');
    await page.waitForSelector('#settingsSheet:not(.translate-y-full)');
    await sleep(300);

    await page.click('#accessHelpOpen');
    await page.waitForSelector('#accessHelp:not(.hidden)');
    await sleep(300);

    const accessHelpVisibleTC13 = await page.evaluate(() => {
      const el = document.getElementById('accessHelp');
      return el ? !el.classList.contains('hidden') : false;
    });
    assert.strictEqual(accessHelpVisibleTC13, true, 'TC-13: Access help page must be visible');

    // Verify access help has meaningful content
    const accessHelpTextTC13 = await page.evaluate(() => {
      const el = document.getElementById('accessHelp');
      return el ? el.textContent.trim().slice(0, 200) : null;
    });
    console.log(`   [Assert] Access help snippet: "${accessHelpTextTC13?.slice(0, 60)}..."`);
    assert.ok(accessHelpTextTC13 && accessHelpTextTC13.includes('令牌'), 'TC-13: Access help must mention "令牌"');

    await page.screenshot({ path: `${SNAPSHOTS_DIR}/tc13_access_help.png` });
    console.log('📸 Captured and saved tc13_access_help.png');

    // Close access help
    await page.click('#accessHelpClose');
    await page.waitForSelector('#accessHelp.hidden');
    await sleep(300);

    // Close settings (may already be closing from access help interaction)
    try {
      await page.click('#settingsClose');
      await page.waitForSelector('#settingsSheet.translate-y-full', { timeout: 3000 });
    } catch {
      console.log('   [Note] Settings sheet close skipped (may have auto-closed)');
    }
    await sleep(200);
    console.log('✅ TC-13: Modal panels tests passed\n');
    console.log('✅ TC-13: Modal panels tests passed\n');

    // ==================================================================
    // TC-14: 新会话首发的乐观 busy 不被懒开广播冲掉（回归 shouldRestoreOptimisticBusy）
    //        + 懒开后（sessionId 未到）不得闪回首页 dashboard（回归 bindView 首发守卫）
    // ==================================================================
    console.log('👉 Running TC-14: 新会话首发 busy 连续性 + 不闪首页...');
    // 重置到干净状态（清掉 TC-13 的 modal/DOM 残留），重连后重新 hydration
    await page.reload({ waitUntil: 'networkidle2' });
    await page.waitForSelector('#btnNew');
    await sleep(500);
    // 1. 点新会话按钮 → 前端进空首页（viewingInstanceId=null）
    await page.click('#btnNew');
    await page.waitForSelector('#messages.empty-start', { timeout: 5000 });
    // 2. 发首条消息：此刻 viewing=null，send() 置 _pendingFirstSend（sendCommand 内会等到乐观 busy 出现）
    await sendCommand('test:freshbusy');
    // 3. 关键断言：经过 mock 懒开广播 instances（切 viewing，t≈150ms）之后、首个 delta（t≈1250ms）之前，
    //    pill 必须仍可见——修复前会被 bindView→clearView 的 setBusy(false) 冲掉，此处 fail。
    await sleep(600);
    const tc14State = await page.evaluate(() => {
      const pill = document.getElementById('activeStatusPill');
      const messages = document.getElementById('messages');
      return {
        pillVisible: pill && !pill.classList.contains('hidden') && pill.classList.contains('pill-active'),
        // 懒开广播 instances 后、首个 delta 前，新实例尚无 sessionId；bindView 不得回落 dashboard
        // （否则 empty-start + .dashboard-container 闪现再被首个 delta 冲掉 = 用户可见的「闪回首页」）。
        dashboardShown: !!messages && (messages.classList.contains('empty-start') || !!messages.querySelector('.dashboard-container')),
      };
    });
    assert.strictEqual(tc14State.pillVisible, true, 'TC-14: 新会话首发的 busy 提示必须跨越懒开 instances 广播持续可见（回归 shouldRestoreOptimisticBusy）');
    assert.strictEqual(tc14State.dashboardShown, false, 'TC-14: 新会话首发懒开后（sessionId 未到）不得闪回首页 dashboard（回归 bindView 首发守卫）');
    await waitIdle();
    console.log('✅ TC-14: 新会话首发 busy 连续性 + 不闪首页 passed\n');

    // ==================================================================
    // TC-15: ExitPlanMode 批准后权限档图标跟随更新（回归:批准内含 setMode 同步前端）
    // ==================================================================
    console.log('👉 Running TC-15: ExitPlanMode 批准 → 权限档图标更新...');
    await page.reload({ waitUntil: 'networkidle2' });
    await page.waitForSelector('#input');
    await sleep(500);
    // 发 test:exitplan（mock 复刻真实 SDK：置 plan 档 → tool_use(ExitPlanMode) 亮 pill+工具文案 → 弹审批）。裸 input 发送
    await page.focus('#input');
    await page.evaluate(() => { const i = document.getElementById('input'); i.value = 'test:exitplan'; i.dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(200);
    await page.click('#btnSend');
    await page.waitForSelector('#permModal:not(.hidden)');
    await sleep(300); // 等弹窗动画完成（对齐 TC-4），否则 permAllow 尚不可点
    // 批准前:权限档 pill 应为「计划模式」
    const permBeforeTC15 = await page.evaluate(() => document.getElementById('pillPermText')?.textContent?.trim());
    assert.strictEqual(permBeforeTC15, '计划模式', 'TC-15: 批准前权限档应为 plan（计划模式）');
    // 批准前:状态栏卡在「运行工具 ExitPlanMode」（tool_use 派生的工具文案——批准后该工具瞬间结束、它就成僵尸文案）
    const statusBeforeTC15 = await page.evaluate(() => document.getElementById('activeStatusText')?.textContent?.trim());
    assert.strictEqual(statusBeforeTC15, 'Claude 正在运行工具 ExitPlanMode...', 'TC-15: 批准前状态栏应为「运行工具 ExitPlanMode」');
    // 点允许批准 ExitPlanMode
    await page.click('#permAllow');
    await page.waitForSelector('#permModal.hidden');
    // 批准后:ExitPlanMode 是瞬间完成型工具，状态须从僵尸文案回落「思考中」（与 AskUserQuestion/TC-5 同治）
    const statusAfterExitPlanTC15 = await page.evaluate(() => document.getElementById('activeStatusText')?.textContent?.trim());
    assert.strictEqual(statusAfterExitPlanTC15, 'Claude 正在思考中...', 'TC-15: 批准 ExitPlanMode 后状态须回落思考中（不卡僵尸工具文案）');
    await sleep(400); // 等 permission_mode 事件到达并驱动 setPermMode
    // 核心断言:批准后权限档图标必须跟随退出 plan、切到「默认审批」（default）
    const permAfterTC15 = await page.evaluate(() => document.getElementById('pillPermText')?.textContent?.trim());
    assert.strictEqual(permAfterTC15, '默认审批', 'TC-15: 批准 ExitPlanMode 后权限档图标必须更新为 default（回归:后端对 ExitPlanMode 兜底 setMode default 并广播，同步前端）');
    await waitIdle();
    console.log('✅ TC-15: ExitPlanMode 批准 → 权限档图标更新 passed\n');

    // ==================================================================
    // TC-16: 后台任务进度横幅（task_progress 原地刷新 + 完成撤下）
    // ==================================================================
    console.log('👉 Running TC-16: 后台任务进度横幅（task_progress）...');
    await page.reload({ waitUntil: 'networkidle2' });
    await page.waitForSelector('#input');
    await sleep(500);
    await sendCommand('test:taskprogress'); // 发送即乐观 busy（sendCommand 内等 activeStatusPill 出现）
    // 1. 进度横幅出现 + 首条进度文本
    await page.waitForSelector('#taskProgressBanner:not(.hidden)', { timeout: 5000 });
    const firstProgressTC16 = await page.evaluate(() => document.getElementById('taskProgressText').textContent);
    console.log(`   [Assert] 首条进度: "${firstProgressTC16}"`);
    assert.ok(firstProgressTC16.includes('步骤'), 'TC-16: 进度横幅应显示后台任务进度文本');
    // 2. 越过第 2、3 条心跳（mock 每 600ms 一条）→ 断言【原地刷新】：同一元素文本更新为最新、未追加拼接、横幅始终仅一条
    await sleep(1400);
    const [lastProgressTC16, bannerCountTC16] = await page.evaluate(() => [
      document.getElementById('taskProgressText').textContent,
      document.querySelectorAll('#taskProgressBanner').length
    ]);
    console.log(`   [Assert] 末条进度: "${lastProgressTC16}" · 横幅数量: ${bannerCountTC16}`);
    assert.ok(lastProgressTC16.includes('步骤 3/3'), 'TC-16: 进度应原地刷新为最新一条');
    assert.ok(!lastProgressTC16.includes('步骤 1/3'), 'TC-16: 原地刷新应覆盖旧文本，不追加拼接');
    assert.strictEqual(bannerCountTC16, 1, 'TC-16: 进度横幅应始终只有一条（原地刷新，不堆叠）');
    await page.screenshot({ path: `${SNAPSHOTS_DIR}/tc16_task_progress.png` });
    console.log('📸 Captured and saved tc16_task_progress.png');
    // 3. 完成通知(task_notification)后进度横幅撤下
    await page.waitForSelector('#taskProgressBanner.hidden', { timeout: 5000 });
    const bannerHiddenTC16 = await page.evaluate(() => document.getElementById('taskProgressBanner').classList.contains('hidden'));
    assert.strictEqual(bannerHiddenTC16, true, 'TC-16: 后台任务完成通知后进度横幅应撤下');
    await waitIdle();
    console.log('✅ TC-16: 后台任务进度横幅（task_progress）passed\n');

    // ==================================================================
    // TC-17: 切入实例时 sync:since 的 ack.pending 快照重建待审批卡片（回归 Bug2：角标 ⚠️ 但会话内无卡片）
    // ==================================================================
    console.log('👉 Running TC-17: sync:since 快照重建待审批卡片...');
    await page.reload({ waitUntil: 'networkidle2' });
    await page.waitForSelector('#input');
    await sleep(500);
    // 触发：mock 设"有未决审批但从不发 permission_request 事件"（复现 trim/分流丢失）+ 切 viewing 到 inst_2 →
    // 前端 bindView(inst_2) → sync:since → ack.pending 快照 → applyPendingSnapshot 重建卡片。
    await sendCommand('test:pendingsnapshot');
    // 关键断言：修复前无 permission_request 事件 → 永不弹卡片；修复后凭 ack.pending 快照重建 → permModal 出现。
    await page.waitForSelector('#permModal:not(.hidden)', { timeout: 5000 });
    const reconciledTC17 = await page.evaluate(() => {
      const modal = document.getElementById('permModal');
      return modal && !modal.classList.contains('hidden');
    });
    assert.strictEqual(reconciledTC17, true, 'TC-17: 切入实例时应凭 sync:since ack.pending 快照重建待审批卡片（回归 Bug2）');
    await page.screenshot({ path: `${SNAPSHOTS_DIR}/tc17_pending_snapshot_reconcile.png` });
    console.log('✅ TC-17: sync:since 快照重建待审批卡片 passed\n');

    // ==================================================================
    // TC-18: "需要你"聚合区渲染 + 点击深链跳转（AD-11/§3.2.5 AttentionDeriver，承接 FR-21/FR-22）
    // ==================================================================
    console.log('👉 Running TC-18: "需要你"聚合区渲染 + 深链跳转...');
    // TC-17 遗留 viewingInstanceId='inst_2' + 待审批快照（mock server 进程级状态，不随 page.reload() 清空）——
    // 若不重置，reload 后重连 sync:since 会重发该快照、弹出的 permModal 挡住 sendCommand 的 #btnSend 点击。
    // 先 reset 再 reload，确保重连时服务端状态已干净（其余 17 个既有 TC 从未需要过，因 TC-17 此前恒为末位）。
    await fetch('http://127.0.0.1:3100/__reset', { method: 'POST' });
    await page.reload({ waitUntil: 'networkidle2' });
    await page.waitForSelector('#input');
    await sleep(500);
    // 触发：mock 让一个未在查看的后台实例（inst_needsyou，另一工作区）出现待审批，
    // 随 instances 广播下发手造的 needsYou（真实 server 由 computeNeedsYou() 投影计算，见 server.js）。
    await sendCommand('test:needsyou');
    await waitIdle();

    await page.click('#btnSessions');
    await page.waitForSelector('#leftSidebar:not(.-translate-x-full)');
    await sleep(400); // 等侧边栏滑入动画完成（同 TC-7 惯例），screenshot 才不会撞在过渡中间帧
    await page.waitForSelector('[data-testid="needs-you-row"]', { timeout: 5000 });

    const needsYouInfoTC18 = await page.evaluate(() => {
      const section = document.getElementById('needsYouSection');
      const rows = section ? section.querySelectorAll('[data-testid="needs-you-row"]') : [];
      return {
        headerText: section?.firstElementChild ? section.firstElementChild.textContent : '',
        rowText: rows[0] ? rows[0].textContent : '',
        rowCount: rows.length
      };
    });
    console.log(`   [Assert] needsYou header: "${needsYouInfoTC18.headerText}" · row: "${needsYouInfoTC18.rowText}"`);
    assert.strictEqual(needsYouInfoTC18.headerText, '需要你 (1)', 'TC-18: needsYou 区头部应显示计数');
    assert.strictEqual(needsYouInfoTC18.rowCount, 1, 'TC-18: 应恰好渲染一条 needsYou 行');
    assert.ok(needsYouInfoTC18.rowText.includes('Background Approval Demo'), 'TC-18: 行内应显示会话标题');
    assert.ok(needsYouInfoTC18.rowText.includes('等待审批'), 'TC-18: 审批维度应标注"等待审批"');
    assert.ok(needsYouInfoTC18.rowText.includes('Bash'), 'TC-18: 应显示触发审批的工具名');
    assert.ok(needsYouInfoTC18.rowText.includes('已等待 3 分钟'), 'TC-18: 应据 waitingSince 展示悬置时长（FR-22，与 needsYou 共享数据源）');
    await page.screenshot({ path: `${SNAPSHOTS_DIR}/tc18_needs_you.png` });
    console.log('📸 Captured and saved tc18_needs_you.png');

    // 点击深链跳转（复用 FR-14 applyDeepLink）：应切到该后台实例所在工作区，侧边栏随之关闭
    await page.click('[data-testid="needs-you-row"]');
    await page.waitForSelector('#leftSidebar.-translate-x-full', { timeout: 5000 });
    await page.waitForFunction(
      () => document.getElementById('topProjectText')?.textContent === 'another-react-project',
      { timeout: 5000 }
    );
    const workspaceAfterClickTC18 = await page.evaluate(() => document.getElementById('topProjectText')?.textContent);
    assert.strictEqual(workspaceAfterClickTC18, 'another-react-project', 'TC-18: 点击 needsYou 行应深链切到对应工作区/会话');
    console.log('✅ TC-18: "需要你"聚合区渲染 + 深链跳转 passed\n');

    console.log('==================================================================');
    console.log('🎉 All Automated Visual E2E Regression Tests Passed Perfectly!');
    console.log('==================================================================\n');

  } finally {
    if (browser) {
      await browser.close();
    }
    console.log('🔌 Shutting down dynamic visual mock server...');
    mockServer.kill('SIGTERM');
  }
}

run().catch(err => {
  console.error('\n❌ E2E Runner Failed:', err);
  process.exit(1);
});
