#!/usr/bin/env node
import { join } from 'node:path';
import { loadRuntimeEnvironment } from './src/ops/config.js';
import { installLogTimestamps } from './src/shared/log-time.js';
// 必须显式传 dir，不回落 loadRuntimeEnvironment 缺省的 process.cwd()：启动方式不保证 cwd
// 落在仓库根（如 systemd 未写 WorkingDirectory=），否则会读到与配置面板不同源的文件、静默假成功。
const HERE = join(import.meta.dirname, '..');
loadRuntimeEnvironment(process.env, { dir: HERE });
installLogTimestamps(); // 须在动态 import(app.js) 之前——让模块级启动输出也带时间戳
const runtime = await import('./src/server/app.js');
export const httpServer = runtime.httpServer;
export const io = runtime.io;
export const port = runtime.port;
