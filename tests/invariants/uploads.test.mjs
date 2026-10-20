// tests/invariants/uploads.test.mjs —— 附件落盘与防穿越安全测试
// 守护：SCOPE-02（sanitize / 大小上限 / 路径不泄露）、FILES-2（symlink 检查与 realpath 归一）、FILES-4（缩略图服务端长度硬限）
// 测什么：sanitizeName 清洗恶意路径与 BOM 前导点；validateAttachments 单文件/总量/数量/缩略图硬限；
//   saveAttachments 真实落盘 0600 权限、落点在 <dataDir>/uploads/<桶>/ 且**工作目录零痕迹**、symlink 攻击拦截；
//   locateStoredAttachment 新家优先 + 老位置回落；buildPromptText 注入提示词；toEventMeta 剥离服务端绝对路径
// 不测什么 + 为什么：不测客户端 canvas 降采样生成逻辑——属于前端职责，服务端实施防御性硬闸
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, mkdir, stat, readdir, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { join, sep, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import {
  sanitizeName,
  validateAttachments,
  saveAttachments,
  buildPromptText,
  toEventMeta,
  locateStoredAttachment,
  ensureUploadsRoot,
  isBareStoredName,
  bucketFor,
  uploadsRoot,
  LEGACY_UPLOAD_DIR,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
} from '../../app/src/files/uploads.js';

// 附件落盘只认注入的 CCM_DATA_DIR，绝不读 process.env——否则用例会写进真实 data/。
const one = (name = 'hello.txt', body = 'world') =>
  [{ name, mimeType: 'text/plain', data: Buffer.from(body).toString('base64') }];

test.describe('SCOPE-02: sanitizeName 文件名安全清洗', () => {
  test('常规文件名保持不变', () => {
    assert.equal(sanitizeName('report.pdf'), 'report.pdf');
  });

  test('提取 basename 并替换路径与特殊字符为下划线', () => {
    assert.equal(sanitizeName('folder/file.png'), 'file.png');
    assert.equal(sanitizeName('a:b<c>d"e|f?g*h.txt'), 'a_b_c_d_e_f_g_h.txt');
  });

  test('剥离前导点（防隐藏文件与 ./.. 路径遍历）', () => {
    assert.equal(sanitizeName('.hidden'), 'hidden');
    assert.equal(sanitizeName('...secret.env'), 'secret.env');
  });

  test('BOM 前缀经 trim 处理后不导致前导点复活', () => {
    assert.equal(sanitizeName('\uFEFF.hidden'), 'hidden');
  });

  test('剥离控制字符（\x00-\x1f 及 \x7f）', () => {
    assert.equal(sanitizeName('test\x00\x08\x1f\x7f.log'), 'test.log');
  });

  test('空文件名、点路径或非字符串回退为 "file"', () => {
    assert.equal(sanitizeName(''), 'file');
    assert.equal(sanitizeName('.'), 'file');
    assert.equal(sanitizeName('..'), 'file');
    assert.equal(sanitizeName(null), 'file');
    assert.equal(sanitizeName(undefined), 'file');
  });
});

test.describe('SCOPE-02 & FILES-4: validateAttachments 服务端输入校验', () => {
  const dummyB64 = Buffer.from('hello').toString('base64');

  test('合法附件列表返回 null（校验通过）', () => {
    const list = [{ name: 'test.txt', mimeType: 'text/plain', data: dummyB64 }];
    assert.equal(validateAttachments(list), null);
    assert.equal(validateAttachments([]), null);
    assert.equal(validateAttachments(null), null);
  });

  test('附件数量超出 MAX_FILES 限制报错', () => {
    const list = Array.from({ length: MAX_FILES + 1 }, (_, i) => ({
      name: `f${i}.txt`,
      mimeType: 'text/plain',
      data: dummyB64,
    }));
    const err = validateAttachments(list);
    assert.match(err, /附件过多/);
  });

  test('缺少必要字段（data, name, mimeType）报错', () => {
    assert.match(validateAttachments([{ name: 'a.txt', mimeType: 'text/plain' }]), /缺少数据/);
    assert.match(validateAttachments([{ name: 'a.txt', mimeType: 'text/plain', data: '' }]), /缺少数据/);
    assert.match(validateAttachments([{ data: dummyB64, mimeType: 'text/plain' }]), /缺少 name\/mimeType/);
    assert.match(validateAttachments([{ data: dummyB64, name: 'a.txt' }]), /缺少 name\/mimeType/);
  });

  test('单文件超出 MAX_FILE_BYTES 限制报错', () => {
    const bigB64 = Buffer.alloc(MAX_FILE_BYTES + 1).toString('base64');
    const err = validateAttachments([{ name: 'big.bin', mimeType: 'application/octet-stream', data: bigB64 }]);
    assert.match(err, /单文件上限/);
  });

  test('附件总量超出 MAX_TOTAL_BYTES 限制报错', () => {
    assert.equal(MAX_TOTAL_BYTES, 20 * 1024 * 1024);
    // 构造总和超出 20MB 的多文件（单个不超过 10MB）
    const f8mb = Buffer.alloc(8 * 1024 * 1024).toString('base64');
    const err = validateAttachments([
      { name: '1.bin', mimeType: 'application/octet-stream', data: f8mb },
      { name: '2.bin', mimeType: 'application/octet-stream', data: f8mb },
      { name: '3.bin', mimeType: 'application/octet-stream', data: f8mb },
    ]);
    assert.match(err, /总量过大/);
  });

  test('FILES-4: 缩略图超过 100k 字符或非字符串拒绝', () => {
    const hugeThumb = 'data:image/png;base64,' + 'a'.repeat(100_001);
    const err1 = validateAttachments([
      { name: 'img.png', mimeType: 'image/png', data: dummyB64, thumb: hugeThumb },
    ]);
    assert.match(err1, /缩略图过大/);

    const err2 = validateAttachments([
      { name: 'img.png', mimeType: 'image/png', data: dummyB64, thumb: 12345 },
    ]);
    assert.match(err2, /缩略图类型无效/);
  });
});

test.describe('SCOPE-02 & FILES-2: saveAttachments 真实落盘与 symlink 防护', () => {
  let workDir, dataDir, env;

  test.beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'ccm-inv-work-'));
    dataDir = await mkdtemp(join(tmpdir(), 'ccm-inv-data-'));
    env = { CCM_DATA_DIR: dataDir };
  });

  test.afterEach(async () => {
    for (const d of [workDir, dataDir]) {
      try {
        await rm(d, { recursive: true, force: true });
      } catch {}
    }
  });

  test('落盘写入 <dataDir>/uploads/<桶>/，权限为 0600', async () => {
    const saved = await saveAttachments(workDir, one(), env);

    assert.equal(saved.length, 1);
    assert.equal(saved[0].name, 'hello.txt');
    assert.equal(saved[0].size, 5);

    const realDir = realpathSync(join(uploadsRoot(env), bucketFor(workDir)));
    assert.ok(saved[0].absPath.startsWith(realDir + sep));

    if (process.platform !== 'win32') {
      const st = await stat(saved[0].absPath);
      assert.equal(st.mode & 0o777, 0o600);
    }
  });

  // 这条就是整次搬家的理由本身：附件曾被写进用户的工作目录，而那些项目并不知道本产品存在
  // （本仓库靠 .gitignore 挡住，用户其它仓库只会凭空多出一个陌生的未跟踪目录）。
  // 它红 = 附件又开始污染用户项目，无论落点被改成了什么。
  test('【搬家核心】工作目录内零痕迹', async () => {
    await saveAttachments(workDir, one(), env);
    assert.equal(existsSync(join(workDir, LEGACY_UPLOAD_DIR)), false, '不得再创建 .ccm-uploads/');
    assert.deepEqual(await readdir(workDir), [], '工作目录必须一个新条目都不多');
  });

  test('不同工作区落进不同的桶，互不覆盖', async () => {
    const other = await mkdtemp(join(tmpdir(), 'ccm-inv-work2-'));
    try {
      const a = await saveAttachments(workDir, one('a.txt', 'AAA'), env);
      const b = await saveAttachments(other, one('b.txt', 'BBB'), env);
      assert.notEqual(dirname(a[0].absPath), dirname(b[0].absPath));
      const root = realpathSync(uploadsRoot(env));
      assert.ok(a[0].absPath.startsWith(root + sep));
      assert.ok(b[0].absPath.startsWith(root + sep));
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  test('恶意文件名穿越仍安全收敛在桶目录内', async () => {
    const malicious = [
      { name: '../../../../../../etc/passwd', mimeType: 'text/plain', data: Buffer.from('x').toString('base64') },
    ];
    const saved = await saveAttachments(workDir, malicious, env);
    const realDir = realpathSync(join(uploadsRoot(env), bucketFor(workDir)));

    assert.ok(saved[0].absPath.startsWith(realDir + sep));
    assert.equal(saved[0].absPath.includes('etc/passwd'), false);
  });

  test('FILES-2: 桶目录被换成外向 symlink 时拒绝落盘', { skip: process.platform === 'win32' }, async () => {
    // 攻击面随落点一起挪了：workDir 已不参与路径计算，能构造的 TOCTOU 面是「本函数 mkdir 出来的
    // 桶目录在 mkdir 与 open 之间被换成指向别处的 symlink」。
    const outside = await mkdtemp(join(tmpdir(), 'ccm-inv-outside-'));
    try {
      await mkdir(uploadsRoot(env), { recursive: true });
      await symlink(outside, join(uploadsRoot(env), bucketFor(workDir)));

      // 断言【只】认 symlink 那条消息，不能写成 /符号链接|越出/：后面还有一道 realpath 前缀校验
      // 会把同一个构造也拦下并抛「越出」，放宽正则等于让两道闸不可区分——symlink 闸失效时用例照样绿
      // （2026-09-06 第一版就是这么写的，注入验证当场抓出）。
      await assert.rejects(saveAttachments(workDir, one('doc.txt', 'hi'), env), /符号链接/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('CCM_DATA_DIR 自身是 symlink 不算攻击，照常落盘', { skip: process.platform === 'win32' }, async () => {
    // 反直觉方向（对照上一条）：用户把数据目录摆到别的卷上是他自己的配置决定——能改那条链的人
    // 早已能改 data/ 里的信任台账。把这条判成拒绝，会让所有用 symlink 摆放 data/ 的部署整个上传功能失效。
    const realData = await mkdtemp(join(tmpdir(), 'ccm-inv-realdata-'));
    const linkParent = await mkdtemp(join(tmpdir(), 'ccm-inv-linkp-'));
    try {
      const linked = join(linkParent, 'data-link');
      await symlink(realData, linked);

      const saved = await saveAttachments(workDir, one(), { CCM_DATA_DIR: linked });
      assert.equal(saved.length, 1);
      assert.ok(existsSync(saved[0].absPath), '经 symlink 摆放的数据目录必须能正常落盘');
    } finally {
      await rm(realData, { recursive: true, force: true });
      await rm(linkParent, { recursive: true, force: true });
    }
  });

  test('空附件列表直接返回空数组', async () => {
    const res = await saveAttachments(workDir, [], env);
    assert.deepEqual(res, []);
  });
});

test.describe('ensureUploadsRoot: --add-dir 启动时快照的前提', () => {
  // 为什么这个函数存在：additionalDirectories 是 CLI **spawn 那一刻的快照**，不存在的目录会被直接
  // 丢弃、之后再建也补不回权限范围。2026-09-06 双组实测——根不存在 + 运行中创建 → Read 弹审批；
  // 根存在（空）+ 运行中创建子目录与文件 → 免审批。全新安装正是前一种形态（首次上传才 mkdir），
  // 所以会话 spawn 前必须先把【根】建出来。顺序契约由 agent-lifecycle 的源码级断言另行钉住。
  let dataParent;

  test.beforeEach(async () => {
    dataParent = await mkdtemp(join(tmpdir(), 'ccm-inv-ensure-'));
  });

  test.afterEach(async () => {
    try {
      await rm(dataParent, { recursive: true, force: true });
    } catch {}
  });

  test('建出附件根（父目录一并补齐），且幂等', () => {
    const env = { CCM_DATA_DIR: join(dataParent, 'nested', 'deeper') };
    assert.equal(existsSync(uploadsRoot(env)), false, '前置：根必须尚不存在');

    const first = ensureUploadsRoot(env);
    assert.equal(existsSync(first), true, '必须把根连同缺失的父目录建出来');
    assert.equal(first, uploadsRoot(env));
    assert.equal(ensureUploadsRoot(env), first, '重复调用必须幂等、不抛');
  });

  test('建不出来时不抛（附件目录失败不得连带让会话起不来）', async () => {
    // 把一个普通文件当成父目录 → mkdir 必然 ENOTDIR
    const blocker = join(dataParent, 'not-a-dir');
    await writeFile(blocker, 'x');
    const env = { CCM_DATA_DIR: join(blocker, 'data') };

    assert.doesNotThrow(() => ensureUploadsRoot(env));
    assert.equal(existsSync(uploadsRoot(env)), false, '确实没建出来——但也确实没抛');
  });
});

test.describe('locateStoredAttachment: 新家优先与老位置回落', () => {
  let workDir, dataDir, env;

  test.beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'ccm-inv-loc-work-'));
    dataDir = await mkdtemp(join(tmpdir(), 'ccm-inv-loc-data-'));
    env = { CCM_DATA_DIR: dataDir };
  });

  test.afterEach(async () => {
    for (const d of [workDir, dataDir]) {
      try {
        await rm(d, { recursive: true, force: true });
      } catch {}
    }
  });

  test('新落点命中，legacy=false', async () => {
    const saved = await saveAttachments(workDir, one('p.png', 'PNG'), env);
    const storedName = basename(saved[0].absPath);

    const loc = locateStoredAttachment(workDir, storedName, env);
    assert.ok(loc, '刚落盘的附件必须能定位');
    assert.equal(loc.legacy, false);
    assert.equal(realpathSync(join(loc.baseDir, loc.storedName)), saved[0].absPath);
  });

  // transcript 是不可变的：搬家前写下的消息里永远是老绝对路径，那批文件既不迁移也不删除。
  // 这条回落就是旧对话附件预览不断链的全部保证——删掉它，用户过往所有图片当场变成「不存在」。
  test('【不断链】新家没有时回落搬家前的 <workDir>/.ccm-uploads/', async () => {
    const legacyDir = join(workDir, LEGACY_UPLOAD_DIR);
    await mkdir(legacyDir, { recursive: true });
    await writeFile(join(legacyDir, '1700000000000-abcd1234-old.png'), 'OLD');

    const loc = locateStoredAttachment(workDir, '1700000000000-abcd1234-old.png', env);
    assert.ok(loc, '搬家前落在工作目录里的附件必须仍可定位');
    assert.equal(loc.legacy, true);
    assert.equal(realpathSync(join(loc.baseDir, loc.storedName)), realpathSync(join(legacyDir, '1700000000000-abcd1234-old.png')));
  });

  test('两处都没有 → null', () => {
    assert.equal(locateStoredAttachment(workDir, '1700000000000-abcd1234-ghost.png', env), null);
  });

  test('SCOPE-02: 非裸文件名一律拒绝（穿越 / 前导点 / 空）', () => {
    for (const bad of ['../escape.png', 'sub/dir.png', 'a\\b.png', '.hidden', '', null, undefined, 42]) {
      assert.equal(locateStoredAttachment(workDir, bad, env), null, `应拒绝：${String(bad)}`);
      assert.equal(isBareStoredName(bad), false, `isBareStoredName 应拒绝：${String(bad)}`);
    }
    assert.equal(isBareStoredName('1700000000000-abcd1234-ok.png'), true);
  });
});

test.describe('buildPromptText: 提示词路径注入', () => {
  test('常规文本末尾追加 [附件] 块与绝对路径', () => {
    const prompt = buildPromptText('查看附件', [{ absPath: '/var/repo/.ccm-uploads/f1.txt' }]);
    assert.ok(prompt.startsWith('查看附件\n\n[附件]'));
    assert.ok(prompt.includes('/var/repo/.ccm-uploads/f1.txt'));
  });

  test('纯附件（prompt 为空）只生成 [附件] 块，不保留前置换行', () => {
    const prompt = buildPromptText('', [{ absPath: '/var/repo/.ccm-uploads/f1.txt' }]);
    assert.ok(prompt.startsWith('[附件]'));
    assert.ok(!prompt.includes('\n\n[附件]'));
  });

  test('无附件时原样返回文本', () => {
    assert.equal(buildPromptText('纯文字', []), '纯文字');
    assert.equal(buildPromptText('纯文字', null), '纯文字');
  });
});

test.describe('SCOPE-02: toEventMeta 客户端事件元数据保护', () => {
  test('剥离 absPath 和完整 data，只暴露 storedName 与尺寸', () => {
    const meta = toEventMeta([
      {
        absPath: '/private/secret/dir/.ccm-uploads/1700000000-abcd-photo.png',
        name: 'photo.png',
        mimeType: 'image/png',
        size: 2048,
        thumb: 'data:image/png;base64,thumbdata',
      },
    ]);

    assert.equal(meta.length, 1);
    assert.equal(meta[0].name, 'photo.png');
    assert.equal(meta[0].storedName, '1700000000-abcd-photo.png');
    assert.equal(meta[0].size, 2048);
    assert.equal(meta[0].thumb, 'data:image/png;base64,thumbdata');

    // 绝对路径与原始数据不得泄露
    assert.equal(meta[0].absPath, undefined);
    assert.equal(meta[0].data, undefined);
    assert.ok(!JSON.stringify(meta).includes('/private/secret/dir'));
  });
});
