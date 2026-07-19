// gen-cards.mjs —— 从 timeline JSON 生成竖屏合成所需的静态图层（Playwright Chromium 截图）。
//   · type:"card" 场景 → card-<id>.png：1080×1920 不透明全屏字幕卡（深底 + 大标题 + 副行）
//   · type:"clip" 场景 → overlay-<id>.png：1080×1920 透明覆盖层（顶部标题 + 手机区圆角描边 + 底部字幕）
//     手机区（timeline.phone 矩形）完全透明，合成时录屏 clip 从下层透出。
// 用法：node tools/gen-cards.mjs --timeline timeline/vertical-30s.json [--out cards/<name>]
// 依赖：本目录 `npm i`（@playwright/test 提供 Chromium）。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const argOf = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const timelinePath = argOf('--timeline');
if (!timelinePath) { console.error('用法: node tools/gen-cards.mjs --timeline timeline/xxx.json [--out cards/xxx]'); process.exit(1); }
const tl = JSON.parse(readFileSync(timelinePath, 'utf8'));
const OUT = argOf('--out') || join('cards', tl.name);
mkdirSync(OUT, { recursive: true });

const { w: W, h: H } = tl.canvas;
const T = tl.theme;
const P = tl.phone;
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const baseCss = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${W}px; height: ${H}px; font-family: ${T.font}; }
`;

// 全屏字幕卡：垂直居中标题块，accent 短横线点缀
function cardHtml(scene) {
  const lines = (scene.lines || []).map(l => `<p class="line">${esc(l)}</p>`).join('');
  return `<!doctype html><meta charset="utf-8"><style>${baseCss}
    body { background: ${T.bg}; display: flex; align-items: center; justify-content: center; }
    .box { text-align: center; padding: 0 90px; }
    .rule { width: 120px; height: 8px; border-radius: 4px; background: ${T.accent}; margin: 0 auto 64px; }
    h1 { color: ${T.text}; font-size: 92px; font-weight: 700; line-height: 1.35; margin-bottom: 48px; }
    .line { color: ${T.dim}; font-size: 60px; line-height: 1.6; }
  </style><body><div class="box"><div class="rule"></div><h1>${esc(scene.title)}</h1>${lines}</div></body>`;
}

// 透明覆盖层：顶部标题、手机区描边（区内全透明）、底部字幕
function overlayHtml(scene) {
  const caps = (scene.captions || []).map(c => `<p class="cap">${esc(c)}</p>`).join('');
  const titleH = P.y;                       // 顶部可用高度
  const capTop = P.y + P.h;                 // 底部字幕带起点
  return `<!doctype html><meta charset="utf-8"><style>${baseCss}
    body { background: transparent; position: relative; }
    .title { position: absolute; top: 0; left: 0; width: ${W}px; height: ${titleH}px;
             display: flex; align-items: center; justify-content: center;
             color: ${T.text}; font-size: 64px; font-weight: 700; }
    .title b { color: ${T.accent}; font-weight: 700; }
    .frame { position: absolute; left: ${P.x - 6}px; top: ${P.y - 6}px;
             width: ${P.w + 12}px; height: ${P.h + 12}px;
             border: 6px solid ${T.accent}; border-radius: 44px; }
    .caps { position: absolute; left: 0; top: ${capTop}px; width: ${W}px; height: ${H - capTop}px;
            display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; }
    .cap { color: ${T.text}; font-size: 46px; line-height: 1.4; }
  </style><body>
    <div class="title">${esc(scene.title)}</div>
    <div class="frame"></div>
    <div class="caps">${caps}</div>
  </body>`;
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: W, height: H } });
const manifest = [];
for (const scene of tl.scenes) {
  const isCard = scene.type === 'card';
  const file = join(OUT, `${isCard ? 'card' : 'overlay'}-${scene.id}.png`);
  await page.setContent(isCard ? cardHtml(scene) : overlayHtml(scene), { waitUntil: 'networkidle' });
  await page.screenshot({ path: file, omitBackground: !isCard });
  manifest.push({ id: scene.id, type: scene.type, file });
  console.log(`🖼  ${file}`);
}
await browser.close();
writeFileSync(join(OUT, 'cards-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`✅ ${manifest.length} 张图层已写入 ${OUT}`);
