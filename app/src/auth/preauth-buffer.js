// preauth-buffer.js —— 鉴权前后两档单包上限（验收 O84 / AC-22-15）
//
// 附件随 user:message 走 socket（files/uploads.js：解码后总量 20MB，base64 上线约 27MB），所以已鉴权连接要
// 32MB 的单包上限。但 engine.io 的 maxHttpBufferSize 对所有连接一视同仁：任何人不带凭据就能拿到 sid，往轮询
// POST 里塞到 32MB，或直连 websocket 发一个 30MB 的帧——在被 413 拒掉或被 socket.io 判成非法之前，整包已经
// 缓冲、占过内存。容器实测（S2，真 server）8 路并发之后 RSS 从 115MB 涨到 870MB，静置 20 秒不回落。
//
// 鉴权前合法的流量只有 engine.io 握手和 socket.io 的 CONNECT 包（auth 里是令牌与设备令牌，几百字节），
// 客户端缓冲的业务事件要等 CONNECT 被接受之后才发。所以全局上限压到 PREAUTH，鉴权通过的那一刻再把这条
// 连接抬回 AUTHED。
//
// 【为什么不在 engine.io 握手（allowRequest）时就验凭据】令牌在 socket.io 的 CONNECT 包里，握手请求里没有；
// 要么改协议把令牌放进 URL（进访问日志），要么另起一套 cookie 会话——都比这里的问题大。
// 【为什么 websocket 要碰 ws 的内部字段】ws 的 maxPayload 只能在 WebSocketServer 构造时给，没有按连接调整的
// 公开接口；而直连 websocket 的客户端（集成测试就是这样连的）握手时还没鉴权，握手之后又换不了服务器。
// 字段名在 ws 8.x 里稳定；万一改了，这里抛错，tests/integration/preauth-buffer-limit.test.mjs 的已鉴权用例会红。

export const PREAUTH_MAX_BUFFER_BYTES = 64 * 1024;
export const AUTHED_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

const granted = new WeakSet();

function applyLimit(transport, bytes) {
  if (transport?.name === 'polling') {
    // engine.io 自己在建传输层时就是这样赋值的（server.js handshake），每个 POST 现读这个属性
    transport.maxHttpBufferSize = bytes;
    return;
  }
  if (transport?.name === 'websocket') {
    const ws = transport.socket;
    if (typeof ws?._receiver?._maxPayload !== 'number') {
      throw new Error('[preauth-buffer] ws 的内部结构变了（_receiver._maxPayload 不存在），已鉴权连接的单包上限抬不上去');
    }
    ws._receiver._maxPayload = bytes;
    // 压缩帧的解压上限是另一份：permessage-deflate 实例按连接创建，构造时抄了一份 maxPayload
    const deflate = ws._extensions?.['permessage-deflate'];
    if (deflate) deflate._maxPayload = bytes;
  }
}

// conn：engine.io 的 Socket（socket.io 里是 socket.conn）。幂等；之后升级出来的新传输层同样抬上去。
export function grantAuthedBufferLimit(conn, bytes = AUTHED_MAX_BUFFER_BYTES) {
  if (!conn || granted.has(conn)) return;
  granted.add(conn);
  applyLimit(conn.transport, bytes);
  conn.on('upgrade', transport => applyLimit(transport, bytes));
}
