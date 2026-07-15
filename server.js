#!/usr/bin/env node
import { loadRuntimeEnvironment } from './src/server/config.js';
loadRuntimeEnvironment();
const runtime = await import('./src/server/app.js');
export const httpServer = runtime.httpServer;
export const io = runtime.io;
export const port = runtime.port;
