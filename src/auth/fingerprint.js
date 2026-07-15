// fingerprint.js —— 审批完整性绑定的后端侧哈希封装（docs/design.md，承接 AD-7/NFR-17）
// canonicalizeOp（字符串构造，前后端一致性有真实风险）与哈希（SHA-256，标准化算法、跨实现无漂移
// 风险）分离：canonicalizeOp 从 public/js/canonicalize.js 原样导入（浏览器与本文件共享同一份实现）；
// 哈希后端用 node:crypto 同步 API——askPermission/resolvePermission 是同步函数，若改用 crypto.subtle
// （Web Crypto，仅异步）会在"调用方不 await 就紧接着同步调用 resolvePermission"的既有测试模式下
// 导致 pendingPermissions.set() 尚未执行、resolvePermission 扑空、返回的 Promise 永远不 resolve（挂起）。
// 前端浏览器无同步哈希原语，只能异步（见 public/js/canonicalize.js 的 fingerprintHex/verifyIntegrity）。
import { createHash } from 'node:crypto';
import { canonicalizeOp } from '../../public/js/canonicalize.js';

export function fingerprintSync(op) {
  return createHash('sha256').update(canonicalizeOp(op), 'utf8').digest('hex');
}

export function verifyIntegritySync(fp, op) {
  return fingerprintSync(op) === fp;
}
