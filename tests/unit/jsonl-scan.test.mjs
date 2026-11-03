// tests/unit/jsonl-scan.test.mjs —— transcript 逐行扫描引擎（shared/jsonl-scan.js）
// 测什么：自己切行的扫描与原先的 readline 逐行读交出同样的条目、同样的顺序；每行带的字节偏移是这一行内容
//         结束的位置；end 只扫前这么多字节。块边界上的情形（多字节字符、换行符、超长行跨块）用极小的
//         highWaterMark 逼出来。
// 不测什么 + 为什么：① 与 readline 的两处差异（U+2028/U+2029、单独的 '\r'）——写在模块注释里；前者是
//         用户看得见的修复，守在 history-messages、resume-anchor 各自的测试里
//         ② 回显 / 判定怎么用这些条目——归 history-messages、resume-anchor 各自的测试
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanJsonl } from '../../app/src/shared/jsonl-scan.js';

const dir = mkdtempSync(join(tmpdir(), 'ccm-jsonl-scan-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

// 每段原样落盘（不补换行），偏移按段的字节长度累加——与引擎的切法无关的一份答案。
const LONG = 'x'.repeat(5000);
const PIECES = [
  '{"n":1,"t":"普通一行"}\n',
  '{"n":2,"t":"CRLF 结尾"}\r\n',
  '\n',
  '   \n',
  '{"n":3,"t":"🙂 四字节 emoji 和中文混排 🙂"}\n',
  '{"n":4,"t":"写坏的行"\n',
  `{"n":5,"t":"${LONG}"}\n`,
  '{"n":6,"t":"é"}\n',
  '{"n":7,"t":"末行没有换行"}',
];

function writeFixture(name, pieces) {
  const file = join(dir, name);
  writeFileSync(file, pieces.join(''));
  return file;
}

// 改动前 history.js / resume-anchor.js 的读法：readline 按行、空行跳过、JSON.parse 失败跳过
async function readlineEntries(file, end) {
  const input = createReadStream(file, { encoding: 'utf-8', ...(end != null ? { start: 0, end: end - 1 } : {}) });
  const out = [];
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 跳过 */ }
  }
  return out;
}

async function scan(file, opts) {
  const got = [];
  await scanJsonl(await open(file), (entry, end) => got.push({ entry, end }), opts);
  return got;
}

function expectedEnds(pieces) {
  const ends = [];
  let pos = 0;
  for (const p of pieces) {
    const bytes = Buffer.byteLength(p);
    const content = p.endsWith('\n') ? bytes - 1 : bytes; // CRLF 的 '\r' 算在内容里，JSON.parse 当空白
    let ok = true;
    try { JSON.parse(p); } catch { ok = false; }
    if (ok && p.trim()) ends.push(pos + content);
    pos += bytes;
  }
  return ends;
}

for (const highWaterMark of [1, 2, 3, 7, 64, undefined]) {
  test(`scanJsonl：与 readline 交出同样的条目和顺序，偏移是行内容结束处（highWaterMark=${highWaterMark ?? '默认'}）`, async () => {
    const file = writeFixture(`all-${highWaterMark}.jsonl`, PIECES);
    const got = await scan(file, { highWaterMark });
    assert.deepEqual(got.map(g => g.entry), await readlineEntries(file),
      '自己切行与 readline 交出的条目不同：块边界上切坏了行或字符');
    assert.deepEqual(got.map(g => g.end), expectedEnds(PIECES),
      '偏移不是行内容结束的位置：只读前 N 字节的判定会多收或少收一行');
  });
}

test('scanJsonl：end 只扫前这么多字节，与 readline 读同一段结果相同（切在行中间、切在换行符上）', async () => {
  const file = writeFixture('cut.jsonl', PIECES);
  const ends = expectedEnds(PIECES);
  for (const end of [ends[0], ends[0] + 1, ends[2] - 3, ends[3], ends[4] + 1, ends.at(-1)]) {
    for (const highWaterMark of [3, undefined]) {
      const got = await scan(file, { end, highWaterMark });
      assert.deepEqual(got.map(g => g.entry), await readlineEntries(file, end), `end=${end} hwm=${highWaterMark}`);
      assert.ok(got.every(g => g.end <= end), `交出了 end 之后的行：end=${end}`);
    }
  }
});


// 4a 增量解析：上次扫到哪、文件变长后从哪接着扫。写到一半的尾行不算扫过，下次从它的行首重扫。
test('scanJsonl：start 从行首接着扫，交出的与从头扫时这之后的行相同；返回最后一个换行符之后的位置', async () => {
  const text = PIECES.join('');
  const file = writeFixture('resume.jsonl', PIECES);
  const full = await scan(file);
  const resumeAt = end => Buffer.from(text).subarray(0, end).lastIndexOf(10) + 1;
  let start = 0;
  for (const p of PIECES) {
    for (const end of [undefined, ...expectedEnds(PIECES).filter(e => e > start)]) {
      for (const highWaterMark of [3, undefined]) {
        const got = [];
        const resume = await scanJsonl(await open(file), (entry, lineEnd) => got.push({ entry, end: lineEnd }), { start, end, highWaterMark });
        const stop = end ?? Buffer.byteLength(text);
        assert.deepEqual(got, full.filter(g => g.end >= start && g.end <= stop),
          `从 start=${start} 接着扫（end=${end}）与从头扫的这一段不同：增量解析会漏行或多行`);
        assert.equal(resume, Math.max(start, resumeAt(stop)),
          `start=${start} end=${end}：续读位置不在最后一个换行符之后，下次会重喂或跳过一行`);
      }
    }
    start += Buffer.byteLength(p);
  }
});
