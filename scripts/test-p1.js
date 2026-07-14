#!/usr/bin/env node
// 手动验收脚本：E7（AskUserQuestion）与 E13（会话列表）
// 用法：
//   终端1: AUTH_TOKEN=test PORT=3100 WORK_DIR=/tmp/ccm-test node server.js
//   终端2: node scripts/test-p1.js --token test

import { io } from 'socket.io-client';

const token = process.argv.find(a => a.startsWith('--token='))?.split('=')[1] ||
              process.argv[process.argv.indexOf('--token') + 1] || '';

console.log('🧪 P1 功能验收：E7（AskUserQuestion）+ E13（会话列表）\n');

const socket = io('http://localhost:3100', { auth: { token } });
let passed = 0, failed = 0;

socket.on('connect', () => {
  console.log('✅ 已连接\n');

  // 测试 E13：会话列表
  console.log('📋 测试 E13：会话列表');
  socket.emit('session:list', state => {
    if (state?.sessions && Array.isArray(state.sessions)) {
      console.log(`✅ 会话列表返回成功（${state.sessions.length} 个会话）`);
      if (state.sessions.length > 0) {
        const s = state.sessions[0];
        console.log(`   首个会话: ${s.title || '无标题'} (${new Date(s.lastUsedAt).toLocaleString()})`);
      }
      passed++;
    } else {
      console.log('❌ 会话列表格式错误');
      failed++;
    }

    // 测试 E7 需要 Claude 主动调用 AskUserQuestion，这里只验证事件响应
    console.log('\n📋 测试 E7：AskUserQuestion 通道存活');
    console.log('   （真实解析需真实 Claude 对话触发 AskUserQuestion + 真 requestId，那需真 token；此处仅验证通道）');

    // 总结（抽成函数：改由 E7 round-trip 的 ack 触发，不再靠固定 500ms 定时器）
    let summarized = false;
    const summarize = () => {
      if (summarized) return; summarized = true;
      console.log(`\n${'='.repeat(50)}`);
      console.log(`验收结果: ${passed} 通过 / ${failed} 失败`);
      console.log('\n📝 手动验收步骤（浏览器）:');
      console.log('1. E13：点击顶栏"会话"按钮 → 应显示会话列表下拉面板');
      console.log('2. E13：点击某个会话 → 应切换并清空消息区');
      console.log('3. E7：发消息触发 Claude 调用 AskUserQuestion → 应弹出选项按钮');
      console.log('   （例如："帮我选择一个方案"，Claude 可能会用 AskUserQuestion）');
      socket.disconnect();
      process.exit(failed > 0 ? 1 : 0);
    };

    // WS-018：旧实现向【硬编码假 requestId 'test_q'】发 answer，服务端对未知 requestId 是 no-op、无 ack，
    // 却无条件 passed++——纯假绿（无论服务端是否真处理都"通过"）。真实解析需真实 pending question（真 token）。
    // 零 token 下唯一可确证的真实信号：发一条 answer 后，用一次真实 session:list round-trip 断言【通道仍响应】
    // （服务端处理未知 answer 未崩、socket 存活）。真实 AskUserQuestion 解析验证留给上面的手动步骤 / 真实对话。
    let e7Done = false;
    const finishE7 = alive => {
      if (e7Done) return; e7Done = true;
      if (alive) { console.log('✅ E7 通道存活：发送 user:answer 后服务端仍响应'); passed++; }
      else { console.log('❌ E7 通道异常：user:answer 后 session:list 无有效响应'); failed++; }
      summarize();
    };
    socket.emit('user:answer', { requestId: 'nonexistent_no_pending_q', optionIndex: 0 }); // 无对应 pending → 服务端 no-op
    socket.emit('session:list', state => finishE7(!!(state && Array.isArray(state.sessions))));
    setTimeout(() => finishE7(false), 3000); // 兜底：3s 内无 ack 视为通道异常
  });
});

socket.on('connect_error', err => {
  console.log(`❌ 连接失败: ${err.message}`);
  console.log('   请确认 server.js 运行在 3100 端口且 AUTH_TOKEN=test');
  process.exit(1);
});
