// #402：可展开项补 ▸/▾ 与 aria-expanded（任务横幅、任务行、本轮改动文件行、Git 改动行）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readAppJsSource } from '../helpers/frontend-source.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const html = readFileSync(join(root, 'app/public/index.html'), 'utf8');
const appJs = readAppJsSource();
const taskStatusJs = readFileSync(join(root, 'app/public/js/app/task-status.js'), 'utf8');
const gitChangesJs = readFileSync(join(root, 'app/public/js/app/git-changes.js'), 'utf8');

test('#402 #taskBannerToggle 内有独立 #taskBannerChevron，不污染进度文案节点', () => {
  assert.match(html, /id="taskBannerChevron"/);
  assert.match(html, /id="taskBannerChevron"[^>]*>▸</);
  assert.match(html, /id="taskBannerChevron"[^>]*aria-hidden="true"/);
  // chevron 是 progress text 的兄弟，不是其子节点
  assert.match(
    html,
    /id="taskProgressText"[^>]*>[\s\S]{0,80}?id="taskBannerChevron"/,
  );
});

test('#402 syncBannerToggle 同步 aria-expanded 与 chevron ▸/▾', () => {
  assert.match(taskStatusJs, /taskBannerChevron\.textContent = expanded \? '▾' : '▸'/);
  assert.match(taskStatusJs, /setAttribute\('aria-expanded', String\(expanded\)\)/);
});

test('#402 bg-task-row 左侧 expand 按钮带 aria-expanded 与 ▸/▾，停钮为兄弟；整行也可点', () => {
  assert.match(
    taskStatusJs,
    /createElement\('<button type="button" class="flex items-center gap-1\.5 flex-1 min-w-0 text-left cursor-pointer" data-testid="bg-task-expand"><\/button>'\)/,
  );
  assert.match(taskStatusJs, /expandBtn\.setAttribute\('aria-expanded', String\(isActive\)\)/);
  assert.match(taskStatusJs, /rowChevron\.textContent = isActive \? '▾' : '▸'/);
  assert.match(taskStatusJs, /top\.append\(expandBtn, \.\.\.tail\)/);
  assert.match(taskStatusJs, /expandBtn\.addEventListener\('click'/);
  assert.match(taskStatusJs, /e\?\.stopPropagation\?\.\(\)/);
  // 整行 click 恢复 meta/中心点命中；停钮 closest 排除
  assert.match(taskStatusJs, /row\.addEventListener\('click'/);
  assert.match(taskStatusJs, /e\?\.target\?\.closest\?\.\('\[data-testid="bg-task-stop"\]'\)/);
});

test('#402 .tfc-row-btn 有 chevron 与 aria-expanded 同步', () => {
  assert.match(appJs, /class="tfc-row-btn[^"]*"[^>]*aria-expanded="false"/);
  assert.match(appJs, /class="tfc-chevron[^"]*"[^>]*>▸</);
  assert.match(appJs, /btn\.setAttribute\('aria-expanded', String\(open\)\)/);
  assert.match(appJs, /chevron\.textContent = open \? '▾' : '▸'/);
});

test('#402 git-change-row 按钮有 chevron 与 aria-expanded 同步', () => {
  assert.match(gitChangesJs, /btn\.setAttribute\('aria-expanded', 'false'\)/);
  assert.match(gitChangesJs, /chevron\.textContent = '▸'/);
  assert.match(gitChangesJs, /btn\.setAttribute\('aria-expanded', String\(open\)\)/);
  assert.match(gitChangesJs, /chevron\.textContent = open \? '▾' : '▸'/);
  assert.match(gitChangesJs, /data-testid="git-change-row"/);
});
