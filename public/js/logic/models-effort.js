// logic/models-effort.js —— 模型解析/展示/网关后缀 · effort 档位 · ultracode
//
// 红线（拆分后由每个子模块各自承担，原文与 logic.js barrel 同源）：
// 只做数据→数据，不得触碰 DOM / window / socket / 应用可变状态（会话、实例、连接态等）。
// 目的：让浏览器 import 与 tests/unit/logic-*.test.mjs（node:test）共用同一份逻辑，零构建。
// 唯一允许的宿主外 import 是 ../i18n.js（纯查表 + 一个语言开关，node 与浏览器行为一致）；
// 同层 logic/ 子模块之间可以互相 import，但不得成环（npm run check 的 import 边界守卫会拒）。
// 想再加 import 前先自问：新依赖能在裸 node 里被 import 且不碰宿主 API 吗？不能就别加。

import { t } from '../i18n.js';

// 模型磁贴：条数与 SDK/TUI supportedModels 一一对应（不去重合并）。
// 标题优先真实 wire id（resolvedModel）；无则 displayName/value。
// value 仍用 SDK 的 value（default/opus/…）保证可区分；发送时 resolveSendModel 再 pin wire。
export function resolveModelTileDisplay(models) {
  const list = Array.isArray(models) ? models : [];
  const rows = list.map(m => {
    if (typeof m === 'string') {
      return { value: m, displayName: m, description: '', resolvedModel: '', raw: m };
    }
    const value = m?.value != null ? String(m.value) : '';
    const displayName = (m?.displayName != null && String(m.displayName).trim())
      ? String(m.displayName).trim()
      : value;
    const resolvedModel = (m?.resolvedModel != null && String(m.resolvedModel).trim())
      ? String(m.resolvedModel).trim()
      : '';
    const description = m?.description != null ? String(m.description) : '';
    return { value, displayName, description, resolvedModel, raw: m };
  });

  // 标题撞车计数（多个档位映射同一 wire 时标题相同，靠副标题档位名区分）
  const titleKey = (r) => r.resolvedModel || r.displayName || r.value;
  const titleCounts = new Map();
  for (const r of rows) {
    const k = titleKey(r);
    titleCounts.set(k, (titleCounts.get(k) || 0) + 1);
  }

  return rows.map(r => {
    const wire = r.resolvedModel;
    const title = wire || r.displayName || r.value || 'model';
    // 有 wire：副标题用档位 value/displayName（TUI 档名），便于同 wire 多卡区分
    // 无 wire：description 或 value
    let subtitle;
    if (wire) {
      if (r.value === 'default') {
        subtitle = r.displayName && r.displayName !== wire
          ? r.displayName
          : (r.description || 'default');
      } else if (r.value && r.value !== wire) {
        subtitle = r.displayName && r.displayName !== wire && r.displayName !== r.value
          ? `${r.value} · ${r.displayName}`
          : r.value;
      } else {
        subtitle = r.description || r.displayName || '';
      }
    } else {
      subtitle = r.description || r.value || '';
    }
    const duplicate = (titleCounts.get(titleKey(r)) || 0) > 1;
    return {
      value: r.value, // 保持 SDK 条目 id，不与其它卡撞 data-model
      title,
      subtitle,
      duplicate,
      raw: r.raw,
    };
  });
}

/** value=default 条目的 resolvedModel（wire），无则 '' */
export function defaultResolvedModel(modelsList) {
  if (!Array.isArray(modelsList)) return '';
  const def = modelsList.find(m => (typeof m === 'string' ? m : m?.value) === 'default');
  if (!def || typeof def === 'string') return '';
  return def.resolvedModel != null ? String(def.resolvedModel).trim() : '';
}

/** 选中 value 对应的 wire；无则 '' */
function resolvedModelForValue(value, modelsList) {
  if (value == null || value === '' || !Array.isArray(modelsList)) return '';
  const entry = modelsList.find(m => (typeof m === 'string' ? m : m?.value) === value);
  if (!entry || typeof entry === 'string') return '';
  return entry.resolvedModel != null ? String(entry.resolvedModel).trim() : '';
}

// 发送：优先 pin 真实 wire（resolvedModel）；default/空 → default 的 wire，否则 undefined 让 CLI 自选
export function resolveSendModel({ selectValue = '', fullModel = '', modelsList = [] } = {}) {
  const raw = String(fullModel || selectValue || '').trim();
  if (!raw || raw === 'default') {
    return defaultResolvedModel(modelsList) || undefined;
  }
  // 已是 wire 或档位别名：有 resolved 用 wire，否则原样
  const wire = resolvedModelForValue(raw, modelsList)
    || resolveGatewayModelName(raw, modelsList);
  return wire || raw;
}

// UX-015：cache 比例/百分数取整为 "N%"。
export function formatCachePercent(ratio) {
  if (ratio == null || !Number.isFinite(Number(ratio))) return '—';
  let n = Number(ratio);
  if (n >= 0 && n <= 1) n *= 100;
  return `${Math.round(n)}%`;
}

// UX-014：思考档副文案（增量信息，非重复等级名）。
export function effortLevelSubtitle(level) {
  const lv = String(level || '').toLowerCase();
  const map = {
    low: t('更快更省'),
    medium: t('均衡'),
    med: t('均衡'),
    high: t('更深入'),
    xhigh: t('很深入更慢'),
    max: t('最深入更慢更贵'),
    ultracode: t('xhigh + 多 agent workflow · 最彻底'),
  };
  return map[lv] || '';
}

// UX-010：镜像只读时不与本地忙碌条同现。
export function shouldShowBusyWithMirror({ mirrorReadonly = false, busy = false } = {}) {
  if (mirrorReadonly) return false;
  return Boolean(busy);
}

// ultracode = CLI /effort 菜单最高档（会话 Settings.ultracode + effort xhigh）。
// SDK Options.effort 只认 low..max；UI 在 xhigh-capable 上追加 ultracode 菜单项（与 CLI 对齐），
// spawn 时 server 映射为 effort=xhigh + settings:{ultracode:true}，不改写用户正文。
// withUltracodeKeyword：仅当用户自己在消息里写 ultracode 时仍原样发送（CLI 关键词 trigger）；Web 切档不自动注入。
export function withUltracodeKeyword(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return 'ultracode';
  return /^ultracode(?:\s|$)/i.test(trimmed) ? trimmed : `ultracode ${trimmed}`;
}

// 思考档位列表：ultracode 仅在模型支持 xhigh 时追加（对齐 CLI /effort），幂等。
export function withUltracodeTier(levels) {
  const arr = Array.isArray(levels) ? levels : [];
  if (!arr.includes('xhigh') || arr.includes('ultracode')) return arr;
  return [...arr, 'ultracode'];
}

// UI 档 → SDK 参数：ultracode → { effort:'xhigh', ultracode:true }；其余原样。
export function resolveEffortSelection(uiLevel) {
  if (uiLevel === 'ultracode') return { effort: 'xhigh', ultracode: true };
  return { effort: uiLevel || null, ultracode: false };
}

// 模型桥接：把规范名 / 网关后缀名（如 claude-opus-4-8[1m]）匹配到 models 候选项。
// modelsList 由调用方传入（app.js 的 let modelsList / 测试夹具）。先精确命中，再按 [Nm] 后缀 + base 子串桥接。
export function modelEntryFor(value, modelsList) {
  if (!value || !modelsList || !modelsList.length) return null;
  const exact = modelsList.find(m => (typeof m === 'string' ? m : m?.value) === value);
  if (exact) return exact;
  const sfx = (value.match(/\[[^\]]+\]$/) || [''])[0];
  const base = value.replace(/\[[^\]]+\]$/, '');
  return modelsList.find(m => {
    if (!m || typeof m === 'string' || !m.value) return false;
    const mSfx = (m.value.match(/\[[^\]]+\]$/) || [''])[0];
    const mBase = m.value.replace(/\[[^\]]+\]$/, '');
    if (mSfx !== sfx || !mBase) return false;
    // 子串桥接须在词边界位置（前后都是 '-' 或字符串开头/结尾）：防 'deepseek-v3' 误匹配 'deepseek-v3.1'
    const idx = base.indexOf(mBase);
    if (idx < 0) return false;
    const after = idx + mBase.length;
    return (idx === 0 || base[idx - 1] === '-')
      && (after >= base.length || base[after] === '-' || base[after] === '[');
  }) || null;
}

// 模型的「给人看的名字」：用于会话设置里折叠头的当前值、以及思考强度区块的归属标签。
// 走与 effortLevelsFor 同一条 modelEntryFor 桥接路径——两处若各解析一套，会出现标题写着 A、
// 档位却是 B 的错位。取 displayName 与模型磁贴主标题同源，无则回落 value，解析不到则诚实回落原值。
// ⚠️ 与底栏 model chip 是**两套有意不同**的展示：chip 显原始 value（P0-09e/P0-09j 锁定它不得被
// displayName 覆盖，用户选了 opus 就得看到 opus）；这里替代的是磁贴列表，故随磁贴用 displayName。
// 空模型（CLI「不 pin」语义）返回空串：没有具体模型可归属时，由调用方给「当前模型」的兜底文案，
// 不能把 'default' 这种内部字面量摆给用户看。
export function modelLabelFor(modelValue, modelsList) {
  if (!modelValue) return '';
  const entry = modelEntryFor(modelValue, modelsList);
  if (entry && typeof entry === 'object') return entry.displayName || entry.value || modelValue;
  if (typeof entry === 'string' && entry) return entry;
  return modelValue;
}

// select / 文案：CLI displayName 优先，否则 value。不把 resolvedModel 抬成展示名（中转站不重写）。
export function resolveModelDisplayName(value, modelsList) {
  if (value == null || value === '') return '';
  const entry = modelEntryFor(value, modelsList);
  if (entry && typeof entry === 'object') {
    if (entry.displayName != null && String(entry.displayName).trim()) return String(entry.displayName).trim();
    if (entry.value != null && String(entry.value)) return String(entry.value);
  }
  return String(value);
}

// 网关真实模型名探测：仅当候选项确有非空 resolvedModel 时返回它，否则返回空字符串——不回落
// displayName/value。用于 pill / 交互日志 diag chip 这类历史上只显示"原始值"、从不回落 displayName
// 的展示位——只解决"网关映射导致显示裸别名"这一个问题，不改变无网关映射时的既有展示契约
// （P0-09e/P0-09j 锁定了 pill 必须显示用户实际选中的原始值，不能被 displayName 覆盖）。
export function resolveGatewayModelName(value, modelsList) {
  if (value == null || value === '') return '';
  const entry = modelEntryFor(value, modelsList);
  if (entry && typeof entry === 'object' && entry.resolvedModel != null && String(entry.resolvedModel).trim()) {
    return String(entry.resolvedModel).trim();
  }
  return '';
}

// 底栏 pill：网关场景优先显示 wire（resolvedModel），与磁贴方案 B 一致。
// · 已选：resolveGatewayModelName 或 value+后缀
// · 未选：default.resolved → cliDefaultLabel → cwd 默认（经网关解析）→「默认」
export function resolveModelPillText({ model, gatewaySuffix = '', modelsList, cwdDefaultModel, cliDefaultLabel } = {}) {
  const sfx = gatewaySuffix || '';
  if (model) {
    const raw = String(model) + sfx;
    return resolveGatewayModelName(raw, modelsList) || raw;
  }
  const defWire = defaultResolvedModel(modelsList);
  if (defWire) return defWire;
  if (cliDefaultLabel) return String(cliDefaultLabel);
  if (cwdDefaultModel) {
    const full = String(cwdDefaultModel);
    const naked = full.replace(/\[[^\]]+\]$/, '');
    return resolveGatewayModelName(naked, modelsList)
      || resolveGatewayModelName(full, modelsList)
      || naked;
  }
  return t('默认');
}

// effort 档位决策（rebuildEffortOptions 的纯部分；DOM 渲染留在 app.js）。返回 { hidden, levels }：
//   · 解析到模型且支持 effort → { hidden:false, levels: 该模型 supportedEffortLevels }
//   · 解析到但不支持（如 haiku）   → { hidden:true,  levels: [] }（app.js 隐藏整行）
//   · 解析不到（列表未到/桥接不上）→ { hidden:false, levels: 全候选 supportedEffortLevels 并集 }（CLI 全局集）
export function effortLevelsFor(modelValue, modelsList) {
  const entry = modelEntryFor(modelValue, modelsList);
  const levels = (entry && typeof entry === 'object' && Array.isArray(entry.supportedEffortLevels)) ? entry.supportedEffortLevels : null;
  if (entry && (!levels || !levels.length)) return { hidden: true, levels: [] }; // 明确不支持 effort
  const show = (levels && levels.length) ? levels.slice() // 拷贝，避免调用方原地修改污染 modelsList 共享条目
    : [...new Set((modelsList || []).flatMap(m => (m && typeof m === 'object' && Array.isArray(m.supportedEffortLevels)) ? m.supportedEffortLevels : []))];
  return { hidden: false, levels: show };
}

// effort 展示态必须保留后端真值；重建候选列表只决定 select 能否选中，绝不能把未知/null 猜成 low。
// mirrorReadonly 时 null 的语义是「外部 CLI 活进程档位不可观测」，与 FRESH 的「模型默认」分开文案。
export function effortUiState(level, supportedLevels, { mirrorReadonly = false } = {}) {
  const normalized = level || null;
  const levels = Array.isArray(supportedLevels) ? supportedLevels : [];
  const selected = normalized && levels.includes(normalized) ? normalized : '';
  return {
    level: normalized,
    selected,
    label: normalized || (mirrorReadonly ? t('CLI 档位未知') : t('默认思考')),
    placeholder: normalized
      ? `${normalized}${t('（当前模型不可选）')}`
      : (mirrorReadonly ? t('CLI 当前档未知') : t('模型默认')),
  };
}

// 模型网格「默认磁贴」（data-model=""）文案决策。currentModel 非空=已选/已知具体模型 → 磁贴非激活、显通用文案。
// currentModel 为空且已知 cwd 默认 → 显真实默认名（诚实：cwd 级最佳猜测、非该会话确定值；续接无记录会话真实
// 模型可能不同，首条消息后由 init.model 校正）。仅改文案，不影响发送（modelInput.value 恒空、不传 --model）。
export function defaultModelTileLabel({ currentModel, cwdDefaultModel } = {}) {
  if (!currentModel && cwdDefaultModel) {
    const naked = String(cwdDefaultModel).replace(/\[[^\]]+\]$/, '');
    return { title: t('默认模型'), subtitle: naked, showsName: true };
  }
  return { title: t('沿用当前模型'), subtitle: t('不指定特定模型'), showsName: false };
}

// 发送前的网关后缀回贴。S5 原意：只对「不在 supportedModels 候选里的自设名」（如用户 /model 手设并
// 剥离了后缀的）补回网关后缀；候选内的值本就是网关合法完整名，原样发送。
// 回归（7febabc）：resolveSendModel 自那次改成返回 **wire**（entry.resolvedModel），而守卫仍只比
// m.value（档位别名）。wire 按设计就不等于任何条目的 value，于是 .some() 恒 false → 后缀必贴，
// 网关工作区里每一次显式选模型都送出 `grok-4.5[1m][1m]` 这种非法名，setModel 抛错或整轮 API 失败。
// 判据必须同时认 value 与 resolvedModel —— 两者都是「候选内的合法名」。
export function applyGatewaySuffix(model, gatewaySuffix = '', modelsList = []) {
  if (!model || !gatewaySuffix) return model;
  const list = Array.isArray(modelsList) ? modelsList : [];
  const known = list.some(m => (typeof m === 'string'
    ? m === model
    : m?.value === model || m?.resolvedModel === model));
  return known ? model : model + gatewaySuffix;
}

// ---- 消息流时间戳（稀疏式）：判定层 ----
// 三条数据源的时间形态不同——live 信封是 epoch ms（agent.js emit 的 ts），历史/镜像是 ISO 串
// （transcript 原样透传的 entry.timestamp）。归一在此收敛，调用方不必各自判类型。
// 拿不准一律返回 null：调用方据此「不打戳、不插行」，是安全退化而非报错。
