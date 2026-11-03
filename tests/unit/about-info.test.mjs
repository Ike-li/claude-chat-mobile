// tests/unit/about-info.test.mjs —— 设置「关于」页（#303）的数据：作者、仓库、许可证原文、第三方组件清单。
// 文件系统是外部边界，这里在一次性目录里搭一棵「装好依赖的安装树」，不读本仓的 node_modules
// （CI 与本机装的是含 dev 的全量，拿它断言「生产范围」等于什么都没测）。
//
// 组件范围是这一页唯一容易算错的地方：Issue 写明不能拿 dependencies 减 devDependencies——
// 间接依赖不在 dependencies 里，别的平台的可选包锁文件里有、本机根本没装；浏览器端的 Socket.IO
// 客户端由服务端从 socket.io 包里吐出来，却不是一个独立的 npm 包。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { readAboutInfo } from '../../app/src/ops/about.js';

function put(root, rel, content) {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
}

function installTree() {
  const root = mkdtempSync(join(tmpdir(), 'ccm-about-'));
  put(root, 'package.json', {
    name: 'claude-chat-mobile', version: '1.13.0', license: 'Apache-2.0',
    author: 'Ike-li (https://github.com/Ike-li)',
    repository: { type: 'git', url: 'git+https://github.com/Ike-li/claude-chat-mobile.git' },
  });
  put(root, 'package-lock.json', {
    lockfileVersion: 3,
    packages: {
      '': { name: 'claude-chat-mobile', version: '1.13.0' },
      'node_modules/express': { version: '5.1.0', license: 'MIT' },
      'node_modules/debug': { version: '4.4.0', license: 'MIT' },
      'node_modules/send/node_modules/debug': { version: '2.6.9', license: 'MIT' },
      'node_modules/eslint': { version: '9.0.0', dev: true, license: 'MIT' },
      'node_modules/@img/sharp-linux-x64': { version: '0.33.0', optional: true, license: 'Apache-2.0' },
      'node_modules/legacy-licenses': { version: '1.0.0' },
      'node_modules/socket.io': { version: '4.8.4', license: 'MIT' },
    },
  });
  put(root, 'node_modules/express/package.json', { name: 'express', version: '5.1.0', license: 'MIT' });
  put(root, 'node_modules/debug/package.json', { name: 'debug', version: '4.4.0', license: 'MIT' });
  put(root, 'node_modules/send/node_modules/debug/package.json', { name: 'debug', version: '2.6.9', license: 'MIT' });
  // dev 依赖在开发机上是装着的——正因如此才不能拿「装没装」当唯一判据
  put(root, 'node_modules/eslint/package.json', { name: 'eslint', version: '9.0.0', license: 'MIT' });
  // 老式 licenses 数组（npm 早已弃用，仍有包这么写）
  put(root, 'node_modules/legacy-licenses/package.json', { name: 'legacy-licenses', version: '1.0.0', licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] });
  put(root, 'node_modules/socket.io/package.json', { name: 'socket.io', version: '4.8.4', license: 'MIT' });
  // 只放外壳实际加载的压缩版：真包里同目录还有未压缩的 socket.io.js，那份不发到手机上
  put(root, 'node_modules/socket.io/client-dist/socket.io.min.js', '/*!\n * Socket.IO v4.8.4\n * (c) 2014-2026 Guillermo Rauch\n * Released under the MIT License.\n */\n!function(){}();\n');
  // 许可证原文故意带 CRLF 与非 ASCII：「原样」要逐字节成立，不是「看起来一样」
  put(root, 'LICENSE', 'Apache License\r\nVersion 2.0 — 原文\r\n');
  put(root, 'NOTICE', 'Claude Chat Mobile\nCopyright 2026 Ike-li\n');
  put(root, 'app/public/vendor/THIRD-PARTY-NOTICES.md', '# 第三方组件与许可证\n');
  return root;
}

test.describe('readAboutInfo：第三方组件按实际分发的范围列', () => {
  test('生产依赖里装上了的才列：dev 不列、别的平台的可选包不列、嵌套的另一个版本单列、浏览器端 Socket.IO 客户端单列', () => {
    const root = installTree();
    try {
      const { components } = readAboutInfo({ rootDir: root });
      const ids = components.map(c => `${c.name}@${c.version}`);
      assert.ok(ids.includes('express@5.1.0'));
      assert.ok(ids.includes('debug@4.4.0') && ids.includes('debug@2.6.9'), `同名不同版本是两份分发物：${ids}`);
      assert.ok(!ids.some(id => id.startsWith('eslint@')), 'dev 依赖不随 npm ci --omit=dev 分发');
      assert.ok(!ids.some(id => id.startsWith('@img/sharp-linux-x64@')), '锁文件里有、本机没装的可选包不是分发物');
      const client = components.find(c => c.scope === 'browser');
      assert.deepEqual(client, { name: 'socket.io-client', version: '4.8.4', license: 'MIT', scope: 'browser' },
        '/socket.io/socket.io.min.js 是发到手机上运行的代码，不在 vendor 目录，也不是独立的 npm 包');
      assert.ok(components.filter(c => c.scope !== 'browser').every(c => c.scope === 'server'));
      assert.equal(components.find(c => c.name === 'legacy-licenses').license, 'MIT OR Apache-2.0');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

test.describe('readAboutInfo：许可证原文与作者', () => {
  test('LICENSE / NOTICE / vendor 声明原样返回，逐字节相等', () => {
    const root = installTree();
    try {
      const info = readAboutInfo({ rootDir: root });
      for (const [field, rel] of [['license', 'LICENSE'], ['notice', 'NOTICE'], ['thirdPartyNotices', 'app/public/vendor/THIRD-PARTY-NOTICES.md']]) {
        assert.ok(Buffer.from(info[field], 'utf8').equals(readFileSync(join(root, rel))), `${field} 与 ${rel} 不是逐字节相等`);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('作者与仓库取自 package.json：作者链接到主页，仓库地址去掉 git+ 与 .git', () => {
    const root = installTree();
    try {
      const info = readAboutInfo({ rootDir: root });
      assert.deepEqual(info.author, { name: 'Ike-li', url: 'https://github.com/Ike-li' });
      assert.equal(info.repository, 'https://github.com/Ike-li/claude-chat-mobile');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
