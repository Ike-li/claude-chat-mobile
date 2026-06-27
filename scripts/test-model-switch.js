#!/usr/bin/env node
// E8 模型切换验收脚本（语义断言：result.models 须含目标模型名）
// 用法：
//   终端1: AUTH_TOKEN=test PORT=3100 node server.js
//   终端2: node scripts/test-model-switch.js --token test [--model <网关模型名>]
//
// --model 用于第三方网关环境（官方模型名不可用时传入网关认的名字，如 mimo-v2.5-pro[1m]）。
// 不传则测官方名（适合直连 Anthropic API 场景）。

import { io } from 'socket.io-client';

const token = process.argv.find(a => a.startsWith('--token='))?.split('=')[1] ||
              process.argv[process.argv.indexOf('--token') + 1] || '';
const customModel = process.argv.find(a => a.startsWith('--model='))?.split('=')[1] ||
                    (process.argv.includes('--model') ? process.argv[process.argv.indexOf('--model') + 1] : '');

console.log('🧪 E8 模型切换验收\n');
if (customModel) console.log(`   自定义模型名：${customModel}\n`);

const socket = io('http://localhost:3100', { auth: { token } });

// 测试步骤：
//   步骤 0：默认模型（无 model 参数）
//   步骤 1：切换到目标模型（customModel 或 claude-opus-4-8）
//   步骤 2：再发一条，确认上下文连续且模型维持
const targetModel = customModel || 'claude-opus-4-8';
const steps = [
  { text: '只回复"OK-0"，不做其他', model: undefined },
  { text: '只回复"OK-1"，不做其他', model: targetModel },
  { text: '只回复"OK-2"，不做其他', model: targetModel }
];
let i = -1;
let passed = 0;
let failed = 0;

function sendNext() {
  i++;
  if (i >= steps.length) {
    console.log(`\n${failed === 0 ? '✅' : '❌'} 完成：${passed} 通过，${failed} 失败`);
    socket.disconnect();
    process.exit(failed > 0 ? 1 : 0);
  }
  const step = steps[i];
  console.log(`\n📋 步骤 ${i}: ${JSON.stringify(step)}`);
  socket.emit('user:message', step);
}

socket.on('connect', () => { console.log('✅ 已连接'); sendNext(); });
socket.on('connect_error', err => { console.log(`❌ 连接失败: ${err.message}`); process.exit(1); });

socket.on('agent:event', ev => {
  if (ev.type === 'init') {
    console.log(`   ℹ️  会话初始化: model=${ev.payload.model}`);
  } else if (ev.type === 'result') {
    const models = ev.payload.models || [];
    const dur = ((ev.payload.durationMs || 0) / 1000).toFixed(1);
    if (i === 0) {
      // 步骤 0 不要求特定模型，只要完成
      console.log(`   ✅ 步骤 0 完成 (${dur}s) models=[${models.join(', ')}]`);
      passed++;
    } else {
      // 步骤 1/2：result.models 必须含目标模型（语义断言，防假实现穿透）
      const ok = models.some(m => m === targetModel || m.includes(targetModel.replace(/\[.*\]/, '')));
      if (ok) {
        console.log(`   ✅ 步骤 ${i} 通过 (${dur}s) models=[${models.join(', ')}]`);
        passed++;
      } else {
        console.log(`   ❌ 步骤 ${i} 失败：result.models=[${models.join(', ')}]，未含期望模型 "${targetModel}"`);
        failed++;
      }
    }
    sendNext();
  } else if (ev.type === 'error') {
    console.log(`   ⚠️  ${ev.payload.message}`);
    if (!ev.payload.recoverable) { failed++; sendNext(); }
  }
});
