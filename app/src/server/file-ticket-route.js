// GET /f/:ticket —— 本机文件字节的 HTTP 出口。socket 传不了：视频要 Range，整份进手机内存放不下。
// 票据（files/file-tickets.js）不是通行证：公网身份、设备信任、范围每次请求都重查，吊销设备、断开文件夹后
// 下一个请求就取不到（已经在传的响应会传完）。不用 res.sendFile：它拿不到 O_NOFOLLOW（FILES-3），默认还忽略点目录。
// 失败只回裸状态码，也不走 httpAuth 的限速桶：票据 256 位暴破不动，而过期票据的重试会把自己的 IP 锁掉。
import { closeSync, createReadStream } from 'node:fs';
import { pipeline } from 'node:stream';
import { openInScope } from '../files/file-browse.js';
import { inlineTypeOf } from '../files/file-tickets.js';

export function registerFileTicketRoute({ app, tickets, strategy, isDeviceTrusted, scopeRootsFor }) {
  app.get('/f/:ticket', async (req, res) => {
    const entry = tickets.lookup(req.params.ticket);
    if (!entry) return res.sendStatus(404);
    if (strategy.ownsHost(req.headers.host)) {
      try {
        await strategy.verifyRequest(req.headers);
      } catch {
        return res.sendStatus(401);
      }
    }
    // 没有 deviceToken 的是 bypass 连接签发的（真本机 / CF Access），它们本来就不在信任表里
    if (entry.deviceToken && !isDeviceTrusted(entry.deviceToken)) return res.sendStatus(403);

    const opened = openInScope(entry.cwd, entry.relPath, scopeRootsFor(entry.cwd));
    if (opened?.fd === undefined) return res.sendStatus(404);
    const { fd, size } = opened;

    const ranges = req.range(size);
    if (ranges === -1) {
      closeSync(fd);
      res.setHeader('Content-Range', `bytes */${size}`);
      return res.sendStatus(416);
    }
    // 多段要发 multipart，媒体元素用不到，规范允许退回整份；畸形的 Range 同样忽略
    const range = ranges?.length === 1 && ranges.type === 'bytes' ? ranges[0] : null;

    const inline = req.query.download === undefined ? inlineTypeOf(entry.name) : null;
    if (inline) res.type(inline.mime);
    else res.attachment(entry.name).type('application/octet-stream');
    // no-transform 不能省：compressible('application/octet-stream') 为 true，全局 compression() 会把
    // 下载类响应压缩掉，Content-Length 和 Range 都跟着失效。
    res.setHeader('Cache-Control', 'private, no-store, no-transform');
    res.setHeader('Content-Security-Policy', 'sandbox');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', range ? range.end - range.start + 1 : size);
    if (range) res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    res.status(range ? 206 : 200);

    if (req.method === 'HEAD' || size === 0) {
      closeSync(fd);
      return res.end();
    }
    // 只发 Content-Length 那么多，不读到 EOF：边写边下的文件（录屏、日志）多出来的字节会落进 keep-alive 连接。
    // 拖动时浏览器频繁中断连接，pipeline 保证中断时销毁读流、关掉 fd
    const { start, end } = range ?? { start: 0, end: size - 1 };
    pipeline(createReadStream(null, { fd, start, end }), res, () => {});
  });
  // /f/%ff 解码失败到不了上面的 handler，会落到 Express 默认错误页，堆栈里全是本机绝对路径
  app.use('/f', (err, _req, res, _next) => res.sendStatus(err.status ?? 500));
}
