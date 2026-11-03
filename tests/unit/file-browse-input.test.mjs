// tests/unit/file-browse-input.test.mjs —— writeFileInScope 对畸形入参给结构化拒绝，不抛
//
// PR #236 review：范围门挪到入参检查之前之后，relPath 不是字符串时 path.join 直接抛 TypeError——socket 层只能回
// 通用的「处理出错」（可重试），客户端会反复重试一个永远非法的请求，审计也记不下 file_write/denied。
// 此前同一请求若 content / baseHash 也不合法，回的是结构化的 bad_content / bad_base_hash。
// 不测范围门本身（tests/invariants/file-browse.test.mjs 守着 SCOPE-01）；这里只管入参类型。
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileInScope } from '../../app/src/files/file-browse.js';

const CWD = '/nonexistent-ccm-unit/ws';

test('relPath 不是字符串：回 bad_path，不抛（content / baseHash 不合法时也一样）', () => {
  for (const relPath of [42, { a: 1 }, ['a.txt'], true]) {
    for (const [content, baseHash] of [['x', 'h'], [null, 'h'], ['x', null]]) {
      let result;
      assert.doesNotThrow(() => { result = writeFileInScope(CWD, relPath, content, [CWD], { baseHash }); },
        `relPath=${JSON.stringify(relPath)} 抛了，socket 层只能回可重试的通用错误`);
      assert.deepEqual([result.ok, result.code], [false, 'bad_path'], JSON.stringify({ relPath, content, baseHash }));
    }
  }
});
