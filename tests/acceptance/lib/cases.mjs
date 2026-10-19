// tests/acceptance/lib/cases.mjs —— 用例库（cases/meta.json + cases/dNN-*.json）的读取、校验与挑选
//
// 用例的唯一事实源是 cases/ 下的 JSON；清单页面是由它生成的视图（见 export-artifact.mjs）。
// 本文件只做数据进数据出：loadCases 读盘，其余都是纯函数，单测直接喂夹具。
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** 每条用例的来源文件与域号。用 Symbol 挂而不是普通字段：JSON.stringify 不序列化 Symbol 键，
 *  agent 把用例写回文件时不会顺手把来源信息也写进去。 */
export const SOURCE = Symbol('acceptance.case.source');

export const TIERS = ['A', 'B', 'C', 'D', 'E'];
export const PRIORITIES = ['P0', 'P1', 'P2'];

/** 用例的 11 个原始字段（与清单页面的 C(id,t,pre,st,ex,b,env,p,m,j,n) 同序），加上定档两字段。 */
export const CASE_FIELDS = ['id', 't', 'pre', 'st', 'ex', 'b', 'env', 'p', 'm', 'j', 'n', 'tier', 'check'];

const CASE_FILE = /^d(\d{2})-[a-z0-9-]+\.json$/;
const CASE_ID = /^AC-(\d{2})-(\d{2})$/;

/**
 * 读 meta.json 与全部 dNN-*.json（按文件名排序）。结构坏了直接抛错：
 * 「cases 不是数组」若当成空文件处理，那个域的用例就会从每一轮里静默消失。
 */
export function loadCases(dir) {
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  const files = readdirSync(dir).filter(f => CASE_FILE.test(f)).sort();
  const cases = [];
  for (const file of files) {
    const body = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    if (!Array.isArray(body?.cases)) throw new Error(`${file}：cases 必须是数组`);
    const domain = Number(CASE_FILE.exec(file)[1]);
    for (const c of body.cases) {
      c[SOURCE] = { file, domain, declared: body.domain };
      cases.push(c);
    }
  }
  return { meta, files, cases };
}

const isBlank = v => typeof v !== 'string' || v.trim() === '';

/**
 * 返回问题列表 [{id, file, message}]，空数组 = 合规。
 * 域号一致性只对 loadCases 读出来的用例判（它们带 SOURCE）；手搓的对象没有来源可比。
 */
export function validateCases(cases, meta) {
  const issues = [];
  const push = (c, message) => issues.push({ id: c?.id ?? null, file: c?.[SOURCE]?.file ?? null, message });

  // 读到 0 条是扫描面塌了（目录写错、文件名不合模式），不是「全部合规」
  if (!Array.isArray(cases) || cases.length === 0) {
    issues.push({ id: null, file: null, message: '一条用例都没有读到：检查 cases/ 目录与 dNN-<slug>.json 文件名' });
    return issues;
  }

  const envCodes = new Set((meta?.envs ?? []).map(e => e.code));
  const seen = new Map();
  const reportedFiles = new Set();

  for (const c of cases) {
    const src = c[SOURCE];
    if (src && src.declared !== src.domain && !reportedFiles.has(src.file)) {
      reportedFiles.add(src.file);
      issues.push({ id: null, file: src.file, message: `文件头 domain 是 ${src.declared}，文件名域号是 ${src.domain}` });
    }

    const m = CASE_ID.exec(c.id ?? '');
    if (!m) {
      push(c, `ID 格式应为 AC-NN-NN，实际是 ${JSON.stringify(c.id)}`);
    } else if (src && Number(m[1]) !== src.domain) {
      push(c, `ID 的域号是 ${m[1]}，却放在 ${src.file}（域 ${String(src.domain).padStart(2, '0')}）里`);
    }
    if (c.id) {
      if (seen.has(c.id)) push(c, `ID 重复：另一条在 ${seen.get(c.id) ?? '同一批输入'} 里`);
      else seen.set(c.id, src?.file ?? null);
    }

    for (const k of ['t', 'st', 'ex']) if (isBlank(c[k])) push(c, `${k} 不能为空`);

    if (!Array.isArray(c.env) || c.env.length === 0) {
      push(c, 'env 必须是非空数组');
    } else {
      const unknown = c.env.filter(code => !envCodes.has(code));
      if (unknown.length) push(c, `env 代码不在 meta.envs 里：${unknown.join(' ')}`);
    }

    if (!PRIORITIES.includes(c.p)) push(c, `p 只能是 ${PRIORITIES.join('/')}，实际是 ${JSON.stringify(c.p)}`);

    if (!('tier' in c)) push(c, 'tier 字段缺失（未定档写 null）');
    else if (c.tier !== null && !TIERS.includes(c.tier)) push(c, `tier 只能是 null 或 ${TIERS.join('/')}，实际是 ${JSON.stringify(c.tier)}`);

    if (!('check' in c)) {
      push(c, 'check 字段缺失（还没有判法写 null）');
    } else if (c.check !== null) {
      if (typeof c.check !== 'object' || Array.isArray(c.check)) {
        push(c, 'check 必须是 null 或 {kind, how, spec?} 对象');
      } else {
        if (isBlank(c.check.kind)) push(c, 'check.kind 不能为空');
        if (isBlank(c.check.how)) push(c, 'check.how 不能为空');
        if ('spec' in c.check && isBlank(c.check.spec)) push(c, 'check.spec 给了就必须是非空字符串');
      }
    }

    // A 档由 run.mjs 按 ID 去重放脚本里找 test；没写脚本路径的 A 档用例在那一步会被静默漏掉
    if (c.tier === 'A' && isBlank(c.check?.spec)) push(c, 'A 档必须在 check.spec 写明重放脚本（如 replay/d09-approval.accept.ts）');
  }
  return issues;
}

/** 按档位与 ID 挑用例。两个条件取交集：点名了 C 档用例但没写出 --tier C，照样不选。 */
export function selectCases(cases, { tiers = ['A'], ids } = {}) {
  const idSet = ids ? new Set(ids) : null;
  return cases.filter(c => tiers.includes(c.tier) && (!idSet || idSet.has(c.id)));
}

// 键序无关的序列化：工具或人手改用例时键序可能变，那不算「用例变了」
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * 相对旧版本有变化的用例 ID（保持 curr 的顺序）：字段变了、新增的，以及 check.spec 指向的
 * 重放脚本在 changedSpecs 里的。changedSpecs 是相对 tests/acceptance/ 的路径。
 */
export function diffCaseIds(prev, curr, changedSpecs = []) {
  const before = new Map(prev.map(c => [c.id, stable(c)]));
  const specs = new Set(changedSpecs);
  return curr
    .filter(c => before.get(c.id) !== stable(c) || (c.check?.spec && specs.has(c.check.spec)))
    .map(c => c.id);
}
