// 按源码文本断言前端控制器行为的单测，读的是这份合集而不是单个 app.js。
// app.js 原是一个大 IIFE；#359 起视图控制器陆续原样迁到 app/*.js。只读 app.js 的话，搬走的代码对正向断言是「找不到」，
// 对「不得出现 X」这类反向断言则是静默失效——永远绿，却什么也没守住。每迁出一个模块就在下面加一行。
import { readFileSync } from 'node:fs';

const FILES = [
  'app.js',
  'app/console-modal.js',
  'app/service-status.js',
  'app/statusline-view.js',
  'app/empty-surfaces.js',
  'app/session-sidebar.js',
  'app/composer-controls.js',
];

export function readAppJsSource() {
  return FILES.map(f => readFileSync(new URL(`../../app/public/js/${f}`, import.meta.url), 'utf8')).join('\n');
}
