// app/about-page.js —— 设置「关于」页（#303）：版本与作者、许可证原文、第三方组件、检查更新。
//
// 数据进页时取一次（about:get），之后复用；版本号不另取，用「宿主机」页那份 service:status 的 versions。
// 许可证与声明原文只用 textContent 放进 <pre>：不改写、不翻译，也不经 innerHTML。
// 「检查更新」由服务端打 GitHub（缓存、合并并发、超时在 app/src/ops/update-check.js），这里只说结果。

import { t } from '../i18n.js';
import { describeUpdateCheck } from '../logic.js';

const TONE_CLASS = { ok: 'text-success', warn: 'text-warning', muted: 'text-ink-soft', error: 'text-danger' };
// 服务端查 GitHub 的超时是 5s；这里多留一截，免得服务端还在等、前端先报了失败
const CHECK_TIMEOUT_MS = 10_000;

export function createAboutPage({ $, emit, getVersion }) {
  let info = null;
  let loading = false;

  function renderVersion() {
    const v = getVersion();
    $('aboutVersion').textContent = typeof v === 'string' && v && v !== 'unknown' ? `v${v}` : '—';
  }

  function link(id, text, href) {
    const a = $(id);
    a.textContent = text || '—';
    if (href) a.href = href;
  }

  function renderInfo() {
    link('aboutAuthor', info.author?.name, info.author?.url);
    link('aboutRepo', info.repository?.replace(/^https:\/\//, ''), info.repository);
    $('aboutLicenseText').textContent = info.license ?? t('读取失败');
    $('aboutNoticeText').textContent = info.notice ?? t('读取失败');
    $('aboutVendorNoticesText').textContent = info.thirdPartyNotices ?? t('读取失败');
    $('aboutComponentList').replaceChildren(...info.components.map(c => {
      const li = document.createElement('li');
      li.textContent = `${c.name}@${c.version} · ${c.license || t('未声明许可')}${c.scope === 'browser' ? ` · ${t('浏览器端')}` : ''}`;
      return li;
    }));
  }

  // 每次进页都调；取到过就不再取（原文与组件清单在服务进程的生命周期内不变）
  async function load() {
    renderVersion();
    if (info || loading) return;
    loading = true;
    try {
      const res = await emit('about:get', {});
      if (res?.ok === true) {
        info = res;
        renderInfo();
      } else {
        for (const id of ['aboutLicenseText', 'aboutNoticeText', 'aboutVendorNoticesText']) $(id).textContent = t('读取失败');
      }
    } finally {
      loading = false;
    }
  }

  async function checkUpdate() {
    const btn = $('btnCheckUpdate');
    const out = $('aboutUpdateResult');
    btn.disabled = true;
    out.className = 'text-xs px-1 space-y-1 text-ink-soft';
    out.textContent = t('检查中…');
    try {
      const d = describeUpdateCheck(await emit('about:checkUpdate', {}, CHECK_TIMEOUT_MS));
      const line = document.createElement('div');
      line.className = TONE_CLASS[d.tone];
      line.textContent = d.text;
      out.replaceChildren(line);
      if (d.releaseUrl) {
        const a = document.createElement('a');
        a.id = 'aboutReleaseLink';
        a.href = d.releaseUrl;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.className = 'text-accent';
        a.textContent = d.releaseUrl.replace(/^https:\/\/github\.com\//, '');
        out.append(a);
      }
    } finally {
      btn.disabled = false;
    }
  }

  function bind() {
    $('btnCheckUpdate')?.addEventListener('click', checkUpdate);
  }

  return { load, bind, renderVersion };
}
