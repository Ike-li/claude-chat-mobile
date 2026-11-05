// file-tickets.js —— /f/:ticket 的票据与内联白名单
// <video>、<img>、下载都带不了自定义头，又不能把 AUTH_TOKEN 写进 URL，所以由已过设备审批的 socket
// 签发一张短时票据。票据只说明「有台已批准的设备要过这个文件」，取文件时公网身份、设备信任、范围
// 都要重查（见 server/file-ticket-route.js）。只存内存：重启即失效，重新点一下链接就有新的。
import { randomBytes } from 'node:crypto';
import { extname } from 'node:path';

const TICKET_TTL_MS = 30 * 60 * 1000;
const MAX_TICKETS = 200;

const image = mime => ({ mime, media: 'image' });
const video = mime => ({ mime, media: 'video' });
const audio = mime => ({ mime, media: 'audio' });

// FILE-04：只放位图和音视频。html、svg 能带脚本，按 CCM 的源渲染就能读走令牌、操纵审批；
// 不在表里的一律走下载。Content-Type 由这张表定，不看文件内容，配合 nosniff 浏览器也不会改判。
const INLINE_TYPES = new Map([
  ['.png', image('image/png')],
  ['.jpg', image('image/jpeg')],
  ['.jpeg', image('image/jpeg')],
  ['.gif', image('image/gif')],
  ['.webp', image('image/webp')],
  ['.mp4', video('video/mp4')],
  ['.m4v', video('video/mp4')],
  ['.webm', video('video/webm')],
  ['.mov', video('video/quicktime')],
  ['.mp3', audio('audio/mpeg')],
  ['.m4a', audio('audio/mp4')],
  ['.aac', audio('audio/aac')],
  ['.wav', audio('audio/wav')],
  ['.ogg', audio('audio/ogg')],
  ['.opus', audio('audio/ogg')],
  ['.flac', audio('audio/flac')],
]);

export function inlineTypeOf(name) {
  return INLINE_TYPES.get(extname(name).toLowerCase()) ?? null;
}

export function createFileTickets({ now = Date.now } = {}) {
  const tickets = new Map();
  return {
    issue(entry) {
      for (const [ticket, { expiresAt }] of tickets) {
        if (expiresAt <= now()) tickets.delete(ticket);
      }
      // Map 按插入序遍历，第一个就是最老的
      if (tickets.size >= MAX_TICKETS) tickets.delete(tickets.keys().next().value);
      const ticket = randomBytes(32).toString('base64url');
      tickets.set(ticket, { ...entry, expiresAt: now() + TICKET_TTL_MS });
      return ticket;
    },
    lookup(ticket) {
      const entry = tickets.get(ticket);
      return entry && entry.expiresAt > now() ? entry : null;
    },
  };
}
