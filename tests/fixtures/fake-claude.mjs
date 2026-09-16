#!/usr/bin/env node
// tests/fixtures/fake-claude.mjs —— 可驱动的假 CLI（由 fake-claude.sh 在 CCM_FAKE_CLAUDE_MODE
// 显式置位时 exec 进来；不置位时走不到这里，.sh 的默认分支行为逐字不变）。
//
// 【为什么需要它】原 stub 吞掉 stdin、不产出任何输出，于是 S2 层有两条硬约束：
//   ① a.sessionId 恒为 null —— SRV-003 的 `if (a.externalDirty && a.sessionId)` 整条分支不可达；
//   ② 首条消息后 pendingTurns 恒为 1，此后任何第二条有效消息都被 busy 闸挡下 ——
//      SRV-001 的单飞窗口需要「两个并发懒开」，造不出来。
// 2026-09-05 尝试把这两条不变量从源码文本断言搬到 S2 时，都撞在这里。
//
// 【协议不是猜的】把 stub 换成记录 argv+stdin 的版本、跑一次 S2 实测得到：
//   argv: --output-format stream-json --verbose --input-format stream-json
//         --permission-prompt-tool stdio --setting-sources=... --permission-mode default
//         --include-partial-messages
//   stdin（NDJSON）:
//     {"request_id":"…","type":"control_request","request":{"subtype":"initialize",…}}
//     {"type":"user","message":{…},"parent_tool_use_id":null,"session_id":"","uuid":"…"}
//
// 【模式】CCM_FAKE_CLAUDE_MODE：
//   未设置  → 走不到本文件（.sh 的默认分支：吞 stdin、不产出，与 2026-09-05 之前完全一致）
//   init    → 应答 initialize + 首条 user 时吐一条 system/init（带 session_id）。
//             turn 不收尾，实例保持 busy —— 需要「有 sessionId 但仍忙」的用例用这档。
//   turn    → 在 init 之上再吐 assistant 文本与 result，turn 正常收尾、pendingTurns 归零。
//             需要「发得出第二条消息」的用例用这档。
//
// 【它仍然不是真 CLI】不跑模型、不认工具、不落 transcript。任何需要真回合语义的断言仍归 S5。

import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

const MODE = process.env.CCM_FAKE_CLAUDE_MODE || 'init';
// 允许调用方钉死 session_id：镜像 / registry 类用例需要拿这个值去算 transcript 路径。
const SESSION_ID = process.env.CCM_FAKE_CLAUDE_SESSION_ID || randomUUID();
const REPLY = process.env.CCM_FAKE_CLAUDE_REPLY || '(fake-claude) 收到';
// 模型清单。SDK 的 supportedModels() 读的是 **initialize 控制请求响应里的 models 字段**
// （sdk.mjs: `supportedModels(){return(await this.initialization).models}`），不是独立的控制请求——
// 这正是「实例的模型清单在 spawn 那一刻就固化、此后不再向 CLI 问第二次」的物理原因。
// 用 ANTHROPIC_DEFAULT_OPUS_MODEL 造清单而不是新起一个 CCM_FAKE_* 名：agent.js 的
// filterSafeResolvedEnv 只放行 ANTHROPIC_/CLAUDE_CODE_ 前缀，别的名字根本进不到子进程。
// 不置位时 response 仍是 {}，既有 S2 与集成用例建在其上的前提逐字不变（同本文件「显式 opt-in」原则）。
const GATEWAY_MODEL = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL || '';

const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

let announcedInit = false;

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }   // 非 JSON 行忽略，不炸

  // 任何 control_request 一律回 success。不认的子类型也要应答——SDK 在
  // pendingControlResponses 里等着，不回它会把调用方挂死（比产出错内容更难查）。
  if (msg.type === 'control_request') {
    const payload = (msg.request?.subtype === 'initialize' && GATEWAY_MODEL)
      ? { models: [{ value: 'opus', displayName: GATEWAY_MODEL, resolvedModel: GATEWAY_MODEL }] }
      : {};
    out({
      type: 'control_response',
      response: { subtype: 'success', request_id: msg.request_id, response: payload },
    });
    return;
  }

  if (msg.type !== 'user') return;

  if (!announcedInit) {
    announcedInit = true;
    out({
      type: 'system',
      subtype: 'init',
      session_id: SESSION_ID,
      uuid: randomUUID(),
      cwd: process.cwd(),
      tools: [],
      model: 'fake-claude',
      permissionMode: 'default',
    });
  }

  if (MODE !== 'turn') return;

  out({
    type: 'assistant',
    session_id: SESSION_ID,
    uuid: randomUUID(),
    parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'text', text: REPLY }] },
  });
  // user_message_uuid 原样回传：agent.js 的 _settleOneResultTurn 优先按 uuid 精确出槽，
  // 回传得对就不必依赖 FIFO 回落。
  out({
    type: 'result',
    subtype: 'success',
    session_id: SESSION_ID,
    uuid: randomUUID(),
    user_message_uuid: msg.uuid ?? null,
    is_error: false,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    result: REPLY,
    total_cost_usd: 0,
  });
});

// 读到 EOF 才退。提前退出会让 SDK 那次 write 抛 EPIPE，而它在 sdk.mjs 内部不被 catch，
// 直接冒成 uncaughtException 打死整个测试进程（原 .sh 的头注记录过这次事故）。
rl.on('close', () => process.exit(0));
