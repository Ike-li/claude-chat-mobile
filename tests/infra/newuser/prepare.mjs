// tests/infra/newuser/prepare.mjs —— 生成「新用户内网电脑」容器要用的运行产物（宿主机侧，仓库根执行）。
//
//   node tests/infra/newuser/prepare.mjs <运行目录> <宿主机 LAN IP> [git ref=HEAD]
//
// 产物全部落在 <运行目录>（放仓库外，含中转凭据副本）：
//   claude-chat-mobile.tar.gz  与 scripts/release.sh 同一套裁剪（git archive + dist-manifest 改写 package.json），
//                              只是打的是当前分支而不是 tag——要验的就是还没发版的改动
//   settings.json              .claude/settings.docker.json 的副本，ANTHROPIC_BASE_URL 的 127.0.0.1 改成 host.docker.internal
//   cf/{jwks.json,cf.env,edge.conf}  假 Cloudflare 边缘：一次性 RS256 密钥、JWKS、7 天有效的 Access JWT
//   compose.env                docker compose --env-file 用
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose';
import { packDistTarball } from '../../../scripts/dist-manifest.js';

const [runDirArg, hostIp, refArg = 'HEAD'] = process.argv.slice(2);
if (!runDirArg || !hostIp) {
  console.error('用法: node tests/infra/newuser/prepare.mjs <运行目录> <宿主机 LAN IP> [git ref | worktree]');
  process.exit(2);
}
const REPO = resolve(import.meta.dirname, '..', '..', '..');
// `worktree` = 打当前工作树（含未提交修改）：git archive 只认树对象，`git stash create` 把工作树做成一个
// 悬空提交对象、不动 stash 列表；没有改动时返回空，退回 HEAD。export-ignore 从该树自己的 .gitattributes 读。
const ref = refArg === 'worktree'
  ? (execFileSync('git', ['stash', 'create'], { cwd: REPO, encoding: 'utf8' }).trim() || 'HEAD')
  : refArg;
const runDir = resolve(runDirArg);
if (runDir.startsWith(REPO + '/')) {
  console.error('运行目录不能在仓库树内（产物含中转凭据）');
  process.exit(2);
}
mkdirSync(join(runDir, 'cf'), { recursive: true });

// 1. 分发 tarball（步骤照抄 release.sh 的「生成分发包」段）
const version = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
const stageRoot = mkdtempSync(join(runDir, 'stage-'));
const stage = join(stageRoot, `claude-chat-mobile-${version}`);
mkdirSync(stage);
const archive = execFileSync('git', ['archive', '--format=tar', ref], { cwd: REPO, maxBuffer: 256 * 1024 * 1024 });
execFileSync('tar', ['x', '-C', stage], { input: archive });
execFileSync(process.execPath, [join(REPO, 'scripts/dist-manifest.js'), '--rewrite-package', stage], { cwd: REPO, stdio: 'inherit' });
const tarball = join(runDir, 'claude-chat-mobile.tar.gz');
// 与 release.sh 同一条打包路（AppleDouble / xattr 的处理都在那一个函数里）。
packDistTarball({ stageRoot, dirName: `claude-chat-mobile-${version}`, out: tarball });

// 2. claude CLI 凭据副本：容器里 127.0.0.1 是它自己，中转在宿主机
const settings = JSON.parse(readFileSync(join(REPO, '.claude/settings.docker.json'), 'utf8'));
const base = settings.env?.ANTHROPIC_BASE_URL || '';
settings.env.ANTHROPIC_BASE_URL = base.replace(/\/\/(127\.0\.0\.1|localhost)(?=[:/]|$)/, '//host.docker.internal');
const settingsOut = join(runDir, 'settings.json');
writeFileSync(settingsOut, JSON.stringify(settings, null, 2) + '\n');
chmodSync(settingsOut, 0o600);

// 3. 假 Cloudflare 边缘：JWKS + JWT。CCM 只校 issuer + audience + exp（cf-access.js verifyAccessJwt），
//    issuer 由 CF_ACCESS_TEAM 推出（含点号 ⇒ 当整域名用），kid 必须在 JWKS 里能找到。
const CF_ACCESS_TEAM = 'fake-edge.test';
const CF_ACCESS_HOSTNAME = 'ccm.fake-edge.test';
const CF_ACCESS_AUD = randomBytes(32).toString('hex');
const issuer = `https://${CF_ACCESS_TEAM}`;
const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
const jwk = await exportJWK(publicKey);
jwk.kid = await calculateJwkThumbprint(jwk);
jwk.alg = 'RS256';
jwk.use = 'sig';
writeFileSync(join(runDir, 'cf/jwks.json'), JSON.stringify({ keys: [jwk], public_cert: {}, public_certs: [] }, null, 2) + '\n');
const jwt = await new SignJWT({ email: 'newuser@example.test', type: 'app', identity_nonce: randomUUID().slice(0, 8), country: 'XX' })
  .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
  .setIssuer(issuer)
  .setAudience(CF_ACCESS_AUD)
  .setSubject(randomUUID())
  .setIssuedAt()
  .setExpirationTime('7d')
  .sign(privateKey);
writeFileSync(join(runDir, 'cf/cf.env'),
  `CF_ACCESS_HOSTNAME=${CF_ACCESS_HOSTNAME}\nCF_ACCESS_TEAM=${CF_ACCESS_TEAM}\nCF_ACCESS_AUD=${CF_ACCESS_AUD}\n`);
const template = readFileSync(join(import.meta.dirname, 'edge.conf.template'), 'utf8');
writeFileSync(join(runDir, 'cf/edge.conf'), template.replaceAll('__HOSTNAME__', CF_ACCESS_HOSTNAME).replaceAll('__JWT__', jwt));

// 4. compose 环境
writeFileSync(join(runDir, 'compose.env'), `NEWUSER_RUN_DIR=${runDir}\nNEWUSER_HOST_IP=${hostIp}\n`);

console.log(`运行目录: ${runDir}
tarball:  ${tarball}（${ref}，v${version}）
ANTHROPIC_BASE_URL → ${settings.env.ANTHROPIC_BASE_URL}
假边缘:   Host=${CF_ACCESS_HOSTNAME} issuer=${issuer} kid=${jwk.kid.slice(0, 12)}…

docker compose -f tests/infra/newuser/docker-compose.yml --env-file ${join(runDir, 'compose.env')} --profile lan --profile direct --profile proxy --profile cf up --build -d`);
