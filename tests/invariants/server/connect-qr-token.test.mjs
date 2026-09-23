// tests/invariants/server/connect-qr-token.test.mjs —— 含令牌的接入二维码只发给握手时出示过令牌的会话
// 守护：AUTH-05（AUTH_TOKEN 不得经服务端输出流到不持有它的会话：connect:qr 只给握手时出示过令牌的会话出含令牌的码）
// 测什么：真起 server 并启用 CF Access（本地签一把 RS256，公钥预置进 cf-access-certs.json 缓存），
//         同一台 server 上：
//           · 经 Access JWT 进来的会话要局域网码 → 必须被拒，回执里任何地方都不得出现令牌；
//             同一条用例里先让用令牌握手的会话要一次局域网码并拿到（正向对照：证明这台环境做得出
//             局域网码，拒绝不是「取不到局域网地址」那种顺带的失败）。
//           · Access 会话要公网码 → 照常拿到不含令牌的码（证明 Access 会话的事件真的到了 handler）。
// 槽位：S2（真 app/server.js 子进程 + 一次性 HOME/CCM_DATA_DIR）
//
// 【缺陷的真实形态】2026-09-22 review P1。前端「显示二维码」只会请求 target:'lan'，而 lan 档无条件
//   把 AUTH_TOKEN 拼进 URL。经 Cloudflare Access 进来的会话握手时没出示过令牌（公网那条路只认 JWT），
//   设备审批默认也 bypass——点一下就拿到了局域网钥匙，Access 吊销之后照样能从局域网进来。
//   与横幅掩码、logs:server 脱敏是同一条泄露路径的第三个出口（见 banner-secrets.test.mjs 头注）。
//
// 【JWKS 为什么能离线】cf-access.js 在 initCfAccess 时同步读 CCM_DATA_DIR/cf-access-certs.json，
//   验签只用这份本地缓存。team 用 `.invalid` 保留域（RFC 6761 保证不可解析）：启动时那次后台拉取
//   必然失败、本地缓存原样保留；换成一个可能真实存在的 team，拉到的真证书会覆盖掉预置的公钥。
//
// 不测什么 + 为什么：
//  ① 验签本身（issuer / audience / 过期 / 乱码）—— 归 tests/unit/cf-access.test.mjs 与
//     tests/integration/cf-access-gate.test.mjs。
//  ② 前端怎么展示这条拒绝 —— 前端把 error 原样打成一条提示，回执形状（ok:false + error）是既有分支，
//     由 integration/server.test.mjs 的 ACK_SHAPES 守着。

// 执行位守卫：必须是第一条 import（它一旦放行晚了，下面那些模块的顶层代码已经跑过了）。
import '../../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { spawnServer, killServer } from '../../integration/_spawn-server.mjs';

const PUBLIC_HOST = 'ccm.example.com';
const TEAM_DOMAIN = 'ccm-test.invalid';
const AUD = 'ccm-test-aud';
const KID = 'ccm-test-k1';
// 32 字节 hex，与 scripts/config.js 的 generateToken() 同形态同长度。
const TOKEN = 'c3d4e5f6'.repeat(8);

test.describe('AUTH-05: connect:qr 只给出示过令牌的会话出含令牌的码', () => {
  let home, dataDir, workdir, server, accessJwt;

  test.before(async () => {
    home = mkdtempSync(join(tmpdir(), 'ccm-inv-qr-home-'));
    dataDir = mkdtempSync(join(tmpdir(), 'ccm-inv-qr-data-'));
    workdir = mkdtempSync(join(tmpdir(), 'ccm-inv-qr-wd-'));

    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: KID, alg: 'RS256', use: 'sig' };
    writeFileSync(join(dataDir, 'cf-access-certs.json'), JSON.stringify({ keys: [jwk] }));
    accessJwt = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(`https://${TEAM_DOMAIN}`)
      .setAudience(AUD)
      .setSubject('ccm-test-user')
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(privateKey);

    server = await spawnServer({
      AUTH_TOKEN: TOKEN, HOME: home, CCM_DATA_DIR: dataDir, WORK_DIRS: workdir,
      CF_ACCESS_HOSTNAME: PUBLIC_HOST, CF_ACCESS_TEAM: TEAM_DOMAIN, CF_ACCESS_AUD: AUD,
    });
  });
  test.after(async () => {
    if (server) await killServer(server.proc);
    // safe-rm: 三处都是本文件 mkdtemp 出来的一次性目录
    for (const d of [home, dataDir, workdir]) if (d) rmSync(d, { recursive: true, force: true });
  });

  // 浏览器经隧道进来时的形态：Host 是公网域名、Origin 同源、边缘注入 JWT 头，不带 AUTH_TOKEN。
  const viaAccess = () => ({
    extraHeaders: { host: PUBLIC_HOST, origin: `https://${PUBLIC_HOST}`, 'cf-access-jwt-assertion': accessJwt },
  });
  const viaToken = () => ({ auth: { token: TOKEN } });
  // 失败信息里不展开 matrix（37×37 的 0/1 会把真正要看的 url 淹掉）
  const brief = r => JSON.stringify(r?.matrix ? { ...r, matrix: '…' } : r);

  // 连上、发一条 connect:qr、拿回执。握手失败与回执超时都直接抛——
  // 「没拿到回执」绝不能被当成「被拒绝了」（设备未批准时事件被丢弃，表现就是超时）。
  const requestQr = (clientOpts, target) => new Promise((resolve, reject) => {
    const sock = ioClient(`http://127.0.0.1:${server.port}`, {
      transports: ['websocket'], reconnection: false, timeout: 4000, ...clientOpts,
    });
    let timer = null;
    const done = (fn, v) => { clearTimeout(timer); try { sock.close(); } catch { /* 已关闭 */ } fn(v); };
    timer = setTimeout(() => done(reject, new Error(`connect:qr(${target}) 超时：事件没到 handler`)), 8000);
    sock.on('connect', () => sock.emit('connect:qr', { target }, r => done(resolve, r)));
    sock.on('connect_error', e => done(reject, new Error(`握手失败：${e?.message}`)));
  });

  test('Access 会话要局域网码 → 拒绝，回执里不得出现令牌（同用例内先做令牌会话的正向对照）', async () => {
    const control = await requestQr(viaToken(), 'lan');
    assert.equal(control?.ok, true,
      `正向对照失败：用令牌握手的会话也拿不到局域网码，下面的「拒绝」会假绿。回执：${brief(control)}`);
    assert.ok(control.url.includes(`#token=${TOKEN}`),
      `正向对照的局域网码里应带令牌：${control.url}`);

    const r = await requestQr(viaAccess(), 'lan');
    assert.ok(!JSON.stringify(r).includes(TOKEN),
      `AUTH_TOKEN 经二维码回执流到了握手时没出示过它的 Access 会话：${brief(r)}`);
    assert.equal(r.ok, false, `应明确拒绝，而不是回一张不含令牌、扫开进不去的码：${brief(r)}`);
    assert.equal(typeof r.error, 'string', `拒绝要带给用户看的原因：${brief(r)}`);
  });

  // 判据是「握手时出示过令牌」，不是「走的哪条鉴权路」：公网 Host 只认 JWT，但浏览器照样可能带着正确的
  // 令牌（Access 启用前就存过、或打开过手动的 #token= 链接）。它本来就持有令牌，拒绝它只是误伤。
  test('Access 会话同时带着正确令牌 → 照常拿到局域网码', async () => {
    const r = await requestQr({ ...viaAccess(), auth: { token: TOKEN } }, 'lan');
    assert.equal(r?.ok, true, `出示过令牌的会话不该被拒：${brief(r)}`);
    assert.ok(r.url.includes(`#token=${TOKEN}`), `局域网码里应带令牌：${r.url}`);
  });

  test('Access 会话要公网码 → 照常拿到不含令牌的码', async () => {
    const r = await requestQr(viaAccess(), 'public');
    assert.equal(r?.ok, true, `Access 会话的公网码不该受影响：${brief(r)}`);
    assert.equal(r.includeToken, false);
    assert.equal(r.url, `https://${PUBLIC_HOST}`);
    assert.ok(!JSON.stringify(r).includes(TOKEN), `公网码回执里不得出现令牌：${brief(r)}`);
  });
});
