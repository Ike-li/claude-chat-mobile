// CLI hooks 投递箱的 server 侧装配：监听 events 目录 → 批量消费 → 交给业务回调。
//
// 定位：watch 只是"更快的触发器"，不是新的事实源——真相仍是磁盘（scanHookEvents）与既有的
// catchUpTick 轮询。watch 建不起来（平台限制/句柄耗尽）时功能不缺失，只是退回轮询延迟。
// 监听目录而非文件：事件文件是 tmp+rename 原子写，watch 单个文件会绑在旧 inode 上收不到后续
// 事件（device-gate.js / workdirs.json 都踩过这个坑）。
import { existsSync, watch } from 'node:fs';

import {
  DEFAULT_CLI_HOOKS_ACKS_DIR,
  DEFAULT_CLI_HOOKS_EVENTS_DIR,
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
  rearmMs = 1000,
  logger = console,
} = {}) {
  let watcher = null;
  let timer = null;
  let rearmTimer = null;
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

  // 目录在就盯，不在就等——**不替用户建**（验收 O35）。此前启动就 ensureHooksDirectory 自建，为的是
  // 「先起 server 后装 hooks」免重启；代价是没装过桥、或刚卸载干净的机器，server 一重启 ~/.claude/ccm
  // 又冒出来。现在由下面的定时检查兑现免重启：装上（目录出现）就盯上并立刻扫一遍——安装器的 verify 事件
  // 可能已经落在里面等回执；卸掉（目录被删）就放手——Linux 的 inotify 盯的是 inode，目录删了再建，
  // 旧 watcher 再也收不到，不放手重盯就成了「卸载后重装、server 不重启 = 永远收不到」。
  function arm() {
    if (watcher || closed || !existsSync(eventsDir)) return;
    try {
      watcher = watch(eventsDir, () => schedule());
      watcher.on?.('error', error => logger.warn?.(`[hooks] 投递箱监听出错: ${error?.message || error}`));
      watcher.unref?.();
    } catch (error) {
      watcher = null;
      logger.warn?.(`[hooks] 无法监听投递箱（退化为轮询触发）: ${error?.message || error}`);
      return;
    }
    consume();
  }
  function disarm() {
    try { watcher?.close(); } catch { /* already closed */ }
    watcher = null;
  }

  if (enabled) {
    // 启动全清扫：积压事件零重放——刷镜像由启动后首个 catchUpTick 全量重建覆盖，补推旧通知是噪音。
    try {
      const swept = sweepHookEvents({ dir: eventsDir });
      if (swept) logger.log?.(`[hooks] 启动清扫 ${swept} 条积压事件（不重放）`);
    } catch { /* 目录不存在：桥没装 */ }
    arm();
    rearmTimer = setInterval(() => {
      if (watcher && !existsSync(eventsDir)) disarm();
      arm();
    }, rearmMs);
    rearmTimer.unref?.();
  }

  return {
    scanNow: consume,
    close() {
      closed = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (rearmTimer) { clearInterval(rearmTimer); rearmTimer = null; }
      disarm();
    },
  };
}
