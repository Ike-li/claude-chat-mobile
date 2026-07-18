#!/usr/bin/env node
import { loadRuntimeEnvironment } from './src/server/config.js';
import { installLogTimestamps } from './src/shared/log-time.js';
loadRuntimeEnvironment();
installLogTimestamps(); // 须在动态 import(app.js) 之前——让模块级启动输出也带时间戳
const runtime = await import('./src/server/app.js');
export const httpServer = runtime.httpServer;
export const io = runtime.io;
export const port = runtime.port;
