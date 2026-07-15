import { shouldDropAgentEvent } from '../logic.js';

export function createAgentEventDispatcher(context, {
  handlers = () => ({}),
  logger = null,
  onEpochReset = () => {},
  onSessionId = () => {},
  outOfBand = {},
} = {}) {
  const log = typeof logger === 'function' ? logger : (logger?.log || (() => {}));
  let streamCharacters = 0;
  let thinkingCharacters = 0;
  let streamingMessageId = null;

  function logEvent(event) {
    const payload = event.payload || {};
    if (event.type === 'init') {
      log('recv', `[WEB_RECV] 初始化 (init): model=${payload.model || ''}, cwd=${payload.cwd || ''}, commandsCount=${payload.slashCommands?.length || 0}`);
    } else if (event.type === 'models') {
      const modelNames = (payload.models || []).map(model => typeof model === 'string' ? model : (model.displayName || model.value)).join(', ');
      log('recv', `[WEB_RECV] 可用模型列表 (models): 共 ${payload.models?.length || 0} 个选项 [${modelNames}]`);
    } else if (event.type === 'result') {
      log('recv', `[WEB_RECV] 结果 (result): isError=${payload.isError || false}, duration=${payload.durationMs}ms, cost=$${payload.costUsd || 0}`);
      if (streamingMessageId) {
        log('stream', `[STREAM] 流式接收完成。共计: 文本 ${streamCharacters} 字符, 思考 ${thinkingCharacters} 字符`);
        streamCharacters = 0;
        thinkingCharacters = 0;
        streamingMessageId = null;
      }
    } else if (event.type === 'error') {
      log('recv', `[WEB_RECV] 错误 (error): ${payload.message || ''}`);
    } else if (event.type === 'system') {
      log('recv', `[WEB_RECV] 系统通知 (system): ${payload.message || ''}`);
    } else if (event.type === 'permission_request') {
      log('recv', `[WEB_RECV] 权限审批请求: tool=${payload.name || ''}`);
    } else if (event.type === 'question') {
      log('recv', `[WEB_RECV] 提问: "${payload.text?.slice(0, 50)}..."`);
    } else if (event.type === 'user_message') {
      log('recv', `[WEB_RECV] 广播用户消息 (user_message): "${payload.text?.slice(0, 50)}${payload.text?.length > 50 ? '...' : ''}" (${payload.text?.length || 0} chars)`);
    } else if (event.type === 'text_delta') {
      if (!streamingMessageId) {
        streamingMessageId = payload.messageId || 'default';
        log('stream', `[STREAM] 启动流式文本段接收 (messageId=${streamingMessageId})`);
      }
      streamCharacters += payload.text?.length || 0;
    } else if (event.type === 'thinking_delta') {
      if (!streamingMessageId) {
        streamingMessageId = payload.messageId || 'default';
        log('stream', `[STREAM] 启动流式思考段接收 (messageId=${streamingMessageId})`);
      }
      thinkingCharacters += payload.text?.length || 0;
    } else if (event.type === 'tool_use') {
      log('recv', `[WEB_RECV] 工具启动: ${payload.name || ''}`);
    } else if (event.type === 'tool_result') {
      log('recv', `[WEB_RECV] 工具返回: toolUseId=${payload.toolUseId || ''}, ok=${payload.ok || false}`);
    }
  }

  return function dispatch(event) {
    const bypass = outOfBand[event.type];
    if (bypass) {
      bypass(event);
      return 'out-of-band';
    }

    const state = context.state;
    if (shouldDropAgentEvent(event, state.viewingInstanceId, state.instancesReady)) return 'dropped';

    if (event.epoch && event.epoch !== 'server') {
      if (event.epoch !== state.curEpoch) {
        state.curEpoch = event.epoch;
        state.lastSeq = 0;
        onEpochReset(event.epoch);
      }
      if (event.seq <= state.lastSeq) return 'duplicate';
      state.lastSeq = event.seq;
    }

    if (event.sessionId && event.sessionId !== state.currentSessionId) {
      state.currentSessionId = event.sessionId;
      onSessionId(event.sessionId);
    }

    logEvent(event);
    handlers()[event.type]?.(event.payload);
    return 'handled';
  };
}
