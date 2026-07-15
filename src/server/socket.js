export function createSocketEventRegistrar({ logger = console } = {}) {
  return function on(socket, event, handler) {
    socket.on(event, async (...args) => {
      try {
        if (socket.deviceApproved === false) {
          logger.warn(`[devices] 丢弃未授权设备 ${socket.handshake.auth?.deviceToken || 'Unknown'} 的业务事件: ${event}`);
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
      }
    });
  };
}

export function registerSocketConnection(io, handler) {
  io.on('connection', handler);
}
