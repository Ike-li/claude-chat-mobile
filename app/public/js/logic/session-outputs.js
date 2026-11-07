// 工作区「产出」tab 一行怎么显示。media 由服务端判（同 file:open 的 inlineTypeOf），这里不再存一份扩展名表。
import { t } from '../i18n.js';
import { formatAgoShort } from './service-diag.js';

const MEDIA_ICONS = { image: '🖼️', video: '🎬', audio: '🎵' };

export function outputRowView(item, now) {
  const missing = item.state === 'missing';
  const when = missing ? t('已删除') : formatAgoShort(now - item.at);
  return {
    icon: MEDIA_ICONS[item.media] ?? '📄',
    name: item.name,
    meta: [item.dir, when].filter(Boolean).join(' · '),
    openable: !missing,
  };
}

export function outputsOutsideText(count) {
  return count > 0 ? `${t('另有')} ${count} ${t('个文件不在已连接的文件夹里')}` : '';
}
