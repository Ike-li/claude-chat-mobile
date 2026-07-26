// CLI hooks 投递箱的 server 侧装配：监听 events 目录 → 批量消费 → 交给业务回调。
//
// 定位：watch 只是"更快的触发器"，不是新的事实源——真相仍是磁盘（scanHookEvents）与既有的
// catchUpTick 轮询。watch 建不起来（平台限制/句柄耗尽）时功能不缺失，只是退回轮询延迟。
// 监听目录而非文件：事件文件是 tmp+rename 原子写，watch 单个文件会绑在旧 inode 上收不到后续
// 事件（device-gate.js / workdirs.json 都踩过这个坑）。
import { watch } from 'node:fs';

import {
  DEFAULT_CLI_HOOKS_ACKS_DIR,
  DEFAULT_CLI_HOOKS_EVENTS_DIR,
  ensureHooksDirectory,
  isVerifyEvent,
  scanHookEvents,
  sweepHookEvents,
  writeHookVerifyAck,
} from '../ops/cli-hooks-bridge.js';

export function createHooksInbox({
  eventsDir = DEFAULT_CLI_HOOKS_EVENTS_DIR,
  acksDir = DEFAULT_CLI_HOOKS_ACKS_DIR,
  enabled = true,
  onEvents = () => {},
  debounceMs = 100,
  logger = console,
} = {}) {
  let watcher = null;
  let timer = null;
  let closed = false;

  function consume() {
    if (!enabled || closed) return;
    let events;
    try {
      ({ events } = scanHookEvents({ dir: eventsDir }));
    } catch (error) {
      logger.warn?.(`[hooks] 扫描投递箱失败: ${error?.message || error}`);
      return;
    }
    if (!events.length) return;
    // verify 事件在这层就地回执：安装器只想知道"server 消费到了"，不该触发推送/刷新。
    const business = [];
    for (const event of events) {
      if (isVerifyEvent(event)) {
        try { writeHookVerifyAck(event.sessionId, { dir: acksDir }); }
        catch (error) { logger.warn?.(`[hooks] 写验证回执失败: ${error?.message || error}`); }
        continue;
      }
      business.push(event);
    }
    if (!business.length) return;
    try {
      onEvents(business);
    } catch (error) {
      // 业务回调出错绝不能掀翻 inbox：事件已从磁盘消费掉，下一批仍要正常处理
      logger.warn?.(`[hooks] 事件处理回调失败: ${error?.message || error}`);
    }
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(() => { timer = null; consume(); }, debounceMs);
    timer.unref?.();
  }

  if (enabled) {
    // 启动全清扫：积压事件零重放——刷镜像由启动后首个 catchUpTick 全量重建覆盖，补推旧通知是噪音。
    try {
      const swept = sweepHookEvents({ dir: eventsDir });
      if (swept) logger.log?.(`[hooks] 启动清扫 ${swept} 条积压事件（不重放）`);
    } catch { /* 目录不存在：安装器建 */ }
    try {
      // 目录必须先存在 watch 才建得起来；自建它让"先起 server 后装 hooks"也能立刻生效、免重启
      ensureHooksDirectory(eventsDir);
      watcher = watch(eventsDir, () => schedule());
      watcher.on?.('error', error => logger.warn?.(`[hooks] 投递箱监听出错: ${error?.message || error}`));
      watcher.unref?.();
    } catch (error) {
      // 目录尚不存在（未安装）也走这里：不报错、不重试，装完重启 server 即可
      logger.warn?.(`[hooks] 无法监听投递箱（退化为轮询触发）: ${error?.message || error}`);
    }
  }

  return {
    scanNow: consume,
    close() {
      closed = true;
      if (timer) { clearTimeout(timer); timer = null; }
      try { watcher?.close(); } catch { /* already closed */ }
      watcher = null;
    },
  };
}
