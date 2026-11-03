// tests/unit/check-tailwind-css.test.mjs —— tw.css 新鲜度门禁自身
// 覆盖：照 build:css 的参数编出来的产物判过；源码多了一个类名而产物没重编要报，并指明跑 npm run build:css；
// 配置写坏、CLI 编不出来要报编译失败，不能拿空输出去比、报成「过期」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTailwindCss } from '../../tests/gates/check-tailwind-css.js';

const CLI = createRequire(import.meta.url).resolve('tailwindcss/lib/cli.js');

async function makeRepo(t) {
  const root = await mkdtemp(join(tmpdir(), 'ccm-tailwind-css-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'app/public/css'), { recursive: true });
  await writeFile(join(root, 'tailwind.config.js'), "export default { content: { relative: true, files: ['./app/public/index.html'] } };\n");
  await writeFile(join(root, 'app/public/index.html'), '<div class="p-2"></div>\n');
  return root;
}

// 与 package.json 的 build:css 同一组参数，产物写进文件——机主提交的就是这样编出来的那份
function buildCss(root) {
  const r = spawnSync(process.execPath, [CLI, '-c', 'tailwind.config.js', '-o', 'app/public/css/tw.css'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, `夹具编译失败：${r.stderr}`);
}

test('刚跑过 build:css → 不报；源码新写了类名而产物没重编 → 报，并指明跑 npm run build:css', async t => {
  const root = await makeRepo(t);
  buildCss(root);
  assert.deepEqual(checkTailwindCss({ rootDir: root }).problems, [],
    '刚编出来的产物被判成过期——门禁的编译方式与 build:css 不一致，跑完 build:css 也永远是红的');

  await writeFile(join(root, 'app/public/index.html'), '<div class="p-2 m-3"></div>\n');
  const { problems } = checkTailwindCss({ rootDir: root });
  assert.equal(problems.length, 1, '源码新写的 m-3 不在提交的 tw.css 里，门禁却没报——页面上这个类会静默没有样式');
  assert.match(problems[0], /npm run build:css/, '报了却没说怎么修');
});

test('配置写坏、CLI 编不出来 → 报编译失败，不当成产物过期', async t => {
  const root = await makeRepo(t);
  buildCss(root);
  await writeFile(join(root, 'tailwind.config.js'), 'export default {\n');

  const { problems } = checkTailwindCss({ rootDir: root });
  assert.equal(problems.length, 1, 'CLI 退出码非 0 却没报——编不出来也能判过，门禁就形同虚设');
  assert.match(problems[0], /编译失败/, '编不出来被报成了别的问题，会把人引去重跑 build:css');
});
