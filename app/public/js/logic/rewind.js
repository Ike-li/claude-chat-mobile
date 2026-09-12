// logic/rewind.js —— 回退收尾的告知文案组装
//
// 红线（同其他 logic/ 子模块）：只做数据→数据，不碰 DOM / window / socket / 应用可变态。
// 唯一宿主外 import 是 ../i18n.js。
//
// 【这里为什么值得单独一层】三件要告知的事都属于「服务端算得出、但不说用户就不知道」——
// 不说的后果不是报错，是用户以为全好了。而它们能叠加、有轻重之分，混在 handler 里拼字符串
// 既测不了也容易漏掉其中一条。

import { t } from '../i18n.js';

const MAX_LISTED = 3; // 列几个文件名就够传达「是哪些」；再多只会把提示挤爆、反而没人读

/**
 * 组装回退之后要追加的提示。
 *
 * @param {object} r
 * @param {string[]} r.unrestored    接口声称成功、实际没恢复的文件（服务端复核得出）
 * @param {number}   r.skippedLinks  因软链接/硬链接被有意跳过的文件数
 * @param {string}   r.warning       整体性问题的整句（如分叉没建成），服务端已拼好
 * @returns {Array<{text: string, tone: string}>} 逐条追加，顺序即轻重
 */
export function rewindOutcomeNotes({ unrestored, skippedLinks, warning } = {}) {
  const notes = [];

  // warning 排最前：它说的是整体性失败（会话没建成），比「某几个文件没恢复」更要紧。
  // 合并成一句会让最要紧的那条被淹没。
  if (warning) notes.push({ text: warning, tone: 'danger' });

  const missing = Array.isArray(unrestored) ? unrestored : [];
  if (missing.length) {
    const names = missing.slice(0, MAX_LISTED).map(p => String(p).split('/').pop()).join('、');
    // 截断了也必须把总数说清——否则用户以为只有列出的这几个。
    const suffix = missing.length > MAX_LISTED
      ? t('等 {n} 个文件').replace('{n}', String(missing.length))
      : '';
    notes.push({
      text: t('⚠️ 这些文件未能恢复：{names}{suffix}。建议在 Git 面板核对。')
        .replace('{names}', names).replace('{suffix}', suffix),
      tone: 'danger',
    });
  }

  // 脏值不当成「有跳过」：凭空吓用户一跳比漏报更坏，且这一档本就属于少见边角。
  if (Number.isFinite(skippedLinks) && skippedLinks > 0) {
    notes.push({
      // 只说「跳过 N 个」而不说为什么，用户无从判断要不要手动处理。
      text: t('{n} 个文件是符号链接或硬链接，已跳过、未回退。').replace('{n}', String(skippedLinks)),
      tone: 'text-ink-faint',
    });
  }

  return notes;
}
