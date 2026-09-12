// tests/unit/logic-rewind.test.mjs —— 回退收尾的告知文案组装
//
// 它回答：回退做完之后，除了「成功」还得告诉用户什么。三件事可能叠加，且都是
// 「服务端算得出、但不说用户就不知道」的那类——不说的后果不是报错，是用户以为全好了：
//   · unrestored   接口报了成功，实际有文件没恢复（SDK 契约：per-file 失败不抛错也不计数）
//   · skippedLinks 软链接/硬链接被有意跳过，那些文件还停在回退前的状态
//   · warning      分叉没建成之类的整体性问题（服务端拼好的整句）
import test from 'node:test';
import assert from 'node:assert/strict';
import { rewindOutcomeNotes } from '../../app/public/js/logic/rewind.js';

test.describe('rewindOutcomeNotes', () => {
  test('一切正常 → 不追加任何提示', () => {
    assert.deepEqual(rewindOutcomeNotes({ unrestored: [], skippedLinks: 0, warning: null }), [],
      '成功本身由 rewind_applied 广播播报，这里再补一句就是同屏复读');
    assert.deepEqual(rewindOutcomeNotes(), [], '缺参数不该崩，也不该凭空造提示');
  });

  test('有文件没恢复 → 点名是哪些，不是笼统的「部分文件」', () => {
    const notes = rewindOutcomeNotes({ unrestored: ['/w/src/a.js', '/w/README.md'] });
    assert.equal(notes.length, 1);
    assert.equal(notes[0].tone, 'danger');
    assert.match(notes[0].text, /a\.js/, '不点名就等于让用户自己去 git 面板一个个找');
    assert.match(notes[0].text, /README\.md/);
  });

  test('未恢复文件很多时截断，但把总数说清', () => {
    const many = Array.from({ length: 9 }, (_, i) => `/w/f${i}.js`);
    const notes = rewindOutcomeNotes({ unrestored: many });
    assert.match(notes[0].text, /9/, '截断了也必须让用户知道一共几个，否则他以为只有列出的那几个');
    assert.ok(notes[0].text.length < 200, '整屏文件名会把提示挤爆，反而没人读');
  });

  test('软链接被跳过 → 单独一条，说清那些文件没回退', () => {
    const notes = rewindOutcomeNotes({ skippedLinks: 2 });
    assert.equal(notes.length, 1);
    assert.match(notes[0].text, /2/);
    assert.match(notes[0].text, /链接/, '只说「跳过 2 个」而不说为什么，用户无从判断要不要手动处理');
  });

  test('三者叠加 → 各占一条，warning 排最前', () => {
    const notes = rewindOutcomeNotes({
      unrestored: ['/w/a.js'], skippedLinks: 1, warning: '文件已回退，但新会话创建失败。',
    });
    assert.equal(notes.length, 3, '合并成一句会让最要紧的那条被淹没');
    assert.equal(notes[0].text, '文件已回退，但新会话创建失败。',
      'warning 是整体性失败（会话没建成），比「某几个文件没恢复」更要紧，必须排前面');
  });

  test('skippedLinks 非正数不产出提示（缺字段 / 0 / 脏值）', () => {
    assert.deepEqual(rewindOutcomeNotes({ skippedLinks: 0 }), []);
    assert.deepEqual(rewindOutcomeNotes({ skippedLinks: undefined }), []);
    assert.deepEqual(rewindOutcomeNotes({ skippedLinks: -1 }), []);
    assert.deepEqual(rewindOutcomeNotes({ skippedLinks: 'x' }), [],
      '脏值当成「有跳过」会凭空吓用户一跳');
  });

  test('unrestored 不是数组时按「没有」处理，不抛错', () => {
    assert.deepEqual(rewindOutcomeNotes({ unrestored: null }), []);
    assert.deepEqual(rewindOutcomeNotes({ unrestored: 'a.js' }), []);
  });
});
