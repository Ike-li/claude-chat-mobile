// tests/invariants/file-tickets.test.mjs —— /f/:ticket 的票据、内联白名单与路由判据
// 守护：FILE-04（用户文件不得以可执行形态同源内联）、SCOPE-01（取文件时按当下的范围根重走门禁）
// 测什么：票据伪造、过期、淘汰；内联白名单；公网 Host 无身份拒绝；吊销设备、收窄范围后票据立即失效；Range 语义与响应头
// 不测什么 + 为什么：① socket 签发链路、未审批设备、全局 compression 与安全头的真实组合属 S2（server/file-ticket-route.test.mjs）② 手机上播放、拖动、下载属真机项
// 槽位：S1（一次性目录真 fs + 进程内 express；只有外部 IdP 是假的，时间走注入）
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, realpathSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import express from 'express';
import { NULL_AUTH_STRATEGY } from '../../app/src/auth/auth-strategy.js';
import { createFileTickets, inlineTypeOf } from '../../app/src/files/file-tickets.js';
import { registerFileTicketRoute } from '../../app/src/server/file-ticket-route.js';

const TEN_MINUTES = 10 * 60 * 1000;

test.describe('票据', () => {
  const entry = { cwd: '/w', relPath: 'a.mp4', name: 'a.mp4', deviceToken: null };

  test('签发后能查到原始记录，没签发过的查不到', () => {
    const tickets = createFileTickets();
    const ticket = tickets.issue(entry);
    assert.deepEqual(
      { cwd: tickets.lookup(ticket).cwd, relPath: tickets.lookup(ticket).relPath },
      { cwd: '/w', relPath: 'a.mp4' },
      '票据换不回文件坐标，链接就打不开',
    );
    assert.equal(tickets.lookup('forged'), null, '伪造的票据换到了文件，等于无鉴权端点');
  });

  test('满 30 分钟作废，到点前仍可用', () => {
    let now = 0;
    const tickets = createFileTickets({ now: () => now });
    const ticket = tickets.issue(entry);
    now = 3 * TEN_MINUTES - 1;
    assert.ok(tickets.lookup(ticket), '不满 30 分钟就失效，看到一半的视频拖动会断');
    now = 3 * TEN_MINUTES;
    assert.equal(tickets.lookup(ticket), null, '过期票据还能用，泄露的 URL 就永久有效');
  });

  test('超过 200 张时淘汰最老的，最新的不受影响', () => {
    const tickets = createFileTickets();
    const issued = Array.from({ length: 201 }, () => tickets.issue(entry));
    assert.equal(tickets.lookup(issued[0]), null, '没有淘汰，反复点链接会让内存无限增长');
    assert.ok(tickets.lookup(issued[1]), '淘汰多了，刚拿到的票据也会失效');
    assert.ok(tickets.lookup(issued[200]), '最新的票据必须可用');
  });

  test('票据是 256 位随机数，不可枚举', () => {
    const tickets = createFileTickets();
    const [a, b] = [tickets.issue(entry), tickets.issue(entry)];
    assert.match(a, /^[\w-]{43}$/, '票据短于 256 位，路由又不进限速桶，就有暴破的可能');
    assert.notEqual(a, b, '票据可预测时，别的设备能猜到文件 URL');
  });
});

test.describe('FILE-04：内联白名单', () => {
  test('能带脚本或不在预览范围内的类型一律不内联', () => {
    for (const name of ['a.html', 'a.htm', 'a.xhtml', 'a.svg', 'a.xml', 'a.pdf', 'a.js', 'a.mjs', 'a.css', 'a.txt', 'Makefile', '.png', 'a.png.html']) {
      assert.equal(inlineTypeOf(name), null, `${name} 被内联，模型写的文件就能以 CCM 的源运行，读走令牌`);
    }
  });

  test('位图和音视频内联，扩展名不分大小写', () => {
    const cases = {
      'a.png': ['image/png', 'image'],
      'a.JPG': ['image/jpeg', 'image'],
      'a.jpeg': ['image/jpeg', 'image'],
      'a.gif': ['image/gif', 'image'],
      'a.webp': ['image/webp', 'image'],
      'a.mp4': ['video/mp4', 'video'],
      'a.m4v': ['video/mp4', 'video'],
      'a.webm': ['video/webm', 'video'],
      'a.mov': ['video/quicktime', 'video'],
      'a.mp3': ['audio/mpeg', 'audio'],
      'a.m4a': ['audio/mp4', 'audio'],
      'a.aac': ['audio/aac', 'audio'],
      'a.wav': ['audio/wav', 'audio'],
      'a.ogg': ['audio/ogg', 'audio'],
      'a.opus': ['audio/ogg', 'audio'],
      'a.flac': ['audio/flac', 'audio'],
      // 类型取自末段扩展名，配合 nosniff，内容写成 html 也只会被当图片解码
      'a.html.png': ['image/png', 'image'],
    };
    for (const [name, [mime, media]] of Object.entries(cases)) {
      assert.deepEqual(inlineTypeOf(name), { mime, media }, `${name} 放不出来，手机上只能下载`);
    }
  });
});

test.describe('GET /f/:ticket', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-inv-file-ticket-')));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-inv-file-ticket-outside-')));
  const CLIP = '0123456789';
  const SECRET = 'outside-secret';
  writeFileSync(join(root, 'clip.mp4'), CLIP);
  writeFileSync(join(outside, 'secret.mp4'), SECRET);
  mkdirSync(join(root, 'dir'));

  const servers = [];
  test.after(() => {
    for (const server of servers) server.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  async function serve(overrides = {}) {
    const tickets = createFileTickets();
    const app = express();
    registerFileTicketRoute({
      app,
      tickets,
      strategy: NULL_AUTH_STRATEGY,
      isDeviceTrusted: () => false,
      scopeRootsFor: () => [root],
      ...overrides,
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    servers.push(server);
    const issue = (relPath, deviceToken = null) => tickets.issue({ cwd: root, relPath, name: basename(relPath), deviceToken });
    return { port: server.address().port, issue };
  }

  function get(port, path, headers = {}, method = 'GET') {
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method, headers }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  test('票据不对：404，拿不到字节', async () => {
    const { port, issue } = await serve();
    assert.equal((await get(port, `/f/${issue('clip.mp4')}`)).status, 200, '正对照：真票据要能取到');
    const res = await get(port, '/f/forged');
    assert.equal(res.status, 404, '伪造票据也能取文件，这个端点就是无鉴权的');
    assert.ok(!res.body.includes(CLIP));
  });

  test('合法票据：整份内容、长度、类型都对', async () => {
    const { port, issue } = await serve();
    const res = await get(port, `/f/${issue('clip.mp4')}`);
    assert.equal(res.status, 200, '合法票据取不到文件，手机上点了还是打不开');
    assert.equal(res.body, CLIP);
    assert.equal(res.headers['content-type'], 'video/mp4', '类型不对，<video> 放不出来');
    assert.equal(res.headers['content-length'], '10', '没有长度，播放器算不出进度条');
    assert.equal(res.headers['accept-ranges'], 'bytes', '不声明 Range，播放器不会尝试拖动');
    assert.equal(res.headers['content-disposition'], undefined, '白名单类型带 attachment 就只能下载，不能预览');
  });

  test.describe('身份', () => {
    const PUBLIC_HOST = 'ccm.example.com';
    const strategy = {
      ownsHost: host => host === PUBLIC_HOST,
      verifyRequest: async headers => {
        if (headers['cf-access-jwt-assertion'] !== 'valid') throw new Error('bad jwt');
      },
    };

    test('公网 Host 没有 IdP 身份：拒绝，票据代替不了它', async () => {
      const { port, issue } = await serve({ strategy });
      const res = await get(port, `/f/${issue('clip.mp4')}`, { host: PUBLIC_HOST });
      assert.equal(res.status, 401, '公网上单靠一张票据就能取文件，CF Access 那层被绕过了');
      assert.ok(!res.body.includes(CLIP));
    });

    test('公网 Host 带着 IdP 身份：照常取', async () => {
      const { port, issue } = await serve({ strategy });
      const res = await get(port, `/f/${issue('clip.mp4')}`, { host: PUBLIC_HOST, 'cf-access-jwt-assertion': 'valid' });
      assert.equal(res.status, 200, '公网手机上永远取不到文件');
    });

    test('本机入口不归 IdP 管：不要求 JWT', async () => {
      const { port, issue } = await serve({ strategy });
      assert.equal((await get(port, `/f/${issue('clip.mp4')}`)).status, 200, '局域网入口会被 IdP 判据误伤');
    });

    test('吊销设备后，它签发的票据立即失效', async () => {
      const trusted = new Set(['phone']);
      const { port, issue } = await serve({ isDeviceTrusted: token => trusted.has(token) });
      const ticket = issue('clip.mp4', 'phone');
      assert.equal((await get(port, `/f/${ticket}`)).status, 200, '受信任设备应当能取');
      trusted.delete('phone');
      const res = await get(port, `/f/${ticket}`);
      assert.equal(res.status, 403, '被吊销的设备还能凭旧票据取 30 分钟文件');
      assert.ok(!res.body.includes(CLIP));
    });

    test('bypass 连接签发的票据不查信任表：真本机和 CF Access 本来就不在表里', async () => {
      const { port, issue } = await serve({ isDeviceTrusted: () => false });
      assert.equal((await get(port, `/f/${issue('clip.mp4', null)}`)).status, 200, '本机和公网手机会永远取不到文件');
    });
  });

  test.describe('SCOPE-01：取文件时重走范围门', () => {
    test('文件夹断开后票据立即失效', async () => {
      let roots = [root];
      const { port, issue } = await serve({ scopeRootsFor: () => roots });
      const ticket = issue('clip.mp4');
      assert.equal((await get(port, `/f/${ticket}`)).status, 200);
      roots = [outside];
      const res = await get(port, `/f/${ticket}`);
      assert.equal(res.status, 404, '断开的文件夹还能凭旧票据读');
      assert.ok(!res.body.includes(CLIP));
    });

    test('文件被换成指向范围外的符号链接：不跟随', async () => {
      const name = 'swapped.mp4';
      writeFileSync(join(root, name), CLIP);
      const { port, issue } = await serve();
      const ticket = issue(name);
      assert.equal((await get(port, `/f/${ticket}`)).status, 200, '正对照：换掉之前要能取到');
      unlinkSync(join(root, name));
      symlinkSync(join(outside, 'secret.mp4'), join(root, name));
      const res = await get(port, `/f/${ticket}`);
      assert.equal(res.status, 404, '符号链接逃逸：范围外的文件被发了出去');
      assert.ok(!res.body.includes(SECRET));
    });

    test('FIFO 不会卡死服务', { skip: process.platform === 'win32' }, async () => {
      execFileSync('mkfifo', [join(root, 'pipe.mp4')]);
      const { port, issue } = await serve();
      assert.equal((await get(port, `/f/${issue('clip.mp4')}`)).status, 200, '正对照：普通文件要能取到');
      assert.equal((await get(port, `/f/${issue('pipe.mp4')}`)).status, 404, 'open FIFO 会永久阻塞事件循环，整个服务挂死');
    });

    test('目录不是文件', async () => {
      const { port, issue } = await serve();
      assert.equal((await get(port, `/f/${issue('clip.mp4')}`)).status, 200, '正对照：普通文件要能取到');
      assert.equal((await get(port, `/f/${issue('dir')}`)).status, 404);
    });
  });

  test.describe('FILE-04：响应形态', () => {
    test('html、svg 只能下载，浏览器不会当页面执行', async () => {
      const { port, issue } = await serve();
      for (const name of ['page.html', 'logo.svg']) {
        writeFileSync(join(root, name), '<script>steal(localStorage)</script>');
        const res = await get(port, `/f/${issue(name)}`);
        assert.equal(res.status, 200);
        assert.equal(res.headers['content-type'], 'application/octet-stream', `${name} 带着可渲染类型，同源脚本就能跑起来`);
        assert.match(res.headers['content-disposition'], new RegExp(`^attachment; filename="?${name}"?$`), `${name} 没有 attachment 会被直接打开`);
      }
    });

    test('下载和预览的响应都禁缓存、禁改写，并且沙箱化', async () => {
      const { port, issue } = await serve();
      const ticket = issue('clip.mp4');
      for (const path of [`/f/${ticket}`, `/f/${ticket}?download=1`]) {
        const { headers } = await get(port, path);
        assert.equal(headers['cache-control'], 'private, no-store, no-transform', '缺 no-store 会被 CDN 留存私有文件，缺 no-transform 会被压缩破坏 Range');
        assert.equal(headers['content-security-policy'], 'sandbox', '万一被当文档打开，sandbox 是最后一道');
      }
    });

    test('?download=1 对白名单类型也强制下载', async () => {
      const { port, issue } = await serve();
      const res = await get(port, `/f/${issue('clip.mp4')}?download=1`);
      assert.match(res.headers['content-disposition'], /^attachment; filename="?clip\.mp4"?$/, '下载按钮点了只会在标签页里放');
      assert.equal(res.headers['content-type'], 'application/octet-stream');
      assert.equal(res.body, CLIP);
    });

    test('中文文件名能下载', async () => {
      const name = '设计稿.pdf';
      writeFileSync(join(root, name), 'pdf');
      const { port, issue } = await serve();
      const res = await get(port, `/f/${issue(name)}`);
      assert.equal(res.status, 200, '文件名直接进响应头会抛错，请求变成 500');
      assert.match(res.headers['content-disposition'], /filename\*=UTF-8''%E8%AE%BE/, '下载后文件名会乱码');
    });
  });

  test.describe('Range', () => {
    const ranged = async range => {
      const { port, issue } = await serve();
      return get(port, `/f/${issue('clip.mp4')}`, { range });
    };

    test('中段、开放结尾、尾部三种形态', async () => {
      for (const [range, contentRange, body] of [
        ['bytes=2-5', 'bytes 2-5/10', '2345'],
        ['bytes=7-', 'bytes 7-9/10', '789'],
        ['bytes=-3', 'bytes 7-9/10', '789'],
      ]) {
        const res = await ranged(range);
        assert.equal(res.status, 206, `${range} 不回 206，视频拖不动`);
        assert.equal(res.headers['content-range'], contentRange);
        assert.equal(res.headers['content-length'], String(body.length));
        assert.equal(res.body, body);
      }
    });

    test('超出文件范围：416，并告诉客户端实际大小', async () => {
      const res = await ranged('bytes=50-60');
      assert.equal(res.status, 416);
      assert.equal(res.headers['content-range'], 'bytes */10');
    });

    test('畸形 Range 和多段 Range 退回整份', async () => {
      // 不带等号才算畸形；bytes=abc 在 range-parser 里是「无可满足的段」，走上面的 416，与 Express 的 send 一致
      for (const range of ['bytes', 'bytes=0-1,4-5']) {
        const res = await ranged(range);
        assert.equal(res.status, 200, `${range} 不该让请求失败`);
        assert.equal(res.body, CLIP);
      }
    });
  });

  test('HEAD 只回头，不发正文', async () => {
    const { port, issue } = await serve();
    const res = await get(port, `/f/${issue('clip.mp4')}`, {}, 'HEAD');
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-length'], '10');
    assert.equal(res.body, '');
  });

  // 用裸 socket：http 客户端读够 Content-Length 就停，看不见多出来的字节
  test('文件边下边长：只发 Content-Length 那么多，多的不落进 keep-alive 连接', async () => {
    const SIZE = 4 * 1024 * 1024;
    writeFileSync(join(root, 'growing.mp4'), Buffer.alloc(SIZE));
    const { port, issue } = await serve();
    const socket = connect(port, '127.0.0.1');
    socket.write(`GET /f/${issue('growing.mp4')} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    socket.once('data', () => appendFileSync(join(root, 'growing.mp4'), 'x'.repeat(1024)));
    const chunks = [];
    for await (const chunk of socket) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    assert.equal(raw.length - raw.indexOf('\r\n\r\n') - 4, SIZE);
  });

  // 路由不过 httpAuth，Express 默认错误页在没设 NODE_ENV 时带堆栈，里面全是本机绝对路径
  test('票据解不了码：只回状态码，不把堆栈发给没鉴权的请求', async () => {
    const { port } = await serve();
    const res = await get(port, '/f/%ff');
    assert.equal(res.status, 400);
    assert.equal(res.body, 'Bad Request');
  });

  test('空文件能取到，不会崩', async () => {
    writeFileSync(join(root, 'empty.mp4'), '');
    const { port, issue } = await serve();
    const res = await get(port, `/f/${issue('empty.mp4')}`);
    assert.equal(res.status, 200);
    assert.equal(res.body, '');
  });

  test.describe('文件描述符不泄漏', { skip: process.platform === 'win32' }, () => {
    const openFds = () => readdirSync('/dev/fd').length;
    async function settlesAt(baseline) {
      for (let i = 0; i < 100 && openFds() > baseline; i++) await sleep(10);
      return openFds();
    }

    test('拖动时浏览器会中断连接：中断后 fd 要关掉，否则多拖几次就 EMFILE', async () => {
      const big = join(root, 'big.mp4');
      closeSync(openSync(big, 'w'));
      truncateSync(big, 256 * 1024 * 1024);
      const { port, issue } = await serve();
      const path = `/f/${issue('big.mp4')}`;
      await get(port, path, {}, 'HEAD');
      const baseline = openFds();
      const inFlight = await new Promise((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path, agent: false }, res => {
          res.once('data', () => {
            const seen = { status: res.statusCode, fds: openFds() };
            req.destroy();
            resolve(seen);
          });
        });
        req.on('error', reject);
        req.end();
      });
      assert.equal(inFlight.status, 200, '正对照：请求要真的在传文件');
      assert.ok(inFlight.fds > baseline, '正对照：传输途中应当看得见多出来的 fd，否则这条测试什么也没测');
      assert.ok(await settlesAt(baseline) <= baseline, '中断的请求没有释放 fd');
    });

    test('416 和 HEAD 不走流，也要关 fd', async () => {
      const { port, issue } = await serve();
      const path = `/f/${issue('clip.mp4')}`;
      await get(port, path, {}, 'HEAD');
      const baseline = openFds();
      for (let i = 0; i < 20; i++) {
        assert.equal((await get(port, path, { range: 'bytes=50-60' })).status, 416, '正对照：要真的走到 416 分支');
        assert.equal((await get(port, path, {}, 'HEAD')).status, 200, '正对照：要真的走到 HEAD 分支');
      }
      assert.ok(await settlesAt(baseline) <= baseline, '416 或 HEAD 分支漏关 fd');
    });
  });
});
