// 服务状态与诊断类面板：安全体检（doctor）、服务状态 sheet（含 hooks / statusline 桥一键安装）、设置里的推送状态行与测试推送、
// hooks / statusline 桥小节、服务端日志、重载 / 本机重置、二维码配对、审批规则。
// #359 Step 1 从 app.js 原样迁出；app.js 里跨模块的可变态经 getter / setter 注入。

import { authFailurePath, describePushTestResult, dumpDurableOutbox, formatAgoShort, formatAuditEntry, formatHooksBridgeRow, formatPushStatusRow, formatRestartRows, formatServiceNoticeRows, formatStatuslineBridgeRow, localResetConfirm, pushEnvHint, readPushOptOut, serviceStatusBasicRows } from '../logic.js';
import { t } from '../i18n.js';

export function createServiceStatus(context, {
  $, addBar, appConfirm, closeSheet, el, isLanOrLocal, localReset, notifications, openSheet,
  outboxDeadLetters, outboxInFlight, reopenGeneralAt, requestCwd, rttMonitor, setGestureDismiss, socket,
  wireConfigRefreshButton, getGeneral, getGeneralNav, getLatestServiceHealth, getOfflineQueue,
  setGeneralPushSubscribed,
} = {}) {
  // ④ UI 安全体检：点击 → doctor:run（鉴权 socket）→ 渲染逐项 pass/warn/fail + 危险白名单 + 就绪度横幅。
  function renderDoctor(rep, box) {
    box.replaceChildren();
    if (!rep || !Array.isArray(rep.checks)) {
      const e = el(`<div class="text-danger"></div>`); e.textContent = t('体检失败或无响应'); box.appendChild(e); return;
    }
    const R = { ready: ['✅', 'text-success'], caution: ['⚠️', 'text-warning'], blocked: ['🚫', 'text-danger'] };
    const [ricon, rcls] = R[rep.readiness?.level] || ['', 'text-ink'];
    const banner = el(`<div class="font-semibold mb-1.5"></div>`);
    banner.className = `font-semibold mb-1.5 ${rcls}`;
    banner.textContent = `${ricon} ${rep.readiness?.summary || ''}`;
    box.appendChild(banner);
    const SI = { ok: '✓', warn: '⚠', fail: '✗' }, SC = { ok: 'text-success', warn: 'text-warning', fail: 'text-danger' };
    for (const c of rep.checks) {
      const row = el(`<div class="flex items-start gap-2 py-1 border-b border-line-soft"><span></span><div class="flex-1 min-w-0"><div class="font-mono text-ink"></div><div class="text-ink-faint break-words"></div></div></div>`);
      const sp = row.querySelector('span');
      const [idDiv, detDiv] = row.querySelectorAll('.flex-1 > div');
      sp.textContent = SI[c.status] || '·'; sp.className = SC[c.status] || 'text-ink-faint';
      idDiv.textContent = c.id; detDiv.textContent = c.detail || '';
      box.appendChild(row);
      if (c.id === 'WHITELIST' && c.safe?.dangerous?.length) {  // 危险规则明细：显规则串 + scope（让用户知道改哪个文件）
        for (const d of c.safe.dangerous) {
          const dr = el(`<div class="text-danger pl-6 break-words"></div>`);
          dr.textContent = `⚠ ${d.rule} —— ${d.reason}（${d.scope || '?'}）`;
          box.appendChild(dr);
        }
      }
    }
  }
  // 会话设置标题行右侧 ↻（常驻）；新会话页摘要旁那个同源入口在 showComposeSurface 里接线。
  // spinEl 取不到时回落按钮本身——|| 而非默认参数：querySelector 返回 null 不会触发默认值。
  const cfgRefreshBtn = $('btnConfigRefresh');
  wireConfigRefreshButton(cfgRefreshBtn, cfgRefreshBtn?.querySelector('[data-spin]') || cfgRefreshBtn);

  // 展开/收起共用同一个入口：报告是十几行的长列表（还带 WHITELIST 明细），只给"展开"就没有回程
  // 路径——诊断区另两个入口是 bottom sheet 自带 ✕，唯独这块是内联展开，展开后把设置列表顶出屏幕。
  // 尾部再挂一个同源收起行：长报告看完停在底部，不必滚回按钮。
  const btnSecurityCheck = $('btnSecurityCheck'), doctorBox = $('doctorReport');
  function setDoctorOpen(open) {
    doctorBox.classList.toggle('hidden', !open);
    if (!open) doctorBox.replaceChildren(); // 收起即清空：下次展开必重跑，不留过期快照
    btnSecurityCheck.textContent = open ? t('🔍 安全体检 · 收起结果 ▲') : t('🔍 安全体检 · 公网暴露前自查 →');
    btnSecurityCheck.setAttribute('aria-expanded', String(open));
  }
  if (btnSecurityCheck && doctorBox) btnSecurityCheck.onclick = () => {
    if (!doctorBox.classList.contains('hidden')) { setDoctorOpen(false); return; }
    setDoctorOpen(true);
    const loading = el(`<div class="text-ink-faint"></div>`); loading.textContent = t('🔍 体检中…'); doctorBox.appendChild(loading);
    socket.emit('doctor:run', {}, rep => {
      if (doctorBox.classList.contains('hidden')) return; // 体检期间被收起：丢弃迟到的 ack，别把面板重新撑开
      renderDoctor(rep, doctorBox);
      const foot = el(`<button type="button" class="w-full mt-2 py-1.5 rounded-lg border border-line text-ink-soft active:bg-sunk"></button>`);
      foot.textContent = t('▲ 收起体检结果');
      foot.onclick = () => setDoctorOpen(false);
      doctorBox.appendChild(foot);
    });
  };

  // ---- 服务状态面板 ----
  // 设置「访问与设备」组入口 → 底部 sheet 两段渲染：基础(时长/版本/连接/日志开关) + 异常告警（判定化：
  // 裸计数器段已撤——对人无参照系不可解读，原始计数留 /metrics 巡检端点；有信号项升格为带时效窗告警）。
  // 数据走鉴权 service:status ack（doctor:run 同构）；打开即拉、开着时 5s 重拉（后台 tab 跳过）、关闭即停。
  const serviceStatusModal = $('serviceStatusModal'), serviceStatusBody = $('serviceStatusBody');
  let serviceStatusTimer = null;
  function renderServiceStatus(res, auditRecords) {
    if (!serviceStatusBody) return;
    const now = Date.now();
    const section = (title, titleSuffix) => {
      const s = el(`<div><div class="text-xs font-semibold text-ink-soft mb-2"></div><div class="rounded-xl border border-line bg-surface"></div></div>`);
      s.firstChild.textContent = title;
      if (titleSuffix) {
        const soft = el(`<span class="font-normal text-ink-faint"></span>`);
        soft.textContent = ` ${titleSuffix}`;
        s.firstChild.appendChild(soft);
      }
      return s;
    };
    const addRow = (card, label, value, valueClass) => {
      const row = el(`<div class="flex items-center justify-between gap-3 px-3 py-2.5 text-xs border-t border-line-soft first:border-t-0"><span class="text-ink-soft font-medium shrink-0"></span><span class="text-ink text-right tabular-nums"></span></div>`);
      row.firstChild.textContent = label;
      row.lastChild.textContent = value;
      if (valueClass) row.lastChild.classList.add(valueClass);
      card.appendChild(row);
    };
    serviceStatusBody.replaceChildren();
    // 段1 基础：连接状态取自本 socket 与 RTT 监视器（不另发 ping）
    const basic = section(t('基础'));
    for (const r of serviceStatusBasicRows({ startedAt: res.startedAt, versions: res.versions, connected: socket.connected, rttMs: rttMonitor.last(), now, logging: res.logging })) {
      addRow(basic.lastChild, r.label, r.value, r.alert ? 'text-warning' : null); // 日志开关：SDK 调试开着标黄（忘关观测点）
    }
    serviceStatusBody.appendChild(basic);
    // 段2 异常告警：与抽屉「服务」小节同一纯函数（文案一致）。
    // 服务端已按时效窗判定（超窗自动退场），此处只渲染。
    const noticesSection = section(t('异常告警'));
    const notices = formatServiceNoticeRows({
      service: {
        deliveryFailure: res.deliveryFailure,
        rateLimitLockout: res.rateLimitLockout,
        clientError: res.clientError,
        proxyFronted: res.proxyFronted,
        missingFolders: res.missingFolders,
      },
      now,
    });
    if (!notices.length) {
      const okRow = el(`<div class="px-3 py-2.5 text-xs text-success"></div>`);
      okRow.textContent = t('✓ 无异常');
      noticesSection.lastChild.appendChild(okRow);
    } else {
      for (const { text, tone } of notices) {
        const row = el(`<div class="px-3 py-2.5 text-xs border-t border-line-soft first:border-t-0"></div>`);
        // 判色在 formatServiceNoticeRows：投递失败红；限速锁定按来源（公网红、本机/局域网黄）；其余黄
        row.classList.add(tone === 'danger' ? 'text-danger' : 'text-warning');
        row.textContent = text;
        noticesSection.lastChild.appendChild(row);
      }
    }
    serviceStatusBody.appendChild(noticesSection);
    // 段3 安全日志：上面那段告警的下钻。告警说「发生了什么」（限速锁定过、推送失败过），
    // 这一段回答「是谁、几次、从哪来」——审计记录自始就在写，此前 web 端没有任何读取面。
    const auditSection = section(t('安全日志'), t('（最近 20 条）'));
    auditSection.id = 'serviceAuditSection'; // 「排查」页那条入口的深链落点（openServiceStatus 的 anchor）
    if (!Array.isArray(auditRecords)) {
      const row = el(`<div class="px-3 py-2.5 text-xs text-ink-faint"></div>`);
      row.textContent = t('暂时读取不到（服务端未响应）');
      auditSection.lastChild.appendChild(row);
    } else if (!auditRecords.length) {
      const row = el(`<div class="px-3 py-2.5 text-xs text-ink-faint"></div>`);
      row.textContent = t('暂无记录');
      auditSection.lastChild.appendChild(row);
    } else {
      // 不复用 addRow：那是「标签 : 数值」的两栏行（右栏 text-right tabular-nums），审计文案
      // 是长句子，右对齐 + 等宽数字在窄屏上会折成难读的阶梯。这里用「时间靠左、文案满宽」的布局。
      for (const rec of auditRecords) {
        const entry = formatAuditEntry(rec);
        const tone = entry.severity === 'danger' ? 'text-danger' : entry.severity === 'warning' ? 'text-warning' : 'text-ink';
        const row = el(`<div class="flex items-baseline gap-2 px-3 py-2 text-xs border-t border-line-soft first:border-t-0"><span class="text-ink-faint shrink-0 tabular-nums"></span><span class="flex-1 break-words"></span></div>`);
        row.firstChild.textContent = formatAgoShort(now - entry.ts);
        row.lastChild.textContent = entry.text;
        row.lastChild.classList.add(tone);
        auditSection.lastChild.appendChild(row);
      }
    }
    serviceStatusBody.appendChild(auditSection);
    // 段4 重启记录：谁在什么时候重启过。launchd 只留「最后一次退出码」那个瞬时值，
    // 而那回答不了「这正常吗」—— 每天一次是路由器换 IP，一小时内三次才是真出事。
    const restartSection = section(t('重启记录'));
    const restartView = formatRestartRows({ restarts: res.restarts, now });
    if (restartView.empty) {
      const row = el(`<div class="px-3 py-2.5 text-xs text-ink-faint"></div>`);
      row.textContent = t('暂无记录（服务启动后开始采样）');
      restartSection.lastChild.appendChild(row);
    } else {
      for (const item of restartView.summary) {
        addRow(restartSection.lastChild, item.label, item.text, item.alert ? 'text-warning' : null);
      }
      for (const item of restartView.timeline) {
        addRow(restartSection.lastChild, item.label, item.text, 'text-ink-faint');
      }
    }
    serviceStatusBody.appendChild(restartSection);
    const hint = el(`<div class="text-[10px] text-ink-faint"></div>`);
    hint.textContent = t('数据每 5 秒自动刷新 · 告警超 24 小时自动退场 · 原始计数见 /metrics');
    serviceStatusBody.appendChild(hint);
  }
  // 桥安装 / 卸载的回执就地写在那一段下面（验收 O62）：原来走 addBar 插进聊天流，而用户此刻正对着设置面板，
  // 被面板挡住看不到——点了「开启」只看到按钮转一下又回到原样。结果行在 body 外面，段落重画不会把它冲掉。
  function showBridgeSetupResult(id, text, ok) {
    const box = $(id);
    if (!box) return;
    box.textContent = text;
    box.classList.toggle('text-danger', !ok);
    box.classList.toggle('text-ink-soft', ok);
    box.classList.remove('hidden');
  }
  // 一键安装/卸载 hooks 桥。安装要写用户全局 ~/.claude/settings.json，所以先明确确认——
  // 这是 server 唯一会动那个文件的路径，必须让用户知道自己在批准什么。
  // 报告直接回显安装器输出（含四种结局文案），不在前端另写一套话术。
  // 同 runHooksSetup：装/卸都要二次确认——它改的是用户全局 ~/.claude/settings.json。
  async function runStatuslineSetup(action, btn) {
    const installing = action === 'install';
    const okConfirm = await appConfirm({
      title: installing ? t('开启终端状态栏同步？') : t('关闭终端状态栏同步？'),
      body: installing
        ? t('会接管 ~/.claude/settings.json 里的 statusLine 命令，并原样透传你原来的输出（原命令会先备份）。已在跑的终端会话需重开才生效。')
        : t('会把 statusLine 命令恢复成你原来的那条，备份记录随之删除。'),
      okText: installing ? t('开启') : t('关闭'),
      tone: installing ? 'default' : 'warn',
    });
    if (!okConfirm) return;
    btn.disabled = true;
    btn.textContent = t('处理中…');
    socket.timeout(25000).emit('statusline:setup', { action }, (err, res) => {
      btn.disabled = false;
      // 同 hooks 侧：用 ack 自带的 state 立刻回填再重渲，不把按钮的解锁押在广播上
      if (res?.state && getLatestServiceHealth()?.statuslineBridge) getLatestServiceHealth().statuslineBridge.state = res.state;
      renderStatuslineBridgeSection();
      if (err || !res) { showBridgeSetupResult('statuslineBridgeResult', t('操作超时，请重试'), false); loadServiceStatus(); return; }
      // report 是安装器的英文原话；认得出的原因码按界面语言说（验收 O125）
      const reason = res.code === 'statusline_not_configured'
        ? t('还没配置 statusLine：先在 ~/.claude/settings.json 里给 Claude Code 配好 statusLine，再回来开启') : '';
      showBridgeSetupResult('statuslineBridgeResult', reason || res.report || (res.ok ? t('已完成') : t('操作失败')), res.ok);
      loadServiceStatus();
    });
  }

  async function runHooksSetup(action, btn) {
    const installing = action === 'install';
    const okConfirm = await appConfirm({
      title: installing ? t('开启终端会话推送？') : t('关闭终端会话推送？'),
      body: installing
        ? t('会往 ~/.claude/settings.json 追加两个 hook（你已有的配置原样保留）。已在跑的终端会话需重开才生效。')
        : t('会移除本项目添加的那两个 hook 条目，你已有的 hooks 不受影响。'),
      okText: installing ? t('开启') : t('关闭'),
      tone: installing ? 'default' : 'warn',
    });
    if (!okConfirm) return;
    btn.disabled = true;
    btn.textContent = t('处理中…');
    socket.timeout(25000).emit('hooks:setup', { action }, (err, res) => {
      btn.disabled = false;
      // 用 ack 自带的 state 立刻回填再重渲：只等 instances 广播的话，按钮会一直卡在「处理中…」
      // （广播若没来或迟到，这段就再也不会重画）。广播随后到达只是二次确认，不是唯一依赖。
      if (res?.state && getLatestServiceHealth()?.hooksBridge) getLatestServiceHealth().hooksBridge.state = res.state;
      renderHooksBridgeSection();
      if (err || !res) { showBridgeSetupResult('hooksBridgeResult', t('操作超时，请重试'), false); loadServiceStatus(); return; }
      showBridgeSetupResult('hooksBridgeResult', res.report || (res.ok ? t('已完成') : t('操作失败')), res.ok);
      loadServiceStatus(); // 服务状态页开着时顺带刷新
    });
  }

  // 服务状态与安全日志是两个 ack，但必须凑齐了画一次：renderServiceStatus 是 replaceChildren
  // 全量重绘，各自到达各自渲染会互相冲掉（先到的那段被后到的整体替换掉）。
  const emitServiceAck = (event, payload) => new Promise(resolve => {
    socket.timeout(3000).emit(event, payload, (err, res) => resolve(err ? null : res));
  });
  async function loadServiceStatus() {
    if (!serviceStatusModal || !serviceStatusModal.classList.contains('sheet-open')) return;
    const [status, auditRes] = await Promise.all([
      emitServiceAck('service:status', {}),
      // 20 条：手机上一屏能扫完的量。环形上限是 5000，全量回传是白发几百 KB。
      emitServiceAck('audit:get', { limit: 20 }),
    ]);
    if (!status || status.ok !== true) return; // 断线/未审批设备无 ack：面板留旧值，不挂 spinner
    // WS-019 同款迟到 ack 守卫：回包时面板已关则丢弃，防对着 hidden DOM 白渲染
    if (!serviceStatusModal.classList.contains('sheet-open')) return;
    // null（拿不到）与 []（拿到了、确实没有记录）是两件事，渲染时说法不同
    renderServiceStatus(status, auditRes?.ok === true ? (auditRes.records || []) : null);
  }
  // 点 ← 与点遮罩都走这里：同一张面板两种关法落到两个不同的地方，正是用户会再踩一次的坑。
  // 来源页是变量而不是写死的 'host'：这张面板现在有两个入口（🖥 宿主机的「服务状态」、
  // 🩺 排查的「安全日志」），写死会把从排查进来的人退回另一页——同二层面板退出语义那条老坑。
  let serviceStatusFrom = 'host';
  // 每次打开递增。loadServiceStatus 的迟到守卫只问「面板现在开着吗」，答不了「是哪一次打开」——
  // 慢 ack 下：从「排查」深链进来（带 anchor）→ 返回 → 从「宿主机」重开，第一次的 await 这时
  // 才恢复，守卫看到面板确实开着就放行，于是把审计段的落点应用到了后开的那一次上，
  // 用户会看到 host 入口进来的面板莫名其妙自己滚到安全日志。
  let serviceStatusOpenSeq = 0;
  function closeServiceStatus() {
    if (serviceStatusTimer) { clearInterval(serviceStatusTimer); serviceStatusTimer = null; }
    serviceStatusOpenSeq++; // 关了就作废：在途的那次 await 恢复后不得再滚
    if (serviceStatusModal) closeSheet(serviceStatusModal);
    reopenGeneralAt(serviceStatusFrom);
  }
  async function openServiceStatus({ from = 'host', anchor = null } = {}) {
    if (!serviceStatusModal) return;
    const seq = ++serviceStatusOpenSeq;
    serviceStatusFrom = from;
    getGeneral().close(); // 从通用设置切入：先收设置 sheet 再弹状态 sheet（两者同 z-40，叠着互相拦点击）
    openSheet(serviceStatusModal);
    if (serviceStatusTimer) clearInterval(serviceStatusTimer);
    serviceStatusTimer = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      loadServiceStatus();
    }, 5000);
    await loadServiceStatus();
    if (seq !== serviceStatusOpenSeq) return; // 期间被关过或重开过：这个 anchor 属于上一次打开
    // 深链滚动必须等首帧渲染完：段落全是 renderServiceStatus 现建的，await 之前 bounding box 是 0。
    // 只滚这一次——5s 重拉会整段 replaceChildren，每次都滚会把用户按住不动的手指一起拽走。
    if (anchor) requestAnimationFrame(() => $(anchor)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  }
  if ($('btnServiceStatus')) $('btnServiceStatus').onclick = () => void openServiceStatus({ from: 'host' });
  if ($('serviceStatusBack')) $('serviceStatusBack').onclick = closeServiceStatus;
  // #399：把手下拉与 ← / 遮罩同一条关闭路径（退回来源设置页）
  setGestureDismiss(serviceStatusModal, () => closeServiceStatus());
  // 「排查」页的安全日志入口：同一张面板，落点直接滚到审计那一段。此前这一段只有"先开服务状态、
  // 再往下翻三屏"这一条路，而 L1 副标题一直列着「安全日志」。
  if ($('btnDiagSecurityLog')) {
    $('btnDiagSecurityLog').onclick = () => void openServiceStatus({ from: 'diag', anchor: 'serviceAuditSection' });
  }

  if (serviceStatusModal) serviceStatusModal.onclick = e => { if (e.target === serviceStatusModal) closeServiceStatus(); };

  // 配置面板「推送内容」段顶部的订阅状态行。推送不通时此前 UI 上零痕迹——铃铛按钮在权限被拒或
  // 订阅失败时都不显示，用户查不出自己为什么收不到（实测：实测环境中从未订阅成功过而毫不知情）。
  const pushStatusRowEl = $('pushStatusRow'), pushPreviewInertNote = $('pushPreviewInertNote');
  async function renderPushStatusRow() {
    if (!pushStatusRowEl) return;
    let subscribed = false;
    try {
      // ⚠️ navigator.serviceWorker.ready 在「没有任何 SW 注册」时**永远不 resolve**（不是 reject）。
      // 直接 await 会让本函数挂住，整行永远不渲染——正是"界面上什么都没有"的那类静默失败。
      const reg = await Promise.race([
        navigator.serviceWorker?.ready,
        new Promise(r => setTimeout(() => r(null), 1500)),
      ]);
      subscribed = !!(await reg?.pushManager?.getSubscription());
    } catch { /* 不支持/未注册 SW：按未订阅渲染，由 hint 解释原因 */ }
    // 没订阅时「推送带内容预览」是空转的——把这件事说出来，别让人勾了以为生效
    pushPreviewInertNote?.classList.toggle('hidden', subscribed);
    // L1 目录「通知」那行吃同一份判据：面板里说「未开启」、目录里说「已开」会是自相矛盾的两句话
    setGeneralPushSubscribed(subscribed);
    getGeneralNav()?.render();
    const row = formatPushStatusRow({
      hint: pushEnvHint(notifications.environment()),
      permission: typeof Notification !== 'undefined' ? Notification.permission : 'default',
      subscribed,
      // 自己关掉的与订阅失败在 permission/subscribed 上同形，只有这个意图分得开
      optedOut: readPushOptOut(k => localStorage.getItem(k)),
    });
    pushStatusRowEl.replaceChildren();
    const card = el(`<div class="flex items-center justify-between gap-3 p-2.5 rounded-xl border border-line bg-surface text-xs text-ink"><span class="min-w-0"></span></div>`);
    const value = el(`<span class="font-semibold block"></span>`);
    value.textContent = row.value;
    const toneCls = { ok: 'text-success', warn: 'text-warning' }[row.tone];
    if (toneCls) value.classList.add(toneCls);
    card.firstChild.appendChild(value);
    if (row.hint) {
      const h = el(`<span class="text-xs text-ink-soft"></span>`);
      h.textContent = row.hint;
      card.firstChild.appendChild(h);
    }
    // 两个方向共用一个按钮位：开与关是同一个开关的两侧，不该只有进、没有出。
    if (row.action === 'subscribe' || row.action === 'unsubscribe') {
      const off = row.action === 'unsubscribe';
      const btn = el(`<button class="shrink-0 px-3 py-1.5 rounded-lg border border-line text-xs active:opacity-70"></button>`);
      btn.dataset.testid = off ? 'push-unsubscribe' : 'push-subscribe';
      btn.textContent = row.actionText;
      btn.onclick = async () => {
        btn.disabled = true;
        // 开启那条走 requestSubscription，它自己用 explain() 写 #pushSubscribeResult（#381，不再系统 alert）。
        if (!off) {
          await notifications.requestSubscription();
          btn.disabled = false;
          renderPushStatusRow();
          return;
        }
        const ok = await notifications.unsubscribe();
        btn.disabled = false;
        await renderPushStatusRow();
        // 成功：状态行当场翻成「已关闭」，那就是回答；addBar 那条是留给关掉面板之后的账
        //（与 app/session-delete.js 的成功路径同构）。
        // 失败：状态行原样不动 = 用户眼里的"点了没反应"，错因必须落在他此刻正看着的这一层。
        // #generalSheet 是 z-40 的大底栏，盖着消息流——只写 addBar 等于没写（2026-09-12 抽屉里
        // 撞过同一个坑）。这行插在重绘之后，下次重绘自然被 replaceChildren 清掉。
        if (ok) addBar(t('🔕 已关闭推送通知'), 'text-ink-soft');
        else {
          const notice = el(`<div class="mt-1.5 text-[11px] text-warning px-1"></div>`);
          notice.textContent = t('⚠️ 关闭推送失败，请重试');
          pushStatusRowEl.appendChild(notice);
        }
      };
      card.appendChild(btn);
    }
    pushStatusRowEl.appendChild(card);
  }

  // 「发一条测试推送」：自证推送链路，不必等真事件。结果如实回报——发出去几条、失败几条、
  // 有没有收件人。"没有订阅"是最常见也最容易被误当成"功能坏了"的情况，要说清楚。
  if ($('btnPushTest')) $('btnPushTest').onclick = () => {
    const btn = $('btnPushTest');
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = t('发送中…');
    // 12s：服务端要等 ntfy 的投递结果（它自带 8s 超时），8s 的话 ntfy 一慢就误报成断网
    socket.timeout(12_000).emit('push:test', {}, (err, res) => {
      btn.disabled = false;
      btn.textContent = original;
      const permission = typeof Notification !== 'undefined' ? Notification.permission : 'default';
      const r = describePushTestResult(err ? null : res, { permission, hint: pushEnvHint(notifications.environment()) });
      const cls = { ok: 'text-success', warn: 'text-warning', danger: 'text-danger' }[r.tone];
      addBar(r.text, cls);
      // 设置面板是 z-40 的大底栏、盖着消息流，只写 addBar 等于没写（同 renderPushStatusRow 里关闭失败那条）：
      // 结果就地落在按钮下面，用户此刻正看着这一层
      let notice = $('pushTestResult');
      if (!notice) {
        notice = el(`<div id="pushTestResult" role="status" data-testid="push-test-result"></div>`);
        btn.after(notice);
      }
      notice.className = `text-[11px] px-1 ${cls}`;
      notice.textContent = r.text;
      // 按钮在通知页底部：iPhone 13（390×664）下这一行刚好落在视口外，只露半行（O112）
      notice.scrollIntoView({ block: 'nearest' });
    });
  };

  // 配置面板的「终端会话推送」段（CLI hooks 桥）。放在通知这一组、而不是服务状态诊断页：对用户
  // 而言这就是"电脑终端里跑的会话要不要通知我"，与提示音/震动同一心智——埋进诊断页没人找得到。
  const hooksBridgeSection = $('hooksBridgeSection'), hooksBridgeBody = $('hooksBridgeBody');
  function renderHooksBridgeSection() {
    if (!hooksBridgeSection || !hooksBridgeBody) return;
    const row = formatHooksBridgeRow(getLatestServiceHealth()?.hooksBridge);
    if (!row) { hooksBridgeSection.classList.add('hidden'); return; } // 旧 server / 读不出状态 → 整段缺席
    hooksBridgeSection.classList.remove('hidden');
    hooksBridgeBody.replaceChildren();
    const card = el(`<div class="flex items-center justify-between gap-3 p-2.5 rounded-xl border border-line bg-surface text-xs text-ink"><span class="min-w-0"></span></div>`);
    const label = el(`<span class="font-semibold block"></span>`);
    label.textContent = row.value;
    const toneCls = { ok: 'text-success', warn: 'text-warning', muted: 'text-ink-soft' }[row.tone];
    if (toneCls) label.classList.add(toneCls);
    card.firstChild.appendChild(label);
    const desc = el(`<span class="text-xs text-ink-soft"></span>`);
    desc.textContent = row.hint || t('电脑终端里跑的会话，完成或需要你时通知手机');
    card.firstChild.appendChild(desc);
    if (row.action) {
      const btn = el(`<button class="shrink-0 px-3 py-1.5 rounded-lg border border-line text-xs active:opacity-70" data-testid="hooks-bridge-action"></button>`);
      btn.textContent = row.actionText;
      btn.onclick = () => runHooksSetup(row.action, btn);
      card.appendChild(btn);
    }
    hooksBridgeBody.appendChild(card);
  }

  // 服务日志（server 进程的 stdout/stderr）。与顶栏「运行日志」是两条不同的日志：
  // 那条是前端 clientLogger + 会话交互日志（都在内存里），server 进程的输出一个字都不进去。
  async function loadServerLog() {
    const body = $('serverLogBody');
    if (!body) return;
    body.classList.remove('hidden');
    body.replaceChildren(el('<div class="p-2.5 text-xs text-ink-faint"></div>'));
    body.firstChild.textContent = t('读取中…');
    const res = await new Promise(resolve => {
      socket.timeout(8000).emit('logs:server', { limit: 200 }, (err, r) => resolve(err ? null : r));
    });
    body.replaceChildren();
    const card = el('<div class="p-2.5 rounded-xl border border-line bg-surface text-xs space-y-1"></div>');
    const pathRow = el('<div class="text-[10px] text-ink-faint break-all"></div>');
    pathRow.textContent = res?.path || t('未知路径');
    card.appendChild(pathRow);
    if (!res || res.ok !== true) {
      // 读不到就说读不到。**不给空列表**——空列表看起来像「服务很干净」，
      // 而实际是「我们压根没在看那个文件」。
      const errRow = el('<div class="text-warning"></div>');
      errRow.textContent = res?.error || t('读取失败');
      card.appendChild(errRow);
      body.appendChild(card);
      return;
    }
    if (!res.lines.length) {
      const empty = el('<div class="text-ink-soft"></div>');
      empty.textContent = t('文件是空的（服务刚起来，或日志被轮转过）');
      card.appendChild(empty);
      body.appendChild(card);
      return;
    }
    if (res.truncated) {
      const note = el('<div class="text-[10px] text-ink-faint"></div>');
      note.textContent = t('只显示文件末尾部分');
      card.appendChild(note);
    }
    const pre = el('<div class="mt-1 space-y-0.5 max-h-64 overflow-y-auto"></div>');
    for (const line of res.lines) {
      const row = el('<div class="break-all text-ink-soft" style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px"></div>');
      row.textContent = line; // 日志原文，textContent 插值（CSP 安全）
      pre.appendChild(row);
    }
    card.appendChild(pre);
    const warn = el('<div class="text-[10px] text-ink-faint mt-1"></div>');
    warn.textContent = t('含真实路径与错误原文（未脱敏）——投屏时注意');
    card.appendChild(warn);
    body.appendChild(card);
    // 长日志默认滚到底：最新的一行才是排障要看的
    pre.scrollTop = pre.scrollHeight;
  }
  $('btnServerLog')?.addEventListener('click', () => loadServerLog());

  // 设置页底部两档（#302，见 app/local-reset.js）
  $('btnReloadApp')?.addEventListener('click', async () => {
    const res = await localReset.reloadApp();
    if (res.ok) return;
    const hint = $('localResetHint');
    if (!hint) return;
    hint.textContent = t('有消息正在发送，稍后再试');
    hint.classList.remove('hidden');
    setTimeout(() => hint.classList.add('hidden'), 4000);
  });
  $('btnResetLocal')?.addEventListener('click', async () => {
    // 会丢几条按落盘的口径数（dumpDurableOutbox 按 clientMessageId 去重）：离线队列 + 取出了还没结论的
    const pending = JSON.parse(dumpDurableOutbox(getOfflineQueue(), outboxInFlight.items())).length;
    const accessPath = authFailurePath({ lanOrLocal: isLanOrLocal(), cfAccessFlag: document.body.dataset.cfAccess }) === 'access-relogin';
    const ok = await appConfirm(localResetConfirm({ pending, deadLetters: outboxDeadLetters.count(), accessPath }));
    if (ok) await localReset.resetLocalData();
  });

  // 接入二维码。三步态：入口 → 二次确认 → 显示（带倒计时自动隐藏）。
  // 自动隐藏的秒数刻意短：够扫、不够让人忘了它还挂在屏幕上。
  const QR_AUTO_HIDE_MS = 30_000;
  let qrHideTimer = null;
  let qrTickTimer = null;
  function qrShowStep(step) {
    for (const [n, id] of [[1, 'qrStep1'], [2, 'qrStep2'], [3, 'qrStep3']]) {
      $(id)?.classList.toggle('hidden', n !== step);
    }
  }
  function hideQr() {
    clearTimeout(qrHideTimer); qrHideTimer = null;
    clearInterval(qrTickTimer); qrTickTimer = null;
    // 真的把矩阵从 DOM 里删掉，不只是 hidden——留在 DOM 里的话，任何能看到页面的人
    // （开发者工具、截图、后续的 innerHTML 读取）仍然拿得到那把钥匙。
    const wrap = $('qrCanvasWrap');
    if (wrap) wrap.replaceChildren();
    qrShowStep(1);
  }
  function paintQrMatrix(matrix, size) {
    const wrap = $('qrCanvasWrap');
    if (!wrap) return;
    wrap.replaceChildren();
    // quiet zone 取 4：实测 2 检不出、3/4 可解（见 shared/qrcode.js 的实测记录）
    const quiet = 4;
    const total = size + quiet * 2;
    const cell = Math.max(4, Math.floor(260 / total));
    const cv = document.createElement('canvas');
    cv.width = cv.height = total * cell;
    cv.style.width = cv.style.height = `${total * cell}px`;
    cv.setAttribute('data-testid', 'qr-canvas');
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = '#000';
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (matrix[r][c]) ctx.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell);
      }
    }
    wrap.appendChild(cv);
  }
  async function revealQr() {
    const res = await new Promise(resolve => {
      socket.timeout(8000).emit('connect:qr', { target: 'lan' }, (err, r) => resolve(err ? null : r));
    });
    if (!res?.ok) {
      addBar(res?.error || t('二维码生成失败'), 'text-danger');
      qrShowStep(1);
      return;
    }
    paintQrMatrix(res.matrix, res.size);
    const note = $('qrNote');
    if (note) {
      note.textContent = res.includeToken
        ? t('码里含访问令牌，扫一下即可接入')
        : (res.note || t('该域名受 Cloudflare Access 保护，码里不含令牌'));
    }
    qrShowStep(3);
    let left = Math.floor(QR_AUTO_HIDE_MS / 1000);
    const tick = () => {
      const el2 = $('qrCountdown');
      if (el2) el2.textContent = `${left} ${t('秒后自动隐藏')}`;
    };
    tick();
    clearInterval(qrTickTimer);
    qrTickTimer = setInterval(() => { left -= 1; tick(); }, 1000);
    clearTimeout(qrHideTimer);
    qrHideTimer = setTimeout(hideQr, QR_AUTO_HIDE_MS);
  }
  $('btnQrReveal')?.addEventListener('click', () => qrShowStep(2));
  $('btnQrCancel')?.addEventListener('click', () => qrShowStep(1));
  $('btnQrConfirm')?.addEventListener('click', () => revealQr());
  $('btnQrHide')?.addEventListener('click', () => hideQr());

  // 审批规则（只读）。按需拉——不进 instances 广播，理由见 server 侧 handler 头注。
  let permissionRulesCache = null;
  async function loadPermissionRules() {
    const res = await new Promise(resolve => {
      socket.timeout(5000).emit('permissions:rules', { cwd: requestCwd() || null }, (err, r) => resolve(err ? null : r));
    });
    // 断线/读失败：保留上一次拿到的名单，不把已经显示对的东西刷成空
    if (res?.ok === true) permissionRulesCache = res.rules;
    renderPermissionRules();
  }
  function renderPermissionRules() {
    const section = $('permissionRulesSection'), body = $('permissionRulesBody');
    if (!section || !body) return;
    const rules = permissionRulesCache;
    // null = 这台机器没配过审批规则（或读不出来）→ 整段缺席。**不显示空名单**：
    // 「我没有规则」与「我没读到」在安全上是两件事，后者显示成空会让人以为自己没配过。
    if (!rules || !rules.total) { section.classList.add('hidden'); return; }
    section.classList.remove('hidden');
    body.replaceChildren();
    // 三档各一张卡。deny 用 danger 色——把它显示成和 allow 一样会让人以为危险操作已被放行。
    const groups = [
      { key: 'allow', list: rules.allow, label: t('直接放行 · 不弹审批'), tone: 'text-success' },
      { key: 'deny', list: rules.deny, label: t('直接拒绝'), tone: 'text-danger' },
      { key: 'ask', list: rules.ask, label: t('每次都问'), tone: 'text-ink-soft' },
    ];
    for (const g of groups) {
      if (!Array.isArray(g.list) || !g.list.length) continue;
      const card = el('<div class="p-2.5 rounded-xl border border-line bg-surface text-xs"></div>');
      card.setAttribute('data-rule-group', g.key);
      const head = el('<div class="font-semibold"></div>');
      head.className = `font-semibold ${g.tone}`;
      head.textContent = `${g.label} · ${g.list.length}`;
      card.appendChild(head);
      const ul = el('<div class="mt-1 space-y-0.5"></div>');
      for (const rule of g.list) {
        const row = el('<div class="text-ink-soft break-all" style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace"></div>');
        row.textContent = rule; // 规则是用户写的文本，textContent 插值（CSP 安全）
        ul.appendChild(row);
      }
      card.appendChild(ul);
      body.appendChild(card);
    }
  }

  // statusline 桥段。与 renderHooksBridgeSection 同构——两个桥在面板上并列，渲染惯例也保持一致。
  function renderStatuslineBridgeSection() {
    const section = $('statuslineBridgeSection'), body = $('statuslineBridgeBody');
    if (!section || !body) return;
    const row = formatStatuslineBridgeRow(getLatestServiceHealth()?.statuslineBridge);
    if (!row) { section.classList.add('hidden'); return; } // 旧 server 无此字段 → 整段缺席
    section.classList.remove('hidden');
    body.replaceChildren();
    const card = el(`<div class="flex items-center justify-between gap-3 p-2.5 rounded-xl border border-line bg-surface text-xs text-ink"><span class="min-w-0"></span></div>`);
    const label = el(`<span class="font-semibold block"></span>`);
    label.textContent = row.value;
    const toneCls = { ok: 'text-success', warn: 'text-warning', muted: 'text-ink-soft' }[row.tone];
    if (toneCls) label.classList.add(toneCls);
    card.firstChild.appendChild(label);
    const desc = el(`<span class="text-xs text-ink-soft"></span>`);
    desc.textContent = row.hint || t('终端会话的模型 / 额度 / 上下文用量同步到手机');
    card.firstChild.appendChild(desc);
    if (row.action) {
      const btn = el(`<button class="shrink-0 px-3 py-1.5 rounded-lg border border-line text-xs active:opacity-70" data-testid="statusline-bridge-action"></button>`);
      btn.textContent = row.actionText;
      btn.onclick = () => runStatuslineSetup(row.action, btn);
      card.appendChild(btn);
    }
    body.appendChild(card);
  }

  return { emitServiceAck, hideQr, loadPermissionRules, renderHooksBridgeSection, renderPushStatusRow, renderStatuslineBridgeSection };
}
