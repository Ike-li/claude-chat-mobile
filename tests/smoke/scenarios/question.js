#!/usr/bin/env node
// E7 AskUserQuestion 验收脚本
// 用法：
//   node tests/smoke/runner.js --scenario question
//
// 语义断言：模型回答中须包含我们选择的选项文本（防 deny+message 通道失效）

import { io } from 'socket.io-client';

const tokenIndex = process.argv.indexOf('--token');
const token = process.argv.find(a => a.startsWith('--token='))?.slice('--token='.length) ||
              (tokenIndex >= 0 ? process.argv[tokenIndex + 1] || '' : '') ||
              process.env.AUTH_TOKEN || '';

console.log('🧪 E7 AskUserQuestion 选择题验收\n');

const smokeUrl = process.env.CCM_SMOKE_URL || `http://127.0.0.1:${process.env.PORT || 3100}`;
const socket = io(smokeUrl, { auth: { token } });
let passed = 0;
let failed = 0;
let assistantText = '';
let questionReceived = false;
let answerLabel = '';

socket.on('connect', () => {
  console.log('✅ 已连接');
  console.log('📋 发送：要求模型用 AskUserQuestion 提问');
  // 用语言中立的代号选项（专有名词），模型无论用何种语言回复都会原样回显，
  // 避免断言因翻译失败（如英文 "Yes" 被网关中文模型复述成"是的"）造成假阴性。
  socket.emit('user:message', {
    text: 'Use the AskUserQuestion tool to ask me to choose between two codenames: FALCON or PENGUIN (use these exact words as the two options). After I choose, repeat my exact choice back to me verbatim.'
  });
});
socket.on('connect_error', err => { console.error(`❌ 连接失败: ${err.message}`); process.exit(1); });

socket.on('agent:event', ev => {
  if (ev.type === 'question') {
    const p = ev.payload;
    console.log(`\n❓ 收到选择题 requestId=${p.requestId}`);
    console.log(`   题目：${p.text}`);
    console.log(`   选项：${p.options.join(' / ')}`);
    questionReceived = true;

    // 自动选择第一个选项
    const idx = 0;
    answerLabel = p.options[idx] || String(idx);
    console.log(`   ➜ 自动选择选项 ${idx}：「${answerLabel}」`);
    socket.emit('user:answer', { requestId: p.requestId, optionIndex: idx });

  } else if (ev.type === 'text_delta') {
    assistantText += ev.payload.text;

  } else if (ev.type === 'result') {
    const dur = ((ev.payload.durationMs || 0) / 1000).toFixed(1);
    console.log(`\n📝 模型回复：\n   "${assistantText.trim().slice(0, 200)}"`);

    if (!questionReceived) {
      console.log(`❌ 失败：模型未调用 AskUserQuestion（question 事件未触发）`);
      failed++;
    } else if (assistantText.toLowerCase().includes(answerLabel.toLowerCase())) {
      console.log(`✅ 通过：assistant 回复中包含所选选项「${answerLabel}」（${dur}s）`);
      passed++;
    } else {
      console.log(`❌ 失败：assistant 回复未包含「${answerLabel}」——deny+message 通道可能失效`);
      failed++;
    }
    console.log(`\n${failed === 0 ? '✅' : '❌'} 完成：${passed} 通过，${failed} 失败`);
    socket.disconnect();
    process.exit(failed > 0 ? 1 : 0);

  } else if (ev.type === 'error' && !ev.payload.recoverable) {
    console.error(`❌ 不可恢复错误：${ev.payload.message}`);
    socket.disconnect();
    process.exit(1);
  }
});
