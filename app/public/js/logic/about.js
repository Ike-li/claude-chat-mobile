// logic/about.js —— 设置「关于」页（#303）「检查更新」的结果怎么说。
//
// 红线同 logic/ 其余模块：只做数据→数据，不碰 DOM / window / socket。唯一允许的宿主外 import 是 ../i18n.js。
//
// 失败方向：读不懂的回执（超时给的 null、旧 server、不认识的 status）一律说「检查失败」——
// 说成「已是最新」会让人放心地停在旧版上。

import { t } from '../i18n.js';

const fill = (text, vars) => Object.entries(vars).reduce((s, [k, v]) => s.split(`{${k}}`).join(v), text);

/**
 * @param {{ok?: boolean, status?: 'newer'|'same'|'ahead', current?: string, latest?: string, releaseUrl?: string}|null|undefined} res
 *   about:checkUpdate 的回执；超时或断线时为 null
 * @returns {{tone: 'ok'|'warn'|'muted'|'error', text: string, releaseUrl: string|null}}
 *   releaseUrl 只在「有新版」时给：另两种结果没有要去看的东西
 */
export function describeUpdateCheck(res) {
  if (res?.ok === true) {
    const vars = { current: `v${res.current}`, latest: `v${res.latest}` };
    if (res.status === 'newer') {
      return { tone: 'warn', text: fill(t('有新版 {latest}（当前 {current}）'), vars), releaseUrl: res.releaseUrl ?? null };
    }
    if (res.status === 'same') return { tone: 'ok', text: fill(t('已是最新（{current}）'), vars), releaseUrl: null };
    if (res.status === 'ahead') {
      return { tone: 'muted', text: fill(t('本地领先：当前 {current}，GitHub 最新 {latest}'), vars), releaseUrl: null };
    }
  }
  return { tone: 'error', text: t('检查失败'), releaseUrl: null };
}
