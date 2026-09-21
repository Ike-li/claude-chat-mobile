// devices.js —— 管理受信任和等待确认的设备指纹列表。
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { writeOwnerOnlyFile } from '../files/file-security.js';
import { resolveDataDir } from '../shared/data-dir.js';

// CCM_DATA_DIR 是受支持的状态根：生产可把控制面数据移出仓库，测试也用它隔离真实状态。
const DATA_DIR = resolveDataDir();
// 文件级重定向（TC-001，对称 approval-store 的 CCM_APPROVAL_STORE_FILE / sessions 的 CCM_SESSIONS_FILE）：
// 优先级 CCM_*_DEVICES_FILE > CCM_DATA_DIR > data/。让单测 preload 把设备文件重定向到临时目录、彻底不碰
// 生产 data/（避免 devices.test 的 rename 备份中断留残留 / 触发生产 watcher），又不动 CCM_DATA_DIR（不干扰集成测试）。
const TRUSTED_DEVICES_FILE = process.env.CCM_TRUSTED_DEVICES_FILE || join(DATA_DIR, 'trusted-devices.json');
const PENDING_DEVICES_FILE = process.env.CCM_PENDING_DEVICES_FILE || join(DATA_DIR, 'pending-devices.json');
// 展示元数据【旁挂】文件（同 TC-001 的重定向优先级）。刻意不并进 trusted-devices.json：
// 那份的解析在 loadTrustedDevices 里是「不是一维字符串数组 ⇒ 空集」，且不走 catch 的 last-good 分支，
// 于是常驻 server 还跑着旧代码、磁盘上的 CLI 已是新代码时（本仓「改完未重启」是常态），
// 新格式会让旧进程把信任设备数读成 0，watcher 那一轮把所有 device-token 连接断光。
// 另一侧同样致命：desktop 的 `let trusted: [String]?` 遇对象数组是 typeMismatch，JSONDecoder 整份 abort。
const DEVICE_PROFILES_FILE = process.env.CCM_DEVICE_PROFILES_FILE || join(DATA_DIR, 'device-profiles.json');

let trustedDevices = new Set();
let pendingDevices = []; // Array of { deviceToken, ip, userAgent, ts }

// F1（code-review #5）：待审设备容量上限。防「已过 AUTH_TOKEN 但未设备审批」的 LAN 客户端用【每次不同的
// 随机 deviceToken】反复握手，把 pending-devices.json 撑爆 + 每来一个就 broadcastPendingDevices 刷屏可信端。
// 正常单用户设备数远小于此；超出按插入序丢最旧（攻击 flood 是新到的，真实少量旧设备优先保留）。
export const MAX_PENDING_DEVICES = 50;

// deviceToken 来自 socket.io 握手 JSON 体，不经 HTTP header 过滤。app.js 在非交互模式下会把它
// 原样拼进一条打印给操作员复制运行的 shell 命令（node scripts/device.js approve "<token>"），
// 带 "/`/$/\ 的值就是一条可复制粘贴执行任意命令的注入；控制字符（含换行）能伪造额外的控制台输出。
// 长度上限防单条把 pending-devices.json 不成比例撑大（maxHttpBufferSize 是 32MB）。
// 不要求逐字节匹配客户端实际生成的 32 位十六进制格式——那会拒掉本文件其它测试与本仓一贯使用的
// 可读占位符 token（如 'device-1'），这里只挡真正危险的字符类，不是格式。
const MAX_DEVICE_TOKEN_LENGTH = 128;
// eslint-disable-next-line no-control-regex -- 故意匹配控制字符（含换行），不是笔误
const DANGEROUS_DEVICE_TOKEN_CHARS = /[\x00-\x1f\x7f"`$\\]/;
export function isValidDeviceToken(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_DEVICE_TOKEN_LENGTH
    && !DANGEROUS_DEVICE_TOKEN_CHARS.test(value);
}

export function loadTrustedDevices() {
  try {
    if (!existsSync(TRUSTED_DEVICES_FILE)) {
      trustedDevices = new Set();
      return;
    }
    const data = JSON.parse(readFileSync(TRUSTED_DEVICES_FILE, 'utf8'));
    if (Array.isArray(data)) {
      trustedDevices = new Set(data.filter(id => typeof id === 'string' && id.trim().length > 0));
    } else {
      trustedDevices = new Set();
    }
  } catch (err) {
    // 保留 last-good：瞬时读失败不把全部设备当未信任（flap 锁死本机）
    console.error('[devices] 读取 trusted-devices.json 失败（保留内存 last-good）:', err.message);
  }
}

// ④ 安全体检：当前信任设备数（只读，不暴露 token）。
export function getTrustedCount() {
  return trustedDevices ? trustedDevices.size : 0;
}

// 受信任设备 ID 列表（供 CLI 与桌面端菜单展示、给用户核对）。与 getTrustedCount 的区别是
// 它返回 ID 本身，所以只该喂给已经过鉴权的本机通道，不进任何网络响应。
// 每次重读磁盘，同 isDeviceTrusted 的理由：CLI 与 server 是两个进程，内存副本会过期。
// 这个 getter 存在的意义是让 scripts/device.js 不必自己 join 路径——它自己算的话就只认
// CCM_DATA_DIR，而本模块还支持 CCM_TRUSTED_DEVICES_FILE 文件级重定向，两个消费者会分叉。
export function getTrustedDeviceIds() {
  loadTrustedDevices();
  return [...trustedDevices];
}

// 把给定信任集合原子写盘，返回成败布尔（BE-011：成败必须可观测，不再吞成 undefined——
// 否则吊销/批准落盘失败会被静默当成功，而 isDeviceTrusted 每次重读磁盘会让被吊销设备复活）。
function writeTrustedSet(set) {
  try {
    mkdirSync(dirname(TRUSTED_DEVICES_FILE), { recursive: true });
    writeOwnerOnlyFile(TRUSTED_DEVICES_FILE, JSON.stringify([...set], null, 2));
    return true;
  } catch (err) {
    console.error('[devices] 保存 trusted-devices.json 失败:', err.message);
    return false;
  }
}

// 纯函数（BE-011）：在【副本】上应用信任集合变更，persist(副本) 成功才返回新集合、失败或抛错返回 null。
// 调用方仅在非 null 时把新集合提交到内存并报告成功；null 时保持原状 + 报告失败，绝不谎报吊销/批准成功。
export function persistTrustedChange(currentSet, mutate, persist) {
  const next = new Set(currentSet);
  mutate(next);
  let ok;
  try { ok = persist(next) !== false; } catch { ok = false; }
  return ok ? next : null;
}

export function loadPendingDevices() {
  try {
    if (!existsSync(PENDING_DEVICES_FILE)) {
      pendingDevices = [];
      return;
    }
    const data = JSON.parse(readFileSync(PENDING_DEVICES_FILE, 'utf8'));
    if (Array.isArray(data)) {
      pendingDevices = data.filter(d => d && typeof d.deviceToken === 'string');
    } else {
      pendingDevices = [];
    }
  } catch (err) {
    // 忽略加载暂存待审批文件的错误，通常为空或损坏
    pendingDevices = [];
  }
}

function savePendingDevices() {
  try {
    mkdirSync(dirname(PENDING_DEVICES_FILE), { recursive: true });
    writeOwnerOnlyFile(PENDING_DEVICES_FILE, JSON.stringify(pendingDevices, null, 2));
    return true;
  } catch (err) {
    console.error('[devices] 保存 pending-devices.json 失败:', err.message);
    return false;
  }
}

// ── 展示元数据（旁挂，非安全判决面）──────────────────────────────────────────
// 准入判决的事实源【只有】trusted-devices.json。本节的数据丢了，面板退化成一串裸 ID，
// 不影响任何一台设备能不能连上。所有失败路径都按这个立场选方向。

// 读 profiles。返回 null = 本次不可信（读失败或结构不对），调用方据此**放弃写入**。
// 这个方向与 loadTrustedDevices 的 last-good 【相反且是故意的】：profiles 的写是
// load-modify-write，把一次读失败当成空表写回去，会一次抹掉其余所有设备的元数据——
// 而那些数据在审批那一刻之后就再也拿不回来（UA/IP 不留存于任何其他地方）。
// 结构不对时同样不写：坏文件留着可供检查，用户删掉它即恢复（它是缓存，不是事实源）。
function readDeviceProfiles() {
  if (!existsSync(DEVICE_PROFILES_FILE)) return {};
  try {
    const data = JSON.parse(readFileSync(DEVICE_PROFILES_FILE, 'utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
    console.error('[devices] device-profiles.json 结构不是对象，本次按无元数据处理且不写入');
    return null;
  } catch (err) {
    console.error('[devices] 读取 device-profiles.json 失败（本次不写入，避免抹掉其余条目）:', err.message);
    return null;
  }
}

function writeDeviceProfiles(next) {
  try {
    mkdirSync(dirname(DEVICE_PROFILES_FILE), { recursive: true });
    writeOwnerOnlyFile(DEVICE_PROFILES_FILE, JSON.stringify(next, null, 2));
    return true;
  } catch (err) {
    console.error('[devices] 保存 device-profiles.json 失败:', err.message);
    return false;
  }
}

// 落一条审批事实。**只在 approve 成功之后调用**，且返回值恒被忽略（BE-011 故障隔离：
// trusted-devices.json 写成功就等于准入已生效，元数据写不写得进去都不能改变这个结论）。
// 上下文只从待审记录取，**不接受调用方注入**：三个 approve 入口都强制「必须先在待审列表里」
// （server/app.js 的 web 与 TTY 两处、scripts/device.js 一处），所以待审记录必然存在；
// 而 web 那个入口的作用域里躺着的 ip/userAgent 是【审批者】的，开一个入参迟早被接错线，
// 写进去一条看起来完全正常的假 profile——没有异常、没有日志、没有测试会红。
function recordDeviceProfile(deviceToken, request) {
  const current = readDeviceProfiles();
  if (current === null) return false;
  return writeDeviceProfiles({
    ...current,
    [deviceToken]: {
      ua: request?.userAgent ?? null,
      ip: request?.ip ?? null,
      approvedAt: Date.now(),
    },
  });
}

// 剔除一条。**只在 deny 的信任表写盘成功之后调用**：反过来会出现「元数据没了但信任还在」。
function forgetDeviceProfile(deviceToken) {
  const current = readDeviceProfiles();
  if (current === null) return false;
  if (!Object.hasOwn(current, deviceToken)) return true;
  const next = { ...current };
  delete next[deviceToken];
  return writeDeviceProfiles(next);
}

// 32 位 hex 在任何界面里都既放不下也读不出来，截成 `前8…后4`。
// ★ 这是同一判据的第二份实现，另两份是 desktop/CCMCore.swift 的 shortDeviceId（`id.count > 16`
// 才截，同样 prefix(8)/suffix(4)）与 app/public/js/logic/device-label.js（浏览器侧）。跨语言 +
// 前后端禁止互相 import，三份无法合一；改任一份就把另两份一起改——它们的全部用途就是让用户
// 拿手机上那串跟菜单/面板上那串对上，对不上这个功能就等于没有。
export function shortDeviceId(id) {
  if (typeof id !== 'string' || !id) return '';
  if (id.length <= 16) return id;
  return `${id.slice(0, 8)}\u2026${id.slice(-4)}`;
}

// User-Agent → 一个人认得出来的设备类型。核对「在敲门的是不是我那台手机」时，
// 「iPhone」比一整串 Mozilla/5.0 有用得多。
// ★ 顺序有讲究：iOS 的 UA 里含 "like Mac OS X"，先判 Mac 会把 iPhone/iPad 全认成 Mac。
// ★ 与 desktop/CCMCore.swift 的 deviceKindLabel 互为镜像（跨语言无法共用），改一边就改另一边。
//   放在后端而不是浏览器侧，是为了让实现只有两份而不是三份：CLI 的人类可读列表与 Web 下发
//   共用这一份，前端只把返回的中文串过 t()（本仓 zh 原文即 i18n key）。
export function deviceKindLabel(ua) {
  if (typeof ua !== 'string' || !ua) return '未知设备';
  if (ua.includes('iPhone')) return 'iPhone';
  if (ua.includes('iPad')) return 'iPad';
  if (ua.includes('Android')) return 'Android';
  if (ua.includes('Macintosh') || ua.includes('Mac OS')) return 'Mac';
  if (ua.includes('Windows')) return 'Windows';
  return '其他设备';
}

// 设备别名。**唯一对所有平台都成立的分辨手段**：iOS 拿不到机型，局域网 http:// 下
// UA Client Hints 也不可用（非安全上下文），而用户自己起的名字在哪都好使。
// 它住在 device-profiles.json，属展示层——不参与任何准入判定。
export const MAX_DEVICE_ALIAS = 24;

// 归一：剥控制字符 → 折叠空白 → trim → 按码点限长。空白等于「清除别名」，返回 null 而不是
// 空串，好让展示层用一次 `??` 就回落到「平台 · 浏览器」，不必再判空串。
// ★ 按【码点】截而不是 UTF-16 长度：`'x'.slice(0, n)` 会把代理对砍成半个，屏幕上是乱码。
// 控制字符用 \p{Cc} 整类剥掉：换行会把一行卡片撑成多行，制表符能伪造对齐。
export function normalizeDeviceAlias(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  const points = [...cleaned];
  return points.length > MAX_DEVICE_ALIAS ? points.slice(0, MAX_DEVICE_ALIAS).join('') : cleaned;
}

// 写别名。只动 alias 一个字段（展开原条目再覆盖）——其余字段是审批那一刻的事实，不该被改名波及。
// 返回值的立场同 recordDeviceProfile：写不进去只是面板少一行，绝不影响信任。
export function setDeviceAlias(deviceToken, rawAlias) {
  if (!deviceToken || typeof deviceToken !== 'string') return false;
  const current = readDeviceProfiles();
  if (current === null) return false;
  const alias = normalizeDeviceAlias(rawAlias);
  return writeDeviceProfiles({
    ...current,
    [deviceToken]: { ...(current[deviceToken] || {}), alias },
  });
}

// UA → 「浏览器 + 主版本」。单靠 deviceKindLabel 不够用：同一部手机的微信 webview 与 Chrome
// 是两条独立记录（deviceToken 存在各自的 localStorage），标题都写「Android」就没法分辨该吊销哪个。
//
// ★ 顺序有讲究，理由与 deviceKindLabel 同源：几乎每个 Chromium 派生浏览器的 UA 里都带
//   `Chrome/`，而每个 Chromium UA 又都带 `Safari/537.36`。先判 Chrome 会把微信/Edge/三星
//   全认成 Chrome，先判 Safari 会把所有安卓浏览器认成 Safari。派生的排前面，基底排后面。
// 认不出来返回 null，由调用方决定怎么显示——不造一个「其他浏览器」占位（那和不显示一样没用）。
const BROWSER_RULES = [
  [/MicroMessenger\/(\d+\.\d+\.\d+)/, (m) => `微信 ${m[1]}`],
  [/(?:MQQBrowser|QQ)\/(\d+)/, (m) => `QQ ${m[1]}`],
  [/Edg(?:A|iOS)?\/(\d+)/, (m) => `Edge ${m[1]}`],
  [/SamsungBrowser\/(\d+)/, (m) => `三星浏览器 ${m[1]}`],
  [/(?:Firefox|FxiOS)\/(\d+)/, (m) => `Firefox ${m[1]}`],
  [/(?:CriOS|Chrome)\/(\d+)/, (m) => `Chrome ${m[1]}`],
  [/Version\/(\d+)[.\d]* Mobile\/\S+ Safari/, (m) => `Safari ${m[1]}`],
  [/Version\/(\d+)[.\d]* Safari/, (m) => `Safari ${m[1]}`],
];

export function browserLabel(ua) {
  if (typeof ua !== 'string' || !ua) return null;
  for (const [re, fmt] of BROWSER_RULES) {
    const m = re.exec(ua);
    if (m) return fmt(m);
  }
  return null;
}

// UA → Android 机型代号，拿不到返回 null。
//
// ★★ 拿不到是常态，不是解析失败。Chrome 做过 UA reduction：机型位被冻结成字面量 `K`、
//    系统版本钉死在 `10`，不论真机是什么。实录：同一部 Android 16 手机，微信 webview
//    如实报出机型代号，Chrome 只给 `Android 10; K`。iOS 则从来不在 UA 里给机型。
//    真要拿 Chromium 系的机型只有 UA Client Hints（`Sec-CH-UA-Model`）一条路，而它要求
//    **安全上下文**——局域网 http:// 入口下不可用，恰好是最需要分辨的那一档。
//    所以这里遇到占位就返回 null，**绝不把 `K` 当成机型显示出去**。
const FROZEN_ANDROID_MODEL = 'K'; // Chrome UA reduction 的固定占位

export function deviceModelFromUa(ua) {
  if (typeof ua !== 'string' || !ua) return null;
  const m = /Android\s+[\d.]+;\s*([^;)]+?)(?:\s+Build\/[^;)]*)?[;)]/.exec(ua);
  if (!m) return null;
  const model = m[1].trim();
  if (!model || model === FROZEN_ANDROID_MODEL || model === 'wv') return null;
  return model;
}

// 短 ID → 全量 deviceToken 的反查（Web 吊销的唯一寻址方式，见 device-gate 的下发面）。
// **0 命中或多命中一律返回 null、绝不任选一条**：下游是吊销，猜错等于吊错设备。
// 12 位 hex ≈ 48 bit，n=1 下碰撞不可能——但「不可能」不是分支的替代品。
export function resolveShortDeviceId(shortId, ids) {
  if (typeof shortId !== 'string' || !shortId) return null;
  const hits = (Array.isArray(ids) ? ids : []).filter(id => shortDeviceId(id) === shortId);
  return hits.length === 1 ? hits[0] : null;
}

// Web 侧吊销的准入判定（纯函数，不碰 socket）。三个出口各自对应一种「不能吊」，
// 调用方按理由给不同文案：not_found 多半是列表过期，self 则是必须拦住的那一种。
//
// **自吊销守卫**：Web 上「吊销」是一键可达的，而 denyDevice 之后 disconnectDeviceSockets
// 无条件执行——吊销自己会当场把自己踢下线。若那是当时唯一在线的可信端，就只能回到电脑前
// （TTY / CLI / 菜单栏 / 本机直连）才能重新批准。菜单栏没有这个问题（它就在电脑前）。
//
// requesterToken 允许缺失：本机直连与 CF Access 走 bypass 分支，握手里可以完全没有
// deviceToken。那种情况下不存在「吊销自己」——它本来就不在信任表里。
export function decideRevokeByShortId({ shortId, requesterToken, trustedIds }) {
  const token = resolveShortDeviceId(shortId, trustedIds);
  if (!token) return { ok: false, reason: 'not_found' };
  if (requesterToken && token === requesterToken) return { ok: false, reason: 'self' };
  return { ok: true, token };
}

// 受信任设备 + 展示元数据。**以 trusted-devices.json 为准做左连接**：profiles 里的孤儿条目
// （手工编辑过信任表 / 从备份恢复）自然被忽略，不需要单独的回收逻辑。
// 返回值含全量 deviceId，**只该喂给已鉴权的本机通道**（CLI 与菜单栏），同 getTrustedDeviceIds。
export function getTrustedDeviceProfiles() {
  const ids = getTrustedDeviceIds();
  const profiles = readDeviceProfiles() || {};
  return ids.map(id => {
    const p = profiles[id];
    return {
      deviceId: id,
      shortId: shortDeviceId(id),
      kind: deviceKindLabel(typeof p?.ua === 'string' ? p.ua : null),
      browser: browserLabel(typeof p?.ua === 'string' ? p.ua : null),
      model: deviceModelFromUa(typeof p?.ua === 'string' ? p.ua : null),
      alias: typeof p?.alias === 'string' && p.alias ? p.alias : null,
      ua: typeof p?.ua === 'string' ? p.ua : null,
      ip: typeof p?.ip === 'string' ? p.ip : null,
      approvedAt: typeof p?.approvedAt === 'number' ? p.approvedAt : null,
    };
  });
}

export function isDeviceTrusted(deviceToken) {
  if (!deviceToken || typeof deviceToken !== 'string') return false;
  // 每次检查前可以重新加载，确保多进程/CLI 操作的数据能即时感知
  loadTrustedDevices();
  return trustedDevices.has(deviceToken);
}

export function addPendingDevice(deviceToken, info) {
  if (!isValidDeviceToken(deviceToken)) return;
  loadPendingDevices();
  // 过滤掉同设备已存在的旧记录
  pendingDevices = pendingDevices.filter(d => d.deviceToken !== deviceToken);
  pendingDevices.push({
    deviceToken,
    ...info,
    ts: Date.now()
  });
  // F1：容量上限，超则按插入序丢最旧（数组头部=最早插入）。getPendingDevices 另按 ts 排序供展示，
  // 此处按插入序裁剪确定性、不受同毫秒 ts 排序抖动影响。
  if (pendingDevices.length > MAX_PENDING_DEVICES) {
    pendingDevices = pendingDevices.slice(-MAX_PENDING_DEVICES);
  }
  savePendingDevices();
}

export function removePendingDevice(deviceToken) {
  if (!deviceToken) return;
  loadPendingDevices();
  pendingDevices = pendingDevices.filter(d => d.deviceToken !== deviceToken);
  savePendingDevices();
}

export function getPendingDevices() {
  loadPendingDevices();
  return [...pendingDevices].sort((a, b) => b.ts - a.ts); // 最新请求排在最前面
}

export function getLatestPendingDevice() {
  const list = getPendingDevices();
  return list.length > 0 ? list[0].deviceToken : null;
}

export function approveDevice(deviceToken) {
  if (!deviceToken || typeof deviceToken !== 'string') return false;
  loadTrustedDevices();
  // BE-011：先落盘（写入含新设备的集合），成功才把变更提交到内存；失败返回 false，不谎报信任已生效。
  const next = persistTrustedChange(trustedDevices, s => s.add(deviceToken), writeTrustedSet);
  if (next === null) {
    console.error('[devices] 批准落盘失败，信任未生效:', deviceToken);
    return false;
  }
  trustedDevices = next;

  // 移出待审批（附带清理；即便这步失败也不影响信任判定）
  loadPendingDevices();
  // ★ 必须在 filter 【之前】取：这是 ua/ip 在整个系统里最后一次存在的地方，
  //   过滤完 pendingDevices 就没有它了，而审批那一刻的上下文再也无法重建。
  const request = pendingDevices.find(d => d.deviceToken === deviceToken);
  pendingDevices = pendingDevices.filter(d => d.deviceToken !== deviceToken);
  savePendingDevices();

  // 展示元数据旁挂。返回值有意不看：信任已经落盘生效了（BE-011），这一步失败只是面板上
  // 少一行 UA/时间，把它算进 approve 的成败等于用展示层的故障去否定一个已生效的准入。
  recordDeviceProfile(deviceToken, request);
  return true;
}

export function denyDevice(deviceToken) {
  if (!deviceToken || typeof deviceToken !== 'string') return false;
  loadTrustedDevices();
  // BE-011：吊销必须落盘成功才算数——否则 isDeviceTrusted 每次重读磁盘会让被吊销设备复活。
  // 落盘失败返回 false，调用方据此告警、不记「吊销成功」审计。
  const next = persistTrustedChange(trustedDevices, s => s.delete(deviceToken), writeTrustedSet);
  if (next === null) {
    console.error('[devices] 吊销落盘失败，吊销未生效:', deviceToken);
    return false;
  }
  trustedDevices = next;

  // 剔除展示元数据。**放在这里而不是函数开头**：上面 persistTrustedChange 返回非 null 才代表
  // 信任表真的落了盘；提前删会造出「元数据没了、信任还在」的一台匿名幽灵设备。
  forgetDeviceProfile(deviceToken);

  // 移出待审批
  loadPendingDevices();
  pendingDevices = pendingDevices.filter(d => d.deviceToken !== deviceToken);
  savePendingDevices();
  return true;
}

// 启动时初始化加载
loadTrustedDevices();
loadPendingDevices();
