#!/bin/sh
# tests/fixtures/fake-claude.sh —— CI 用的 claude CLI 占位可执行文件。
#
# 默认模式只负责让真实 server 通过 preflight，并吞掉 SDK stdin；它绝不能伪造 turn，避免普通
# integration 用例在不知道的情况下把「fake 成功」当成真实 Agent 行为。
#
# Playground 的 Browser -> Real App E2E 需要再往前走一层，验证真实 Socket/Agent 接线和消息渲染。
# 只有显式设置 CCM_FAKE_CLAUDE_TURNS=1 时，才启用下面的最小 stream-json 协议：
# initialize/user -> system:init + assistant + result。零 token、无网络、回复完全确定。
#
# ⚠️ 默认非 --version 分支必须读完 stdin 再退出，不能直接 exit 0。SDK 会在 spawn 后立刻写控制消息；
# 提前关闭管道会触发 SDK 内部 EPIPE，把本来只想测接线的 integration 进程直接打死。
case "$1" in
  --version|-v)
    echo "0.0.0-fake (Claude Code CI stub)"
    ;;
  *)
    if [ "${CCM_FAKE_CLAUDE_TURNS:-}" = "1" ]; then
      exec node --input-type=module -e '
        import readline from "node:readline";
        import { randomUUID } from "node:crypto";

        const sessionId = randomUUID();
        const model = "claude-fake-test";
        let initialized = false;
        let turn = 0;

        const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
        const sendInit = () => {
          if (initialized) return;
          initialized = true;
          send({
            type: "system", subtype: "init", session_id: sessionId,
            apiKeySource: "none", cwd: process.cwd(), tools: [], mcp_servers: [],
            model, permissionMode: "default", claude_code_version: "0.0.0-fake",
            slash_commands: [], skills: [], agents: [], plugins: [],
          });
        };
        const controlResponse = requestId => send({
          type: "control_response",
          response: { subtype: "success", request_id: requestId, response: {} },
        });
        const extractUserText = message => {
          const content = message?.message?.content;
          if (typeof content === "string") return content;
          if (!Array.isArray(content)) return "";
          return content
            .filter(block => block && block.type === "text" && typeof block.text === "string")
            .map(block => block.text)
            .join("\n");
        };
        const completeTurn = userText => {
          sendInit();
          turn += 1;
          const reply = `CCM deterministic fake reply: ${userText}`;
          const usage = {
            input_tokens: 1,
            output_tokens: Math.max(1, reply.length),
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          };
          send({
            type: "assistant", session_id: sessionId, parent_tool_use_id: null, uuid: randomUUID(),
            message: {
              id: `msg_fake_${turn}`, type: "message", role: "assistant", model,
              content: [{ type: "text", text: reply }], stop_reason: "end_turn",
              stop_sequence: null, usage,
            },
          });
          send({
            type: "result", subtype: "success", is_error: false,
            duration_ms: 1, duration_api_ms: 1, num_turns: 1, result: reply,
            session_id: sessionId, total_cost_usd: 0, usage, modelUsage: {},
            permission_denials: [], uuid: randomUUID(),
          });
        };

        const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
        rl.on("line", line => {
          if (!line.trim()) return;
          let message;
          try { message = JSON.parse(line); }
          catch (error) {
            process.stderr.write(`[fake-claude] invalid JSON: ${error.message}\n`);
            process.exitCode = 1;
            return;
          }
          if (message.type === "control_request") {
            controlResponse(message.request_id);
            if (message.request?.subtype === "initialize") sendInit();
            return;
          }
          if (message.type === "user") completeTurn(extractUserText(message));
        });
      ' "$@"
    fi
    cat > /dev/null 2>&1
    exit 0
    ;;
esac
