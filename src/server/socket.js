// 末参若是 function 则视为 socket.io ack（emit(event, payload, ack)）。SRV-NEW-005：handler 抛错时
// 必须负 ack，否则前端 timeout/offline 队列会把请求当 in-flight 永久挂起。
export function extractSocketAck(args) {
  if (!Array.isArray(args) || args.length === 0) return null;
  const last = args[args.length - 1];
  return typeof last === 'function' ? last : null;
}

export function createSocketEventRegistrar({ logger = console } = {}) {
  return function on(socket, event, handler) {
    socket.on(event, async (...args) => {
      const ack = extractSocketAck(args);
      try {
        if (socket.deviceApproved === false) {
          logger.warn(`[devices] 丢弃未授权设备 ${socket.handshake.auth?.deviceToken || 'Unknown'} 的业务事件: ${event}`);
          // 未批准设备：若带 ack 也负回，避免客户端空等（与业务丢弃一致，permanent 以免离线死循环重试）
          if (ack) {
            try { ack({ ok: false, error: 'device_not_approved', permanent: true }); } catch { /* 忽略二次抛 */ }
          }
          return;
        }
        await handler(...args);
      } catch (error) {
        logger.error(`[handler:${event}]`, error);
        socket.emit('agent:event', {
          seq: 0,
          epoch: 'server',
          sessionId: null,
          ts: Date.now(),
          type: 'error',
          payload: {
            message: `服务端处理 ${event} 出错：${error.message}`,
            recoverable: true,
          },
        });
        // SRV-NEW-005：结构化负 ack（retryable——未知错误客户端可重试）；ack 本身抛错不掩盖主路径
        if (ack) {
          try {
            ack({ ok: false, error: error?.message || String(error), retryable: true });
          } catch { /* 忽略 */ }
        }
      }
    });
  };
}

export function registerSocketConnection(io, handler) {
  io.on('connection', handler);
}
