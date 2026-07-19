// compose.mjs —— 按 timeline JSON 用 ffmpeg 合成竖屏成片（静音字幕版）。
//   card 段：card-<id>.png 图片循环（-loop 1 -t）
//   clip 段：三层 = 纯色底(lavfi) ← 录屏 clip 缩放进手机区（尾帧 tpad 冻结补时长） ← 透明覆盖层
//   最后 concat demuxer 无损拼接（各段编码参数一致）。
// ⚠️ 关键坑（ffmpeg 8.x）：lavfi color 是无限源，overlay 用 shortest=1 并不会终止编码，
//    会无限膨胀输出文件——每个含 lavfi 的段都必须显式 `-t <durSec>`。本脚本已内建，勿删。
// 用法：node tools/compose.mjs --timeline timeline/vertical-30s.json \
//         [--clips clips] [--cards cards/<name>] [--out render/<name>.mp4]
//   缺 clip 素材时默认报错；CCM_PLACEHOLDER=1 用灰底占位段代替（管线试跑用）。
// 依赖：系统 ffmpeg / ffprobe（无 node 依赖）。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const argOf = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const timelinePath = argOf('--timeline');
if (!timelinePath) { console.error('用法: node tools/compose.mjs --timeline timeline/xxx.json [--clips clips] [--cards cards/<name>] [--out render/<name>.mp4]'); process.exit(1); }
const tl = JSON.parse(readFileSync(timelinePath, 'utf8'));
const CLIPS = argOf('--clips') || 'clips';
const CARDS = argOf('--cards') || join('cards', tl.name);
const OUT = argOf('--out') || join('render', `${tl.name}.mp4`);
const PLACEHOLDER = process.env.CCM_PLACEHOLDER === '1';

const { w: W, h: H, fps: FPS } = tl.canvas;
const P = tl.phone;
const BG = tl.theme.bg;
const SEG_DIR = join(dirname(OUT), `_segs_${tl.name}`);
mkdirSync(SEG_DIR, { recursive: true });
mkdirSync(dirname(OUT), { recursive: true });

const ENC = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-an'];
const run = (a) => {
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', ...a], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg 失败: ffmpeg ${a.join(' ')}\n${r.stderr}`);
};

const segs = [];
for (const scene of tl.scenes) {
  const seg = join(SEG_DIR, `${scene.id}.mp4`);
  const dur = String(scene.durSec);
  if (scene.type === 'card') {
    const png = join(CARDS, `card-${scene.id}.png`);
    if (!existsSync(png)) throw new Error(`缺卡片图层 ${png}（先跑 tools/gen-cards.mjs）`);
    run(['-loop', '1', '-i', png, '-t', dur, ...ENC, seg]);
  } else {
    const overlay = join(CARDS, `overlay-${scene.id}.png`);
    if (!existsSync(overlay)) throw new Error(`缺覆盖图层 ${overlay}（先跑 tools/gen-cards.mjs）`);
    let clip = join(CLIPS, `${scene.clip}.mp4`);
    if (!existsSync(clip)) {
      if (!PLACEHOLDER) throw new Error(`缺录屏素材 ${clip}（先跑 tools/make-demo-clips.js；试跑可设 CCM_PLACEHOLDER=1）`);
      console.warn(`⚠️ ${clip} 缺失，用灰底占位`);
      clip = join(SEG_DIR, `_ph_${scene.clip}.mp4`);
      // 占位源也含 lavfi：显式 -t，防无限编码
      run(['-f', 'lavfi', '-i', `color=c=555555:s=${P.w}x${P.h}:r=${FPS}`, '-t', dur, ...ENC, clip]);
    }
    // 三层合成。tpad stop_mode=clone：clip 比场景短时冻结尾帧补齐；总长由 -t 硬截（lavfi 坑）。
    run([
      '-f', 'lavfi', '-i', `color=c=${BG.replace('#', '0x')}:s=${W}x${H}:r=${FPS}`,
      '-i', clip, '-i', overlay,
      '-filter_complex',
      `[1:v]scale=${P.w}:${P.h},tpad=stop_mode=clone:stop_duration=${dur}[ph];` +
      `[0:v][ph]overlay=${P.x}:${P.y}[base];[base][2:v]overlay=0:0[v]`,
      '-map', '[v]', '-t', dur, ...ENC, seg
    ]);
  }
  segs.push(seg);
  console.log(`🧩 ${scene.id} · ${dur}s`);
}

const listFile = join(SEG_DIR, 'concat.txt');
writeFileSync(listFile, segs.map(s => `file '${resolve(s)}'`).join('\n') + '\n');
run(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', OUT]);
rmSync(SEG_DIR, { recursive: true, force: true });

const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size', '-of', 'json', OUT], { encoding: 'utf8' });
const fmt = JSON.parse(probe.stdout || '{}').format || {};
console.log(`✅ ${OUT} · ${Number(fmt.duration || 0).toFixed(2)}s · ${(Number(fmt.size || 0) / 1024 / 1024).toFixed(1)}MB`);
