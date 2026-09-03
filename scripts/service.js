#!/usr/bin/env node
// scripts/service.js —— 桌面端服务（LaunchAgent）的管理入口：安装态、归属、启停、健康。
//
// 此前仓库有三份 plist 模板（今 desktop/launchd/）和 render-plist.js 渲染器，但**没有一行代码调用
// launchctl** —— 安装、启停、查状态全靠照抄 docs/deployment.md 里的命令。结果是服务状态不可见：
// 隧道 LastExitStatus=-9（崩过又被 KeepAlive 拉起）这种事，只有公网报 1033 时才发现。
//
// 本文件是那一层的唯一实现。菜单栏 app、doctor D16、web 面板都只消费它的 --json 输出，
// **绝不各自解析 launchctl** —— 同 hooks-bridge-setup.js 与 app/src/ops/cli-hooks-bridge.js 的分工。
//
// ## 三条纪律
//
// 1. **只对 manifest 里记着的 unit 做写操作。** 实测环境中有四个手工装的 unit，其中
//    com.ccm.tunnel-watch 模板里压根没有。它们被识别为 adoptable/unknown：可以看、可以启停，
//    但永不 install/uninstall/覆写。adopt 只写 manifest，一个字节都不碰 plist。
//
// 2. **轮询路径绝不碰 HTTP。** app/src/server/http.js:94-105 对鉴权失败无条件计数、
//    app/src/server/app.js:309 让 loopback 也进限速、rate-limiter 阈值 8 锁 15 分钟 ——
//    每 5s 打一次不带 token 的 /health，40 秒就能把用户连同手机一起关在门外。
//    所以探活只用 `launchctl list`（进程在不在）+ `nc -z`（端口通不通，纯 TCP 握手不发
//    请求行，express 根本不路由）。带 token 的 /health 只在 `health` 子命令里打一次。
//
// 3. **可注入工厂。** 全部 IO 走 deps，宿主机 npm run test:unit 能覆盖判定逻辑而永不真调
//    launchctl —— 范式同 app/src/server/http.js 的 createHttpAuth。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';


import { writeOwnerOnlyFile } from '../app/src/files/file-security.js';
import { renderTemplate, stripLeadingComment } from './render-plist.js';

import { classifyRestartPattern, validateServiceEvents } from '../app/src/ops/service-events.js';
import { CONFIG_FILE_NAME, readConfigFileValues } from '../app/src/ops/config-file.js';
import { DEFAULT_PORT } from '../app/src/ops/env-schema.js';
import {
  DEFAULT_LABEL_PREFIX,
  SERVICE_UNIT_NAMES,
  classifyOwnership,
  classifyState,
  describeSchedule,
  diffUnitSemantics,
  extractSchedule,
  expectedFactsFor,
  extractUnitFacts,
  labelFor,
  parseLaunchctlList,
  renderVarsFor,
  templateFor,
  unitFromLabel,
  validateManifest,
} from '../app/src/ops/service-units.js';

export const STATUS_SCHEMA_VERSION = 1;

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const AGENTS_SUBPATH = ['Library', 'LaunchAgents'];

// CCM_TEST_PLATFORM：仅测试用的平台覆盖，任何宿主 OS 上都能验证降级分支（同 hooks-bridge-setup.js:114）。
function currentPlatform() {
  return process.env.CCM_TEST_PLATFORM || process.platform;
}

function sha256(content) {
  return createHash('sha256').update(String(content ?? '')).digest('hex');
}

// 渲染走 render-plist.js（字面量替换 + XML 转义，审计 TC-009）——路径含 &/#/空格/引号都安全。
// stripLeadingComment 剥掉模板头部那段讲占位符的说明注释，否则它会被自己的占位符替换成一段乱码。
function realRenderPlist(unit, vars) {
  const tpl = readFileSync(join(ROOT, templateFor(unit)), 'utf8');
  return renderTemplate(stripLeadingComment(tpl), vars);
}

export function createServiceManager(deps = {}) {
  const {
    platform = currentPlatform(),
    home = homedir(),
    repo = ROOT,
    node: nodePath = process.execPath,
    labelPrefix = DEFAULT_LABEL_PREFIX,
    now = Date.now,
    execLaunchctl = () => ({ status: 1, stdout: '', stderr: 'not wired' }),
    readPlistFile = () => null,
    readManifest = () => null,
    readEnv = () => ({}),
    envFileExists = () => false,
    tcpProbe = () => false,
    portListenerPid = () => null,
    lanIp = () => null,
    listAgentLabels = () => [],
    realpath = (p) => p,
    // 写路径依赖
    uid = typeof process.getuid === 'function' ? process.getuid() : 0,
    readFileRaw = () => null,
    writeFile = () => {},
    deleteFile = () => {},
    fileExists = () => false,
    writeManifest = () => {},
    readEvents = () => [],
    renderPlist = realRenderPlist,
    sleep = realSleep,
    httpGet = realHttpGet,
  } = deps;

  const plistPathFor = (label) => join(home, ...AGENTS_SUBPATH, `${label}.plist`);
  const ctx = { repo, node: nodePath, home, labelPrefix };

  // 路径事实在比较前先解析符号链接。真机实测（2026-08-13）：process.execPath 给的是
  // /opt/homebrew/Cellar/node/25.9.0_3/bin/node（真身），而 plist 里写的是
  // /opt/homebrew/bin/node（homebrew symlink）—— 同一个二进制、字符串不同。不归一就会把
  // 正在跑的生产 server 判成 foreign，adopt 直接失效（正是最该避免的失败模式）。
  const normalizePaths = (facts) => ({
    ...facts,
    repo: facts.repo ? realpath(facts.repo) : facts.repo,
    node: facts.node ? realpath(facts.node) : facts.node,
    log: facts.log ? realpath(facts.log) : facts.log,
  });

  function unsupported() {
    return {
      schemaVersion: STATUS_SCHEMA_VERSION,
      platform,
      supported: false,
      repo,
      labelPrefix,
      generatedAt: now(),
      setup: { envExists: envFileExists(), port: null, lanUrl: null },
      units: [],
      // 明确 reason 而不是静默假成功 —— 同 app/src/ops/log-terminal.js:33-36 的立场。
      // 指路只能指向本仓真有的东西：非 macOS 的入口就是 headless `npm start`，
      // 保活方式（tmux / 自建 systemd unit / docker）由用户自己定，仓库不提供 unit。
      warnings: [`LaunchAgent 服务管理仅支持 macOS（当前平台：${platform}）。非 macOS 用 npm start 启动，保活方式自选，见 docs/deployment.md`],
    };
  }

  // launchctl 挂了不该炸掉整个 status：plist 还在盘上，unit 列表照样有价值（只是没有 PID）。
  function launchctlList(warnings) {
    try {
      const r = execLaunchctl(['list']);
      if (!r || r.status !== 0) {
        warnings.push(`launchctl list 失败：${String(r?.stderr || '未知错误').trim().split('\n')[0]}`);
        return new Map();
      }
      return parseLaunchctlList(r.stdout);
    } catch (err) {
      warnings.push(`launchctl 不可用：${String(err?.message || err).split('\n')[0]}`);
      return new Map();
    }
  }

  function readPlistSafe(path, warnings) {
    try {
      return readPlistFile(path);
    } catch (err) {
      warnings.push(`读取 ${path} 失败：${String(err?.message || err).split('\n')[0]}`);
      return null;
    }
  }

  function buildKnownUnit(unit, { live, liveKnown, manifest, warnings, fast, port, events }) {
    const label = labelFor(unit, labelPrefix);
    const plistPath = plistPathFor(label);
    // 文件在不在、能不能解析，是两个独立的事实，要分别喂给 classifyState。
    // readPlistFile 对「文件不存在」「plutil 非零退出」「plutil 5s 超时」一律返回 null，
    // 而 readPlistSafe 只在**抛异常**时发警告 —— plutil 静默失败那条路径此前一句话都没有。
    const plistFileExists = fileExists(plistPath);
    const plist = plistFileExists ? readPlistSafe(plistPath, warnings) : null;
    const plistExists = !!plist;
    if (plistFileExists && !plistExists) {
      warnings.push(`${label} 的 plist 在盘上但解析不出来（plutil 非零退出或超时）——`
        + '漂移判定与调度形态本轮不可用，状态按「进程在不在」保守给出');
    }
    const running = live.get(label) || { pid: null, lastExit: null };

    const facts = plistExists ? extractUnitFacts(unit, plist) : null;
    // plist 不存在时**不做漂移判定**：extractUnitFacts(null) 会让每一项都是 null，
    // diffUnitSemantics 据此报 shape → ownership 变 foreign → 连 install 都会被自己拒掉。
    const drift = plistExists
      ? diffUnitSemantics(
        unit,
        normalizePaths(expectedFactsFor(unit, ctx)),
        normalizePaths(facts)
      )
      : [];

    // menubar 的 LaunchAgent 只有一个可执行目标：那个 .app 的路径。它**不在 driftFields 里**
    // ——app 是安装期参数，status 侧没有期望值可比（expectedFactsFor 里 app 恒为 ctx.app ?? null），
    // 塞进去会 expected=null vs actual=有值、每次都报假漂移，见 service-units.js 头注那条纪律。
    // 代价是它失效时三条自查路径全绿：status 的 drift 是空数组，doctor 只消费 drift，菜单栏读同一份。
    // 2026-08-18 在真机实测中实证过这个盲区：自启指向 <repo>/desktop/build/CCM.app —— gitignore
    // 的构建产物，git clean 一下开机自启就没了，而没有任何地方会告诉他。所以改判 actual 值本身。
    if (unit === 'menubar' && facts?.app) {
      if (!fileExists(facts.app)) {
        warnings.push('开机自启指向的 CCM.app 已不存在，登录时拉不起菜单栏 —— '
          + '跑 npm run app:install 重装，再在菜单里重新勾一次「开机自启（菜单栏）」');
      } else if (repo && facts.app.startsWith(`${repo}/`)) {
        // 只给仓库相对形态：这条会渲染进菜单栏的 ⚠ 行，绝对路径又长又没多给信息。
        warnings.push(`开机自启指向仓库内的 ${facts.app.slice(repo.length + 1)} —— 那是 gitignore `
          + '的构建产物，git clean 或换分支后自启会静默失效。跑 npm run app:install 装到 '
          + '/Applications，再在菜单里重新勾一次「开机自启（菜单栏）」');
      }
    }
    const inManifest = Object.hasOwn(manifest.units, unit);
    const schedule = extractSchedule(plist);
    // live.has(label) = launchd 域里还有没有这个 job。这一位以前拿到了却没往下传，于是
    // 「被 bootout 的定时器」和「装着待机的定时器」渲染成同一行 —— 日志轮转停了看不出来。
    const { state, lastExitAbnormal, loaded } = classifyState({ ...running, plistExists, plistFileExists, loaded: liveKnown ? live.has(label) : null });
    const ownership = classifyOwnership({ knownUnit: true, inManifest, drift });
    // flapping 来自**重启频率**而不是最后一次退出码 —— 见 service-units.js 的 classifyState 头注。
    const restarts = classifyRestartPattern(events, { label, now: now() });

    return {
      unit,
      label,
      known: true,
      ownership,
      state,
      pid: running.pid,
      lastExitStatus: running.lastExit,
      lastExitAbnormal,
      loaded,
      flapping: restarts.flapping,
      restarts,
      drift,
      plistPath,
      schedule,
      // 只有 server 监听本地端口；隧道与定时器没有可探的端口。
      listen: unit === 'server' && !fast ? { port, reachable: !!tcpProbe(port) } : null,
      detail: describeUnit({ state, restarts, lastExitAbnormal, drift, plistExists, ownership, schedule, loaded }),
    };
  }

  // 前缀命中但不在模板表里的 unit（用户自建的 com.ccm.tunnel-watch）。看得见才管得住 ——
  // 它占着我们的 label 命名空间，status 里不列出来等于假装它不存在。
  function buildUnknownUnits({ live, liveKnown, warnings, knownLabels, events }) {
    const labels = new Set();
    for (const label of live.keys()) labels.add(label);
    try {
      for (const label of listAgentLabels()) labels.add(label);
    } catch { /* 目录读不到就只靠 launchctl 发现，不值得报错 */ }

    const out = [];
    for (const label of labels) {
      if (!label.startsWith(`${labelPrefix}.`) || knownLabels.has(label)) continue;
      if (unitFromLabel(label, labelPrefix)) continue; // 已知 unit 已在上一轮处理
      const plistPath = plistPathFor(label);
      const plistFileExists = fileExists(plistPath);
      const plist = plistFileExists ? readPlistSafe(plistPath, warnings) : null;
      const plistExists = !!plist;
      const running = live.get(label) || { pid: null, lastExit: null };
      const schedule = extractSchedule(plist);
      // 自建 unit（用户自建的 com.ccm.tunnel-watch 这类 unit）同样要能看出「已被 bootout」——
      // 它们恰恰是最容易被读成「装了但没启用」的那类，少了这一位就只能靠猜。
      const { state, lastExitAbnormal, loaded } = classifyState({
        ...running, plistExists, plistFileExists, loaded: liveKnown ? live.has(label) : null,
      });
      const restarts = classifyRestartPattern(events, { label, now: now() });
      out.push({
        unit: label.slice(labelPrefix.length + 1),
        label,
        known: false,
        ownership: 'unknown',
        state,
        pid: running.pid,
        lastExitStatus: running.lastExit,
        lastExitAbnormal,
        flapping: restarts.flapping,
        restarts,
        loaded,
        drift: [],
        plistPath,
        schedule,
        listen: null,
        // 待机说明排在前面：自建 unit 同时带着「非本仓」与 stopped 两个标签，最容易被读成
        // 「装了但没启用」——用户自建的 tunnel-watch 就是这么被问的。先说它在正常待机。
        // 但「待机」的前提是它还在 launchd 域里，被 bootout 之后那句话就是假的。
        detail: [
          state === 'stopped' ? idleOrStoppedText(schedule, loaded) : null,
          '非本仓管理（模板里没有这个 unit），只可查看与启停',
        ].filter(Boolean).join('；'),
      });
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  }

  function status({ fast = false } = {}) {
    if (platform !== 'darwin') return unsupported();

    const warnings = [];
    const manifest = validateManifest(readManifest());
    // launchctlList 在失败时返回**空 Map** —— 那是「不知道」，不是「什么都没加载」。
    // liveKnown 把这两者分开：读不到时全体 unit 的 loaded 记 null，否则一次 list 失败
    // 会让每一行都言之凿凿地说「已从 launchd 卸载」，而那是个具体的假事实。
    const beforeList = warnings.length;
    const live = launchctlList(warnings);
    const liveKnown = warnings.length === beforeList;
    const env = readEnv() || {};
    const port = positivePort(env.PORT) ?? DEFAULT_PORT;

    // 重启历史由 server 进程周期采样落盘（见 app/src/server/app.js 的 sampleServiceEvents）。
    // 这里只读不写：status 可能被菜单栏每 2s 调一次，写盘会打架。
    const events = validateServiceEvents(readEvents());

    const knownLabels = new Set(SERVICE_UNIT_NAMES.map((u) => labelFor(u, labelPrefix)));
    const units = SERVICE_UNIT_NAMES
      .map((unit) => buildKnownUnit(unit, { live, liveKnown, manifest, warnings, fast, port, events }))
      .concat(buildUnknownUnits({ live, liveKnown, warnings, knownLabels, events }));

    const ip = lanIp();
    return {
      schemaVersion: STATUS_SCHEMA_VERSION,
      platform,
      supported: true,
      repo,
      labelPrefix,
      generatedAt: now(),
      // 刻意不含 AUTH_TOKEN 的任何形态（连长度都不给）：这份 JSON 会流进菜单栏 app 的进程内存。
      setup: { envExists: !!envFileExists(), port, lanUrl: ip ? `http://${ip}:${port}` : null },
      units,
      warnings,
    };
  }

  // ---------- 写路径 ----------
  //
  // 全部三个动作共享一条护栏：**只对 manifest 里记着的 unit 做写操作**。盘上已有但不在 manifest
  // 的（手工装的那几个）一律走 adopt；语义不等价的（自写包装脚本的隧道）连 adopt 都拒绝 ——
  // 接管了就意味着将来会被覆写，而那份配置是用户特意写的。

  function guardUnit(unit) {
    if (platform !== 'darwin') return `LaunchAgent 管理仅支持 macOS（当前：${platform}）`;
    if (!SERVICE_UNIT_NAMES.includes(unit)) {
      return `未知 unit: ${unit}（可用：${SERVICE_UNIT_NAMES.join(' / ')}）`;
    }
    return null;
  }

  // 盘上那份与模板是否语义等价。读不出 plist 一律按「形态不认识」处理（宁可拒绝也不覆写）。
  function driftOf(unit, plistPath) {
    const plist = readPlistFile(plistPath);
    if (!plist) return ['shape'];
    return diffUnitSemantics(
      unit,
      normalizePaths(expectedFactsFor(unit, ctx)),
      normalizePaths(extractUnitFacts(unit, plist))
    );
  }

  // 装 tunnel 前必须已有 ~/.cloudflared/config.yml：没有它 cloudflared 起不来，
  // 而 KeepAlive=true 会把失败变成一个无限崩溃重启循环（那个 -9 就是这么来的）。
  function precheck(unit, opts) {
    // menubar 的 APP 无人把关时，escapeXml(undefined) 会把字面量 "undefined" 写进 plist，
    // 还报「✓ 已安装并加载」；而 menubar 的 driftFields 只有 log-path，status 会一直显示
    // managed 无漂移，用户无从发现。desktop/launchd/menubar.plist.template 的头注恰好教人这么装。
    if (unit === 'menubar') {
      if (!opts.app) return '装 menubar 需要 --app=<CCM.app 的绝对路径>';
      // ★ 只判「给没给」是不够的。从 manifest 恢复时这个值来自上次安装，而它很可能指向
      // <repo>/desktop/build/CCM.app —— gitignore 的构建产物，git clean / 换分支就没了。
      // 那时重建出来的 plist 指向一个不存在的 bundle，CLI 却报「✓ 已修复安装」，
      // 登录时什么也拉不起来，而 menubar 的 driftFields 里没有 app，status 一路显示正常。
      // 1158e7a 修的正是这个盲区，别在恢复路径上把它重新放进来。
      if (!fileExists(opts.app)) {
        return `${opts.app} 不存在 —— 先跑 npm run app:install 装到 /Applications，再用 --app= 指向它`;
      }
      return null;
    }
    if (unit !== 'tunnel') return null;
    if (!fileExists(join(home, '.cloudflared', 'config.yml'))) {
      return '未找到 ~/.cloudflared/config.yml —— 先按 docs/deployment.md §1 建好命名隧道再装，'
        + '否则装出来的是一个不断崩溃重启的 unit';
    }
    if (!opts.tunnel || !opts.cloudflared) {
      return '装 tunnel 需要 --tunnel=<隧道名> 与 --cloudflared=<绝对路径>';
    }
    return null;
  }

  // manifest 里记的模板变量 → install 的 opts。renderVarsFor 是正方向（opts → vars），
  // 恢复时需要反过来：plist 被 git clean / 手滑删掉时，用户不会在命令行上再打一次
  // --tunnel/--cloudflared/--app，而这些值工具自己一直存着。
  // 只映射「无法从 ctx 推出来」的那几个：REPO/NODE/LOG/LABEL 每次都由 ctx 重算，
  // 拿旧值反而会把仓库搬家后的恢复钉回旧路径。
  const optsFromVars = (vars) => {
    const v = vars && typeof vars === 'object' ? vars : {};
    const out = {};
    if (typeof v.TUNNEL === 'string' && v.TUNNEL) out.tunnel = v.TUNNEL;
    if (typeof v.CLOUDFLARED === 'string' && v.CLOUDFLARED) out.cloudflared = v.CLOUDFLARED;
    if (typeof v.APP === 'string' && v.APP) out.app = v.APP;
    return out;
  };

  function install(unit, rawOpts = {}) {
    const bad = guardUnit(unit);
    if (bad) return { ok: false, unit, error: bad };
    const held = serverPortConflict(unit);
    if (held) return { ok: false, unit, error: portConflictError(held) };

    const label = labelFor(unit, labelPrefix);
    const plistPath = plistPathFor(label);
    const manifest = validateManifest(readManifest());
    const inManifest = Object.hasOwn(manifest.units, unit);
    const exists = fileExists(plistPath);

    // manifest 有记录就拿它补参数，CLI 显式给的压过它 —— 用户想换隧道时必须换得掉。
    // **不能只挂在 `!exists` 分支上**：那样同一条 `install tunnel`（不带参数）会因为 plist
    // 在不在而给出相反结果 —— plist 还在时走 changedVars 比对，desired 从空 opts 算出来
    // 全是 undefined，于是报「参数与当前配置不一致（CLOUDFLARED / TUNNEL）… 先卸载再装」，
    // 让人为了没重复输入工具自己存着的参数，去拆掉一条正常工作的隧道。
    // 没有 manifest 记录时（全新安装）一律只认 CLI，避免旧值悄悄参与。
    const opts = inManifest
      ? { ...optsFromVars(manifest.units[unit]?.vars), ...rawOpts }
      : rawOpts;

    if (inManifest && exists) {
      // 参数变了不能装作没看见。这个早退此前只看「manifest 有记录 + plist 在盘上 + launchd
      // 认识它」三件事，**完全不比对内容** —— 于是 `install menubar --app=<新路径>` 会回一句
      // 「已是目标状态，无需改动」，而 plist 纹丝不动。2026-08-18 实测到的死循环就是这么来的：
      // status 报「开机自启指向仓库构建产物」，照它给的命令执行，CLI 说没事，警告下一次照旧。
      //
      // 这里**不自动重写**：那要连带 bootout + bootstrap 去改一个正在跑的 unit，风险面大于收益。
      // 按下面「盘上有、manifest 没有」那条分支的同款风格 —— 报错 + 指出唯一的出路。
      const desiredVars = renderVarsFor(unit, { ...ctx, ...opts });
      const recordedVars = manifest.units[unit]?.vars ?? {};
      const changedVars = Object.keys(desiredVars).filter((k) => desiredVars[k] !== recordedVars[k]);
      if (changedVars.length) {
        return {
          ok: false,
          unit,
          label,
          plistPath,
          error: `${label} 已安装，但本次参数与它当前的配置不一致（${changedVars.join(' / ')}）。`
            + '本工具不就地改写正在运行的 unit —— 先卸载再装：'
            + `node scripts/service.js uninstall ${unit} --yes`,
        };
      }
      // vars 一致 ≠ 盘上那份就是当前模板渲染的：**模板自身**可能在升级里变了（2026-09-03
      // 运行时入口从 server.js 挪到 app/server.js 就是这样），那时 vars 一个都没变，而
      // ~/Library/LaunchAgents 里那份是安装时渲染的、不会跟着更新，服务直接起不来。
      // 不比对内容的话这里会回「已是目标状态」——用户跑了命令、看到成功、问题依旧，
      // 比直接报错更难排查。上面那段注释记的 2026-08-18 死循环只补了「vars 变了」这一维。
      // 同款风格：不就地改写正在跑的 unit（要连带 bootout + bootstrap，风险面大于收益），
      // 只报错 + 指出唯一的出路。
      // driftOf 在「plist 读不出来」时返回 ['shape']——那是给 status 的保守默认（宁可说不接管）。
      // 这里不能照单全收：读不出来是 plutil 解析失败，不是模板过期，据此拦住 install 会把
      // 「plutil 抽风」升级成「装不上」。只在真解析出内容时才判定。
      const stalePlist = readPlistFile(plistPath) ? driftOf(unit, plistPath) : [];
      if (stalePlist.length) {
        return {
          ok: false,
          unit,
          label,
          plistPath,
          error: `${label} 已安装，但盘上那份与当前模板不一致（${stalePlist.join(' / ')}）——`
            + '多半是升级后没重装。先卸载再装：'
            + `node scripts/service.js uninstall ${unit} --yes`,
        };
      }

      // 别急着说 already：bootstrap 可能上次失败了（macOS 的 "Load failed: 5" 很常见），
      // 那时 plist 与 manifest 都在盘上、launchd 却不认识这个 unit。早前这里无条件早退，
      // 用户就困在死路里 —— install 说「已是目标状态」+ exit 0，start 却报 Could not find service，
      // 只有先 uninstall 再 install 才出得来，而 CLI 没有任何提示指向那条路。
      if (launchctlList([]).has(label)) {
        return { ok: true, unit, label, action: 'already', plistPath };
      }
      const retry = execLaunchctl(['bootstrap', `gui/${uid}`, plistPath]);
      if (!retry || retry.status !== 0) {
        return {
          ok: false,
          unit,
          label,
          plistPath,
          error: `plist 已在盘上但未被加载，重试 bootstrap 仍失败：${String(retry?.stderr || '未知错误').trim().split('\n')[0]}`,
        };
      }
      return { ok: true, unit, label, plistPath, action: 'recovered' };
    }

    // 盘上有、manifest 没有 —— 不是我们装的，绝不覆写。
    if (exists && !inManifest) {
      const drift = driftOf(unit, plistPath);
      if (drift.includes('shape')) {
        return { ok: false, unit, label, error: `${label} 是自定义启动方式，本工具不接管（也不会改写它）` };
      }
      return {
        ok: false,
        unit,
        label,
        error: `${label} 已存在且是手工安装的。想让本工具接管请先 \`adopt\`（只写 manifest，不动 plist）`,
      };
    }

    const pre = precheck(unit, opts);
    if (pre) return { ok: false, unit, label, error: pre };

    const vars = renderVarsFor(unit, { ...ctx, ...opts });
    let content;
    try {
      content = renderPlist(unit, vars);
    } catch (err) {
      return { ok: false, unit, label, error: `渲染 plist 失败：${String(err?.message || err)}` };
    }

    // 写序：manifest 先落盘 → plist → bootstrap。反过来的话，中断在「plist 已写、manifest 未写」
    // 会留下一个孤儿 plist，下次 status 判它 adoptable、install 让你去 adopt —— 用户一头雾水。
    manifest.units[unit] = {
      label,
      plistPath,
      sha256: sha256(content),
      template: templateFor(unit),
      vars,
      installedAt: now(),
      adopted: false,
    };
    writeManifest(manifest);
    writeFile(plistPath, content);

    const r = execLaunchctl(['bootstrap', `gui/${uid}`, plistPath]);
    if (!r || r.status !== 0) {
      return {
        ok: false,
        unit,
        label,
        plistPath,
        error: `plist 已写入但 bootstrap 失败：${String(r?.stderr || '未知错误').trim().split('\n')[0]}`,
      };
    }
    return { ok: true, unit, label, plistPath, action: inManifest ? 'recovered' : 'installed' };
  }

  // 接管手工安装：**只写 manifest，一个字节都不碰 plist**。这是 adopt 零风险的全部依据。
  function adopt(unit, opts = {}) {
    const bad = guardUnit(unit);
    if (bad) return { ok: false, unit, error: bad };

    const label = labelFor(unit, labelPrefix);
    const plistPath = plistPathFor(label);
    const manifest = validateManifest(readManifest());
    if (Object.hasOwn(manifest.units, unit)) return { ok: true, unit, label, action: 'already' };
    if (!fileExists(plistPath)) return { ok: false, unit, label, error: `${label} 未安装，无从接管` };

    const drift = driftOf(unit, plistPath);
    if (drift.includes('shape')) {
      return { ok: false, unit, label, error: `${label} 是自定义启动方式，本工具不接管（接管意味着将来会被覆写）` };
    }
    if (drift.length) {
      return { ok: false, unit, label, error: `${label} 配置与模板不一致（${drift.join('、')}），先确认再决定是否接管` };
    }

    // sha 记的必须是**盘上那份**的字节，不是模板渲染结果 —— 后者会让下次 uninstall 的 CAS 立刻误判。
    manifest.units[unit] = {
      label,
      plistPath,
      sha256: sha256(readFileRaw(plistPath) ?? ''),
      template: templateFor(unit),
      // vars 是「将来 recovered 分支要拿来重渲染的参数」，所以这里也要收 opts 里的 node
      // （登录 shell 的稳定 symlink），否则重建出来的 plist 会指向 Cellar 真身。
      vars: renderVarsFor(unit, { ...ctx, ...opts }),
      installedAt: now(),
      adopted: true,
    };
    writeManifest(manifest);
    return { ok: true, unit, label, action: 'adopted' };
  }

  // confirmed 默认 false —— **护栏放在这一层而不是 CLI 层**：将来菜单栏 app 或任何别的调用方
  // 忘了确认，也会被拒绝，而不是默默把服务卸掉。
  //
  // 这条护栏是 2026-08-13 一次真实事故的产物：当时以「验证护栏会拒绝」为由在生产机器上跑了
  // uninstall，而预期是错的（adopt 记的正是盘上那份的 sha，CAS 当然匹配），服务被真删了。
  // 教训与 CLAUDE.md 里 mutate 删库那条同型：**别给破坏性操作开「这次应该安全」的例外**。
  function uninstall(unit, { force = false, confirmed = false } = {}) {
    const bad = guardUnit(unit);
    if (bad) return { ok: false, unit, error: bad };
    if (confirmed !== true) {
      return {
        ok: false,
        unit,
        needsConfirm: true,
        error: '卸载会停止服务并删除 plist。加 --yes 确认，或在交互终端里回答 y。',
      };
    }

    const label = labelFor(unit, labelPrefix);
    const plistPath = plistPathFor(label);
    const manifest = validateManifest(readManifest());
    const entry = manifest.units[unit];

    if (!entry) {
      return {
        ok: false,
        unit,
        label,
        error: fileExists(plistPath)
          ? `${label} 不是本工具安装的（不在 manifest 里），拒绝删除。想管理它请先 \`adopt\``
          : `${label} 未安装`,
      };
    }

    // 删除目标用**派生路径**而不是 manifest 里存的 entry.plistPath：后者是磁盘上的 JSON，
    // 被篡改后能指向任意文件（实测 validateManifest 只校验它是非空字符串，不校验位置）。
    // 派生路径恒为 plistPathFor(labelFor(unit))，unit 已过 guardUnit 的白名单。
    // entry.plistPath 只保留给 CAS 与展示。
    const target = plistPathFor(label);

    // CAS：盘上这份还是不是我们当初写下的那份？**这个问题字节相等才是正确判据**
    // （与漂移判定的语义比对是两个不同的问题，两个哈希两个用途，别混）。
    const raw = readFileRaw(target);
    // raw 为 null 有两种成因，必须分开：文件不在（那就是我们要的终态，放行）vs 文件在但读不出来
    // （权限不足/IO 错误 —— CAS 无从验证，此时放行等于护栏静默失效，而 unlink 只要父目录可写就成）。
    if (raw === null && fileExists(target) && !force) {
      return { ok: false, unit, label, error: `${target} 读不出来，无法核对是否是本工具安装的那份，拒绝删除。确认无误可加 --force` };
    }
    if (raw !== null && !force && sha256(raw) !== entry.sha256) {
      return {
        ok: false,
        unit,
        label,
        error: `${target} 与安装时不一致（你手动改过？），拒绝删除。确认无误可加 --force`,
      };
    }

    // bootout 对没在跑的 unit 会返回非零（"Could not find service"）—— 那不是失败是「本来就没跑」。
    // 据此中止会让 plist 与 manifest 永远卸不掉。
    // 用派生的 label 而不是 entry.label：manifest 是磁盘 JSON，validateManifest 对 label 只校验
    // 「非空字符串」，篡改后能 bootout 任意 gui/<uid>/<label>。删文件那半已经用派生路径了，
    // 这半不跟上等于护栏只做了一半。
    execLaunchctl(['bootout', `gui/${uid}/${label}`]);

    // safe-path: target 由 plistPathFor(labelFor(unit)) 派生，unit 已过 guardUnit 的白名单
    // （SERVICE_UNIT_NAMES 之一），home 来自 os.homedir()。**刻意不用 manifest 里的 plistPath**
    // ——那是磁盘 JSON，被篡改后能指向任意文件，而 validateManifest 不校验它的位置。
    deleteFile(target);

    delete manifest.units[unit];
    writeManifest(manifest);
    return { ok: true, unit, label, action: 'uninstalled' };
  }

  // ---------- 控制路径 ----------
  //
  // 与写路径的护栏不同：install/uninstall 会改盘上的 plist，所以只允许 managed；
  // **启停不改任何配置**，所以用户自建的 com.ccm.tunnel-watch 也该能从菜单栏开关 ——
  // 否则「看得见管不着」。唯一的限制是 label 必须落在我们的前缀命名空间内。
  function guardControllable(unit) {
    if (platform !== 'darwin') return `LaunchAgent 管理仅支持 macOS（当前：${platform}）`;
    if (typeof unit !== 'string' || !unit || unit.includes('.') || unit.includes('/')) {
      return `非法 unit 名：${unit}（只接受 ${labelPrefix}.<name> 里的 <name> 部分）`;
    }
    const label = labelFor(unit, labelPrefix);
    if (!fileExists(plistPathFor(label))) return `${label} 未安装`;
    return null;
  }

  const launchctlErr = (r) => {
    if (r?.error?.code === 'ETIMEDOUT') {
      return 'launchctl 超时（刚重启过的服务可能被系统节流，稍后再试）';
    }
    return String(r?.stderr || r?.stdout || '未知错误').trim().split('\n')[0];
  };

  function currentPid(label) {
    return launchctlList([]).get(label)?.pid ?? null;
  }

  // ## 为什么要先探测 domain（2026-08-14 第三轮审查修复）
  //
  // `man launchctl`：bootout「**removes their definitions**」，kickstart「run **the specified
  // service**」。stop 用的是 bootout ⇒ unit 已经不在 domain 里 ⇒ 之后 kickstart 必然
  // `Could not find service`。而 guardControllable 只检查 plist **文件**存在（bootout 不删文件），
  // 所以护栏放行、直接撞上失败：菜单栏点「停止」再点「启动」必失败，CLI 同理。
  //
  // 更糟的是 app/src/ops/doctor-checks.js 对 stopped 态给的修复建议恰恰就是这条 start 命令。
  //
  // 所以按 domain 里在不在分流：在 → kickstart（bootstrap 会报 already loaded）；
  // 不在 → bootstrap 把 plist 重新载入。两条路径都只在**我们自己前缀**下的 label 上跑
  // （guardControllable 已经把 unit 名约束在 labelPrefix 命名空间内）。
  // live 可由调用方传入已取好的一份，避免多打一次 `launchctl list`
  // （restart 本来就要查一次拿旧 PID，那份直接复用）。
  function ensureLoaded(label, live = launchctlList([])) {
    if (live.has(label)) return null;
    const r = execLaunchctl(['bootstrap', `gui/${uid}`, plistPathFor(label)]);
    return !r || r.status !== 0 ? launchctlErr(r) : null;
  }

  // 端口上的监听 pid 对不上 LaunchAgent 时禁止再 kickstart：否则第二个 app/server.js
  // EADDRINUSE 退出，KeepAlive 空转，菜单还报成功。常见情况是终端里先开了 npm start。
  function serverPortConflict(unit) {
    if (unit !== 'server') return null;
    const port = positivePort((readEnv() || {}).PORT) ?? DEFAULT_PORT;
    const listenPid = portListenerPid(port);
    if (!listenPid) return null;
    const ours = currentPid(labelFor(unit, labelPrefix));
    if (ours && listenPid === ours) return null;
    return { port, listenPid };
  }

  function portConflictError({ port, listenPid }) {
    return `端口 ${port} 已被其它进程占用（pid=${listenPid}），不是桌面端拉起的 server。若是终端里的 npm start，先停掉再启动。`;
  }

  // 「没能确认监听者是自己」时的说辞。走到这里说明两道 lsof 判据都 fail-open 了，
  // 剩下的 tcpProbe 是弱判据：纯 TCP 握手对占位进程一样通。不阻断（lsof 可能只是
  // 权限不足或超时），但要留下痕迹 + 指向 health —— 那是唯一能区分「我们的服务在听」
  // 与「某个进程占着这个端口」的判据（同 desktop/CCMCore.swift 装机末步的选择）。
  function unverifiedWarning(port) {
    return `端口 ${port} 通了，但没能确认监听者就是本服务（lsof 不可用或看不到该进程）。`
      + '用 `npm run service:health` 复核。';
  }

  function confirmServerListening(label, { timeoutMs = 15000, intervalMs = 300 } = {}) {
    const port = positivePort((readEnv() || {}).PORT) ?? DEFAULT_PORT;
    const maxTries = Math.max(1, Math.ceil(timeoutMs / intervalMs));
    for (let i = 0; i < maxTries; i += 1) {
      if (i > 0) sleep(intervalMs);
      const pid = currentPid(label);
      if (!pid) continue;
      const listenPid = portListenerPid(port);
      if (listenPid && listenPid !== pid) {
        return { ok: false, pid, error: portConflictError({ port, listenPid }) };
      }
      if (listenPid === pid) return { ok: true, pid };
      if (tcpProbe(port)) return { ok: true, pid, unverified: true, warning: unverifiedWarning(port) };
    }
    return { ok: false, error: `启动后未能确认进程在听端口 ${port}` };
  }

  // 只在弱判据成立时才往结果里加字段——强判据下的成功结果保持原样（无关字段会进 --json，
  // 桌面端解析的是同一份对象）。
  function weakProof(ready) {
    return ready.unverified ? { unverified: true, warning: ready.warning } : {};
  }

  function start(unit, { timeoutMs = 15000, intervalMs = 300 } = {}) {
    const bad = guardControllable(unit);
    if (bad) return { ok: false, unit, error: bad };
    const held = serverPortConflict(unit);
    if (held) return { ok: false, unit, error: portConflictError(held) };
    const label = labelFor(unit, labelPrefix);
    const loadErr = ensureLoaded(label);
    if (loadErr) return { ok: false, unit, label, error: loadErr };
    // 到这里 unit 一定在 domain 里：kickstart 让它立刻跑起来（无视 RunAtLoad 等启动条件）
    const r = execLaunchctl(['kickstart', `gui/${uid}/${label}`]);
    if (!r || r.status !== 0) return { ok: false, unit, label, error: launchctlErr(r) };
    if (unit !== 'server') return { ok: true, unit, label, action: 'started' };
    const ready = confirmServerListening(label, { timeoutMs, intervalMs });
    if (!ready.ok) return { ok: false, unit, label, error: ready.error };
    return { ok: true, unit, label, action: 'started', ...weakProof(ready) };
  }

  function stop(unit) {
    const bad = guardControllable(unit);
    if (bad) return { ok: false, unit, error: bad };
    const label = labelFor(unit, labelPrefix);
    // ★ stop 要的是「它别跑了」。已经不在 domain 里时那个状态本来就成立，而 bootout 这时返回
    // 非零（"Boot-out failed: 3: No such process"）—— uninstall 一直把它当「本来就没跑」忽略掉
    // （见那里的注释），stop 却据此报 ✗ 并在菜单栏弹失败提示。最容易撞上的两种情形：连点两次
    // 停止、或停一个上次就已被 bootout 的 unit —— 而后者在面板上一直显示成健康待机，用户
    // 根本无从知道它已经停了。判据用 domain 成员关系而不是解析错误串：与 start/restart 走
    // ensureLoaded 的那一侧对称，也不依赖 launchctl 的文案措辞。
    // ★ launchctlList 在「list 非零退出」和「抛异常」时都返回**空 Map**，那不是「什么都没加载」，
    // 是「不知道」。据空 Map 早退会让 launchctl 不可用时 stop 报「✓ 已停止」、退出 0、
    // 却根本没跑 bootout —— 服务还在跑，而人以为停了。这是 fail-open，比原来的误报严重得多。
    // 所以只在**确知**它不在 domain 里时才早退：list 自己出问题就照常走 bootout，让真错误浮上来。
    const listWarnings = [];
    const live = launchctlList(listWarnings);
    if (listWarnings.length === 0 && !live.has(label)) {
      return { ok: true, unit, label, action: 'stopped', alreadyStopped: true };
    }
    const r = execLaunchctl(['bootout', `gui/${uid}/${label}`]);
    if (!r || r.status !== 0) return { ok: false, unit, label, error: launchctlErr(r) };
    return { ok: true, unit, label, action: 'stopped' };
  }

  // 就绪判定用 **PID 变化**，不打 /health。
  // 那是 tests/integration/_spawn-server.mjs:83-97 里 buildNonce 想解决的同一个问题
  // （「端口上是我刚起的进程还是旧进程」）的零成本等价物 —— launchd 直接告诉你 PID 换没换，
  // 而打 /health 要带 token，带错就往限速计数器上撞。
  function restart(unit, { wait = false, timeoutMs = 15000, intervalMs = 300 } = {}) {
    const bad = guardControllable(unit);
    if (bad) return { ok: false, unit, error: bad };
    const held = serverPortConflict(unit);
    if (held) return { ok: false, unit, error: portConflictError(held) };
    const label = labelFor(unit, labelPrefix);
    // 一次 list 同时拿到「旧 PID」与「在不在 domain 里」——不为第二个问题再打一次 launchctl
    const live = launchctlList([]);
    const oldPid = live.get(label)?.pid ?? null;

    // 同 start()：被 bootout 过的 unit 不在 domain 里，kickstart -k 一样找不到它。
    const loadErr = ensureLoaded(label, live);
    if (loadErr) return { ok: false, unit, label, oldPid, error: loadErr };
    const r = execLaunchctl(['kickstart', '-k', `gui/${uid}/${label}`]);
    if (!r || r.status !== 0) return { ok: false, unit, label, oldPid, error: launchctlErr(r) };
    if (!wait) return { ok: true, unit, label, action: 'restarted', oldPid };

    // 用轮询次数而不是墙钟截止：now 是可注入的（测试里恒定），拿它算 deadline 会死循环。
    const maxTries = Math.max(1, Math.ceil(timeoutMs / intervalMs));
    const port = positivePort((readEnv() || {}).PORT) ?? DEFAULT_PORT;
    for (let i = 0; i < maxTries; i += 1) {
      sleep(intervalMs);
      const pid = currentPid(label);
      if (pid && pid !== oldPid) {
        let proof = {};
        if (unit === 'server') {
          const listenPid = portListenerPid(port);
          if (listenPid && listenPid !== pid) {
            return { ok: false, unit, label, oldPid, newPid: pid, error: portConflictError({ port, listenPid }) };
          }
          if (listenPid !== pid) {
            if (!tcpProbe(port)) {
              return { ok: false, unit, label, oldPid, newPid: pid, error: `新进程已起（pid=${pid}）但端口 ${port} 连不上，看日志` };
            }
            // lsof 没认出是自己、只有 TCP 通 —— 与 start 同一条弱判据，同样要标出来。
            proof = { unverified: true, warning: unverifiedWarning(port) };
          }
        }
        return { ok: true, unit, label, action: 'restarted', oldPid, newPid: pid, ...proof };
      }
    }
    return { ok: false, unit, label, oldPid, error: `重启后未能确认新进程（超时 ${timeoutMs}ms）` };
  }

  // **唯一会碰 HTTP 鉴权层的路径**，因此规矩最严：任何非 200 都不重试。
  // app/src/server/http.js:94-105 对失败无条件计数 + app.js:309 让 loopback 也进限速
  // + rate-limiter 阈值 8 锁 15 分钟 ⇒ 一个会重试的健康检查能把用户连同手机一起关在门外。
  function health() {
    const env = readEnv() || {};
    const port = positivePort(env.PORT) ?? DEFAULT_PORT;
    const token = env.AUTH_TOKEN;
    const url = `http://127.0.0.1:${port}/health${token ? `?token=${encodeURIComponent(token)}` : ''}`;

    let res;
    try {
      res = httpGet(url);
    } catch (err) {
      return { ok: false, reason: 'unreachable', error: `连不上 127.0.0.1:${port}（服务没在跑？）：${String(err?.message || err).split('\n')[0]}` };
    }
    if (res?.status === 401) {
      // 把陷阱翻译成诊断：401 在本机几乎只有一个成因。
      return {
        ok: false,
        reason: 'auth-mismatch',
        error: '配置里的 AUTH_TOKEN 与正在跑的进程不一致 —— 该重启服务了。（已收到 401，不再重试：连续 8 次失败会把本机锁 15 分钟）',
      };
    }
    if (res?.status === 429) {
      return { ok: false, reason: 'rate-limited', error: '已被登录限速锁定（15 分钟）。等锁自然过期，别再重试。' };
    }
    if (res?.status !== 200) {
      return { ok: false, reason: 'bad-status', error: `/health 返回 ${res?.status}` };
    }
    let body = null;
    try {
      body = JSON.parse(res.body);
    } catch { /* 200 但不是 JSON：仍算通，只是没有细节 */ }
    return { ok: true, reason: 'ok', health: body };
  }

  return { status, install, adopt, uninstall, start, stop, restart, health };
}

function positivePort(value) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

// stopped 那一格该说什么。已知 unit 与自建 unit 共用同一套判据 —— 分成两处写，迟早分叉。
//
// loaded 三态各有各的说法：
//   true / null（不知道）→ 按调度形态说「待机 · 每天 03:47」，这是 99% 的正常态；
//   false                → 它已被 bootout，plist 还在、schedule 也照样解析得出，但永远不会
//                          再触发。这时说「待机」是在报一个反的事实。
// null 必须与 true 同待遇：launchctl list 读不到时全体 unit 都是 null，那是「不知道」，
// 不是「知道它们都被卸载了」—— 否则一次 list 失败会让每一行都撒一个具体的谎。
function idleOrStoppedText(schedule, loaded) {
  const idle = describeSchedule(schedule);
  if (loaded !== false) return idle;
  // describeSchedule 给的是「待机 · 每 30 秒触发」这种**完整短语**，整个嵌进去会语无伦次：
  // 「已停止（待机 · 每 30 秒触发不会触发）」既自相矛盾又重复。剥掉前缀，只留节奏本身。
  const rhythm = idle ? idle.replace(/^待机 · /, '') : null;
  return rhythm
    ? `已停止（原定${rhythm}，现在不会执行）；start 可重新加载`
    : '已从 launchd 卸载；start 可重新加载';
}

export function describeUnit({ state, restarts, lastExitAbnormal, drift, plistExists, ownership, schedule, loaded = null }) {
  if (!plistExists) return '未安装';
  const parts = [];
  // 周期 job / 打火即退任务的 stopped 是**健康待机**（99% 的时间都该如此），照 launchd 的说法
  // 写「已停止」会被读成故障。判据来自 plist 里的调度形态，见 service-units.extractSchedule。
  //
  // ★ 但「待机」的前提是 launchd 域里还有这个 job。被 bootout 之后 plist 照样躺在磁盘上、
  // 调度形态也照样读得出来，可它永远不会再触发了 —— 那不是待机，是停了。旧实现只看 schedule，
  // 于是停掉 logrotate 后面板恒显「待机 · 每天 03:47」，而日志轮转其实已经死了。
  if (state === 'stopped') {
    const word = idleOrStoppedText(schedule, loaded);
    if (word) parts.push(word);
  }
  // 只有**频繁**重启才算异常。单次的 lastExitAbnormal 不再当告警说 —— 用户自建的隧道 unit 恒为 -9
  // （看门狗按 DHCP 漂移每天 kickstart 一次），那样说等于每天误报。
  if (restarts?.flapping) parts.push(`1 小时内重启 ${restarts.lastHour} 次`);
  else if (restarts?.last24h > 0) parts.push(`24 小时内重启 ${restarts.last24h} 次`);
  else if (lastExitAbnormal && state === 'running') parts.push('上次非正常退出（已重新拉起）');
  // shape 漂移有两个来源，措辞必须分开，否则会把因果说反：
  //   · foreign（manifest 里没有）—— 用户自己写的启动方式（用户自建的隧道 unit 就是 /bin/bash
  //     ~/.cloudflared/xxx.sh，多半为绕过代理 TUN 劫持）。说「不接管」，不暗示出错。
  //   · managed（manifest 里有 ⇒ 这份 plist 是本工具渲染的）—— 用户什么都没改，是**产品自己
  //     升级后模板变了**，而已经落到 ~/Library/LaunchAgents 的那份不会跟着更新。
  //     2026-09-03 实证：运行时入口从 server.js 挪到 app/server.js 后，实测环境的 server unit
  //     直接起不来，而这里却告诉他「自定义启动方式」——他没有自定义过任何东西。
  if (drift.includes('shape')) {
    parts.push(ownership === 'managed'
      ? '启动方式与当前模板不一致：本工具装的，但盘上这份是旧模板渲染的（升级后没重装）——先 uninstall 再 install'
      : '自定义启动方式，本工具不接管（只可查看与启停）');
  }
  else if (drift.length) parts.push(`配置与模板不一致：${drift.join('、')}`);
  if (ownership === 'foreign' && !drift.includes('shape')) parts.push('手工装的，adopt 前不会被改写');
  if (state === 'crashed') parts.push('上次异常退出且当前未运行');
  return parts.join('；');
}

// ---------- 真实依赖（只有 CLI 路径会用到；测试全部注入 mock） ----------

// kickstart 会堵住 ThrottleInterval；list/bootout 必须保持短超时。
export function launchctlTimeoutMs(args) {
  return args?.[0] === 'kickstart' ? 25_000 : 5_000;
}

function realExecLaunchctl(args) {
  return spawnSync('launchctl', args, { encoding: 'utf8', timeout: launchctlTimeoutMs(args) });
}

// plutil 把 XML plist 归一化成 JSON。用它而不是手写 XML 解析：macOS 自带、能吃二进制 plist、
// 且抹平缩进/注释差异。注意它抹不平 shell 命令串**内部**的引号——那一层由 extractUnitFacts 处理。
function realReadPlistFile(path) {
  const r = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path], {
    encoding: 'utf8',
    timeout: 5000,
  });
  if (!r || r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

// 谁在听这个端口。-t 只打 pid。失败返回 null（看不清，不挡 kickstart）。
function realPortListenerPid(port) {
  const r = spawnSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
    encoding: 'utf8',
    timeout: 3000,
  });
  const first = String(r?.stdout || '').trim().split('\n')[0];
  const n = Number(first);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// 纯 TCP 握手：不发 HTTP 请求行 ⇒ express 不路由 ⇒ 不经过鉴权中间件 ⇒ 不计入限速失败。
// 这是轮询路径能安全高频跑的前提，见文件头注纪律 2。
function realTcpProbe(port) {
  const r = spawnSync('/usr/bin/nc', ['-z', '-G', '1', '127.0.0.1', String(port)], {
    encoding: 'utf8',
    timeout: 3000,
  });
  return !!r && r.status === 0;
}

// 「配置文件里写了什么」（不含 shell 覆盖）—— manifest 路径解析与 setup 信息展示都基于它。
// 走统一配置层：读错源的后果是菜单栏 app 显示默认端口 3000 与错误的 lanUrl，而那是用户判断
// 「服务到底起没起」的主要依据。
function realReadEnv() {
  return readConfigFileValues(ROOT).values;
}

// 解析不了（路径不存在、权限不足）就回落原值：两边都回落 ⇒ 仍能正确比较，
// 只有单边解析成功才会造成假漂移，而那种情况下报出来本来也是对的。
function realRealpath(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// 写进 plist 的 node 路径。process.execPath 是解析过 symlink 的真身
// （/opt/homebrew/Cellar/node/25.9.0_3/bin/node），写进去后 `brew upgrade node` 版本号一变
// 就指向不存在的二进制、服务再也起不来。登录 shell 的 `command -v node` 给的是稳定 symlink，
// 且与 plist 自身的 `zsh -lc` 启动方式同源（终端等价性）。
export function pickNodePath(loginShellOut, execPath, exists) {
  const first = String(loginShellOut || '').trim().split('\n')[0].trim();
  return first && exists(first) ? first : execPath;
}

// 只在写路径（install/adopt）调用 —— 起一个登录 shell 约 100ms，status 的高频轮询不该付这个成本
// （status 的漂移比对已有 realpath 归一，用 execPath 也能正确判等）。
function realLoginShellNode() {
  let out = '';
  try {
    out = String(spawnSync('/bin/zsh', ['-lc', 'command -v node'], { encoding: 'utf8', timeout: 5000 })?.stdout || '');
  } catch { /* 回落 execPath */ }
  return pickNodePath(out, process.execPath, existsSync);
}

// 同步 sleep。Node 没有原生的，Atomics.wait 是标准做法（不烧 CPU，精度足够）。
function realSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

// 同步 HTTP GET。用 curl 而非 node 子进程：少一次 node 冷启（~50ms），且 curl 是 macOS 自带。
// -w 把状态码追加到 body 末尾，靠最后一个换行切分。
function realHttpGet(url) {
  const r = spawnSync('/usr/bin/curl', ['-sS', '-m', '5', '-w', '\n%{http_code}', url], {
    encoding: 'utf8',
    timeout: 8000,
  });
  if (!r || r.status !== 0) throw new Error(String(r?.stderr || 'curl 失败').trim());
  const out = String(r.stdout || '');
  const idx = out.lastIndexOf('\n');
  if (idx < 0) throw new Error('curl 输出格式异常');
  return { status: Number.parseInt(out.slice(idx + 1), 10), body: out.slice(0, idx) };
}

// 只在确认交互里用一次。刻意不引 readline/promises 的 Interface：那东西在非 TTY 下的
// 行为是本仓踩过的坑（见 resolveUninstallConfirm 头注），这里的调用点已经先判过 isTTY。
function readLine() {
  return new Promise((resolve) => {
    process.stdin.setEncoding('utf8');
    const done = (value) => {
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      resolve(value);
    };
    const onData = (d) => done(String(d));
    // EOF（Ctrl-D）必须也 settle —— 只监听 'data' 的话 promise 永不完成，进程静默 exit 0，
    // 而包装脚本会把「静默 0」读成成功。这正是 scripts/setup.js:10-14 记过的那个坑。
    const onEnd = () => done('');
    process.stdin.once('data', onData);
    process.stdin.once('end', onEnd);
    process.stdin.resume();
  });
}

function realLanIp() {
  for (const list of Object.values(networkInterfaces() || {})) {
    for (const ni of list || []) {
      if (ni && ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return null;
}

function realListAgentLabels(home) {
  try {
    return readdirSync(join(home, ...AGENTS_SUBPATH))
      .filter((f) => f.endsWith('.plist'))
      .map((f) => f.slice(0, -'.plist'.length));
  } catch {
    return [];
  }
}

// manifest 必须与 server / doctor 落在同一个数据目录。
//
// 坑：本文件是独立 CLI，**不走 app/server.js 的 loadRuntimeEnvironment**，所以只读 process.env
// 会漏掉 .env 里的 CCM_DATA_DIR —— manifest 写进仓库 data/，而生产状态在
// ~/Library/Application Support/… 下，两边永远对不上，adopt 完下次 status 又变回 adoptable。
// 优先级与 dotenv 的「不覆盖已有 env」语义一致：shell > .env > 默认。空串按未设置处理
// （同 app/src/ops/config.js 的 normalizeLoadedEnvironment 与 app/src/shared/data-dir.js:17）。
export function resolveManifestPath(shellEnv = process.env, fileEnv = {}, root = ROOT) {
  const dir = shellEnv?.CCM_DATA_DIR || fileEnv?.CCM_DATA_DIR || join(root, 'data');
  return join(dir, 'service-install.json');
}

function realManifestPath() {
  return resolveManifestPath(process.env, realReadEnv(), ROOT);
}

export function resolveEventsPath(shellEnv = process.env, fileEnv = {}, root = ROOT) {
  const dir = shellEnv?.CCM_DATA_DIR || fileEnv?.CCM_DATA_DIR || join(root, 'data');
  return join(dir, 'service-events.json');
}

function realReadEvents() {
  try {
    return JSON.parse(readFileSync(resolveEventsPath(process.env, realReadEnv(), ROOT), 'utf8'));
  } catch {
    return [];
  }
}

function realReadManifest() {
  try {
    return JSON.parse(readFileSync(realManifestPath(), 'utf8'));
  } catch {
    return null;
  }
}

// manifest 记着「哪些 unit 是我们装的」，是全部写操作的授权凭据 —— 0600，用与 sessions/devices
// 同一个原子写（唯一 tmp + fsync + rename + 二次 chmod 确认）。
function realWriteManifest(manifest) {
  const path = realManifestPath();
  mkdirSync(dirname(path), { recursive: true });
  writeOwnerOnlyFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

function realReadFileRaw(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function realWriteFile(path, content) {
  mkdirSync(dirname(path), { recursive: true }); // 新机器可能还没有 ~/Library/LaunchAgents
  writeFileSync(path, content);
}

function realDeleteFile(path) {
  try {
    // safe-path: 调用方（uninstall）传的是**派生路径** plistPathFor(labelFor(unit))，unit 已过
    // guardUnit 的 SERVICE_UNIT_NAMES 白名单、home 来自 os.homedir()（见 scripts/service.js 的
    // `deleteFile(target)` 调用点）。**刻意不用 manifest 里的 entry.plistPath** —— 那是磁盘 JSON，
    // 被篡改后能指向任意文件，而 validateManifest 只校验它是非空字符串、不校验位置。
    // 算错的最坏情况是指向一个不存在的 plist，打不到别的目录 ——
    // 与 2026-08-02「目录段塌成真实根」的事故形态不同。
    //
    // （这条理由本身在 2026-08-14 被改正过一次：上一版写的是「只传 manifest 里自己写下的
    // plistPath」，那描述的恰是被 8c9785a 废弃掉的设计。门禁只正则匹配 `// safe-path:` 不校验
    // 理由文本，所以过期的理由能一直绿着 —— 读到这类标记时要回调用点核对，别只信注释。）
    unlinkSync(path);
  } catch { /* 文件已不在就是我们要的终态 */ }
}

export function realManager() {
  const home = homedir();
  return createServiceManager({
    platform: currentPlatform(),
    home,
    repo: ROOT,
    node: process.execPath,
    execLaunchctl: realExecLaunchctl,
    readPlistFile: realReadPlistFile,
    readManifest: realReadManifest,
    readEnv: realReadEnv,
    // 「配置过没有」而不是「.env 在不在」：新装用户的配置在 ccm.config.json 里，
    // 只判旧文件会让菜单栏 app 对着一台配好的服务显示「尚未配置」。
    envFileExists: () => existsSync(join(ROOT, CONFIG_FILE_NAME)) || existsSync(join(ROOT, '.env')),
    tcpProbe: realTcpProbe,
    portListenerPid: realPortListenerPid,
    lanIp: realLanIp,
    listAgentLabels: () => realListAgentLabels(home),
    realpath: realRealpath,
    readFileRaw: realReadFileRaw,
    writeFile: realWriteFile,
    deleteFile: realDeleteFile,
    fileExists: existsSync,
    writeManifest: realWriteManifest,
    renderPlist: realRenderPlist,
    readEvents: realReadEvents,
  });
}

// ---------- 人类可读渲染 ----------

// 「多久以前」的粗粒度人话。UI 要的是量级不是精度。
export function formatAgo(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const m = Math.floor(ms / 60_000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时`;
  return `${Math.floor(h / 24)} 天`;
}

const STATE_ICON = {
  running: '●',
  idle: '◌',
  stopped: '○',
  crashed: '✗',
  'not-installed': '·',
};

// stopped 分两种，面板必须用两个词：常驻服务停了是故障，周期 job / 打火即退任务停着是
// 健康待机。混用一个词的后果实测过——5 个 unit 里 3 个健康的被标 stopped，用户本人来问
// 「tunnel-watch 要启用吗」。**只改呈现，不改 state 字段**：JSON 契约仍是 launchd 的四个取值，
// 消费方（desktop）拿 schedule 自己判，判据与呈现分开。
function stateWord(u) {
  // loaded===false 时不许说 idle：那个词的意思是「装着、等着、到点会响」，而它已经不会响了。
  if (u.loaded === false) return u.state;
  return u.state === 'stopped' && describeSchedule(u.schedule) ? 'idle' : u.state;
}

const OWNERSHIP_LABEL = {
  managed: '本仓管理',
  adoptable: '可接管',
  foreign: '手工配置',
  unknown: '非本仓',
};

export function formatStatus(s) {
  const lines = [];
  const now = s.generatedAt || Date.now();
  lines.push('=== 服务状态 ===');
  lines.push('');
  if (!s.supported) {
    lines.push(...s.warnings);
    lines.push('');
    return lines.join('\n');
  }
  for (const u of s.units) {
    const word = stateWord(u);
    const icon = u.flapping ? '◐' : (STATE_ICON[word] || '?');
    const restartNote = u.restarts?.lastRestartAt ? `  上次重启 ${formatAgo(now - u.restarts.lastRestartAt)}前` : '';
    const pid = u.pid ? ` pid=${u.pid}` : '';
    lines.push(`${icon} ${u.label}  ${word}${pid}  [${OWNERSHIP_LABEL[u.ownership] || u.ownership}]${restartNote}`);
    if (u.detail) lines.push(`    ${u.detail}`);
    if (u.listen) lines.push(`    端口 ${u.listen.port} ${u.listen.reachable ? '可连接' : '连不上'}`);
  }
  if (!s.units.length) lines.push('（未发现任何 com.ccm.* unit）');
  for (const w of s.warnings) lines.push(`⚠ ${w}`);
  lines.push('');
  return lines.join('\n');
}

// ---------- CLI ----------

const USAGE = [
  'usage:',
  '  service.js status [--json] [--fast]',
  '  service.js install <unit> [--tunnel=<名字>] [--cloudflared=<路径>] [--json]',
  '  service.js adopt <unit> [--json]                 # 只写 manifest，不动 plist',
  '  service.js uninstall <unit> --yes [--force] [--json]   # 默认拒绝，须显式确认',
  '  service.js start|stop <unit> [--json]',
  '  service.js restart <unit> [--wait] [--json]',
  '  service.js logs [unit] [--lines=N] [--follow]',
  '  service.js health [--json]                       # 唯一会打 /health 的命令',
  '  service.js copy-token                            # 复制到剪贴板，不打印',
  '',
  `unit: ${SERVICE_UNIT_NAMES.join(' | ')}（启停也接受本机自建的 com.ccm.* 后缀名）`,
].join('\n');

const WRITE_ACTIONS = new Set(['install', 'adopt', 'uninstall']);

// 「这次卸载算不算得到确认」。纯判定，IO 由调用方给。
//   --yes            → 确认
//   交互终端         → 问一句，只有恰好答 y/yes 才算
//   非交互且无 --yes → **拒绝**（不是静默通过）
// 非 TTY 必须显式拒绝而不是回落到 readline：scripts/setup.js:10-14 记过那个坑 ——
// agent shell 里 stdin 立刻 EOF，readline 的 promise 永不 settle，进程静默退出 0。
export function resolveUninstallConfirm({ yes = false, isTty = false, answer = null }) {
  if (yes) return { confirmed: true, reason: 'flag' };
  if (!isTty) return { confirmed: false, reason: 'non-interactive' };
  const a = String(answer ?? '').trim().toLowerCase();
  return { confirmed: a === 'y' || a === 'yes', reason: 'answer' };
}
const CONTROL_ACTIONS = new Set(['start', 'stop', 'restart']);

// 日志路径以 plist 里的 StandardOutPath 为准（用户可能改过），读不到再回落默认约定。
function resolveLogPath(unit, home) {
  const plist = realReadPlistFile(join(home, 'Library', 'LaunchAgents', `${labelFor(unit)}.plist`));
  return plist?.StandardOutPath || join(home, 'Library', 'Logs', `ccm-${unit}.log`);
}

function runLogs(unit, opts, flags) {
  const home = homedir();
  const path = resolveLogPath(unit || 'server', home);
  if (!existsSync(path)) {
    process.stderr.write(`日志文件不存在：${path}\n`);
    process.exitCode = 1;
    return;
  }
  const lines = String(opts.lines || '200');
  const args = flags.follow ? ['-n', lines, '-F', path] : ['-n', lines, path];
  spawnSync('/usr/bin/tail', args, { stdio: 'inherit' });
}

// token 经 pbcopy 直送剪贴板，**绝不打印到 stdout**：菜单栏 app 会 spawn 这个命令，
// 打印出来等于让明文流进另一个进程的内存和可能的日志。
function runCopyToken() {
  const token = realReadEnv().AUTH_TOKEN;
  if (!token) {
    process.stderr.write('未设置 AUTH_TOKEN（配置文件里没有）\n');
    process.exitCode = 1;
    return;
  }
  const r = spawnSync('/usr/bin/pbcopy', [], { input: token, timeout: 5000 });
  if (!r || r.status !== 0) {
    process.stderr.write('复制失败（pbcopy 不可用？）\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`✓ AUTH_TOKEN 已复制到剪贴板（${token.length} 字符，未打印）\n`);
}

export function parseArgs(rest) {
  const flags = { json: false, fast: false, force: false, wait: false, follow: false, yes: false };
  const opts = {};
  const positional = [];
  for (const a of rest) {
    if (a === '--json') flags.json = true;
    else if (a === '--fast') flags.fast = true;
    else if (a === '--force') flags.force = true;
    else if (a === '--yes' || a === '-y') flags.yes = true;
    else if (a === '--wait') flags.wait = true;
    else if (a === '--follow' || a === '-f') flags.follow = true;
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) opts[a.slice(2, eq)] = a.slice(eq + 1);
    } else positional.push(a);
  }
  return { flags, opts, positional };
}

export async function main(argv) {
  const [action, ...rest] = argv;
  if (!action) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 64;
    return;
  }
  const { flags, opts, positional } = parseArgs(rest);

  if (action === 'status') {
    const s = realManager().status({ fast: flags.fast });
    process.stdout.write(flags.json ? `${JSON.stringify(s)}\n` : formatStatus(s));
    return;
  }

  if (action === 'logs') return runLogs(positional[0], opts, flags);
  if (action === 'copy-token') return runCopyToken();

  if (action === 'health') {
    const r = realManager().health();
    if (flags.json) process.stdout.write(`${JSON.stringify(r)}\n`);
    else if (r.ok) process.stdout.write(`✓ 服务健康（sdk ${r.health?.versions?.sdk ?? '?'} / cli ${r.health?.versions?.cli ?? '?'}）\n`);
    else process.stderr.write(`✗ ${r.error}\n`);
    process.exitCode = r.ok ? 0 : 1;
    return;
  }

  if (CONTROL_ACTIONS.has(action)) {
    const unit = positional[0];
    if (!unit) {
      process.stderr.write(`${USAGE}\n`);
      process.exitCode = 64;
      return;
    }
    const r = realManager()[action](unit, { wait: flags.wait });
    if (flags.json) {
      process.stdout.write(`${JSON.stringify(r)}\n`);
    } else {
      const { stdout, stderr } = formatControlResult(r);
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
    }
    process.exitCode = r.ok ? 0 : 1;
    return;
  }

  if (WRITE_ACTIONS.has(action)) {
    const unit = positional[0];
    if (!unit) {
      process.stderr.write(`${USAGE}\n`);
      process.exitCode = 64;
      return;
    }
    let confirmed = true;
    if (action === 'uninstall') {
      const isTty = !!process.stdin.isTTY;
      let answer = null;
      if (!flags.yes && isTty) {
        const label = `${DEFAULT_LABEL_PREFIX}.${unit}`;
        process.stdout.write(`即将停止 ${label} 并删除它的 plist。确认请输入 y： `);
        answer = await readLine();
      }
      const verdict = resolveUninstallConfirm({ yes: flags.yes, isTty, answer });
      confirmed = verdict.confirmed;
    }
    // 写路径才解析登录 shell 的 node（见 pickNodePath 头注）；status 不付这个成本。
    const r = realManager()[action](unit, { node: realLoginShellNode(), ...opts, force: flags.force, confirmed });
    if (flags.json) {
      process.stdout.write(`${JSON.stringify(r)}\n`);
    } else if (r.ok) {
      process.stdout.write(`✓ ${r.label || unit} ${ACTION_TEXT[r.action] || r.action}\n`);
    } else {
      process.stderr.write(`✗ ${r.error}\n`);
    }
    process.exitCode = r.ok ? 0 : 1;
    return;
  }

  process.stderr.write(`${USAGE}\n`);
  process.exitCode = 64;
}

const ACTION_TEXT = {
  started: '已启动',
  stopped: '已停止',
  restarted: '已重启',
  installed: '已安装并加载',
  recovered: '已修复安装（plist 缺失，已按 manifest 重建）',
  already: '已是目标状态，无需改动',
  adopted: '已接管（只写了 manifest，plist 原样未动）',
  uninstalled: '已卸载并删除 plist',
};

// start/stop/restart 的人类可读呈现。抽成纯函数是为了让 `unverified`（成功了、但判据弱）
// 这个分支有人看着 —— 这些动作会真碰 launchctl，端到端 spawn 测不了，而 manager 标了、
// CLI 不打印就等于没标。⚠ 走 stderr 而非 stdout：退出码仍是 0，它是附注不是失败。
export function formatControlResult(r) {
  if (!r.ok) return { stdout: '', stderr: `✗ ${r.error}\n` };
  const pidNote = r.newPid ? `（pid ${r.oldPid ?? '?'} → ${r.newPid}）` : '';
  // 「它本来就没在跑」和「我刚把它停了」是两件事，别渲染成同一句。弱判据要出现在人眼前，
  // 只留在 --json 里等于没说 —— 尤其这一条常常意味着「上次它就已经被 bootout 了而你不知道」。
  const weak = r.alreadyStopped ? '（本来就没在跑）' : '';
  return {
    stdout: `✓ ${r.label} ${ACTION_TEXT[r.action] || r.action}${weak}${pidNote}\n`,
    stderr: r.warning ? `⚠ ${r.warning}\n` : '',
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2));
}
