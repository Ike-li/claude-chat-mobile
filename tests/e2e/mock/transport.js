import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_DIR = join(HERE, '..', '..', '..', 'public');
const DEFAULT_REJECTED_TOKENS = ['bad-token', 'invalid-token', 'expired-token'];

function javascriptFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...javascriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(path);
  }
  return files.sort();
}

export function computeMockAssetVersion(publicDir = DEFAULT_PUBLIC_DIR) {
  const hash = createHash('sha256');
  for (const path of javascriptFiles(join(publicDir, 'js'))) {
    hash.update(readFileSync(path));
  }
  hash.update(readFileSync(join(publicDir, 'css', 'app.css')));
  return hash.digest('hex').slice(0, 8);
}

export function createMockTransport({
  publicDir = DEFAULT_PUBLIC_DIR,
  buildNonce = process.env.CCM_BUILD_NONCE || null,
  rejectedAuthTokens = DEFAULT_REJECTED_TOKENS,
} = {}) {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, { cors: { origin: '*' } });
  const rejectedTokens = new Set(rejectedAuthTokens);
  const jsDir = join(publicDir, 'js');
  const assetVersion = computeMockAssetVersion(publicDir);

  io.use((socket, next) => {
    if (rejectedTokens.has(socket.handshake.auth?.token)) {
      next(new Error('unauthorized'));
      return;
    }
    next();
  });

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  app.get('/__ready', (req, res) => {
    const requestedNonce = req.query?.nonce;
    if (requestedNonce !== undefined && requestedNonce !== buildNonce) {
      return res.status(409).json({ ok: false, nonce: buildNonce });
    }
    res.json({ ok: true, nonce: buildNonce });
  });

  app.get(['/', '/index.html'], (_req, res) => {
    try {
      const html = readFileSync(join(publicDir, 'index.html'), 'utf8')
        .replace(/(\/(?:js|css)\/[\w./-]+\.(?:js|css))(?!\?)/g, `$1?v=${assetVersion}`)
        .replace('</head>', '<script>window.SERVER_CF_ACCESS_ENABLED = false;</script></head>');
      res.setHeader('Cache-Control', 'no-store');
      res.type('html').send(html);
    } catch (error) {
      res.status(500).send(`index load error: ${error.message}`);
    }
  });

  app.get('/js/app.js', (_req, res) => {
    try {
      const source = readFileSync(join(jsDir, 'app.js'), 'utf8')
        .replace(/from\s+(['"])(\.\/[\w./-]+\.js)\1/g, `from '$2?v=${assetVersion}'`);
      res.setHeader('Cache-Control', 'no-cache');
      res.type('application/javascript').send(source);
    } catch (error) {
      res.status(500).send(`app.js load error: ${error.message}`);
    }
  });

  app.use(express.static(publicDir, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
      else if (filePath.startsWith(jsDir) && filePath.endsWith('.js')) res.setHeader('Cache-Control', 'no-cache');
    },
  }));

  return { app, httpServer, io, assetVersion };
}
