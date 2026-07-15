// serial-writer.js —— 单写者串行异步写原语（BE-012）。sessions.js / approval-store.js / audit.js 共用。
//
// 问题（三处同款）：防抖 save() 各自 setTimeout → _saveAsync()（写 .tmp → rename），彼此无串行。
//   ① 两次 _saveAsync 的 await 一旦重叠（写盘慢于 200ms 防抖窗），rename 落地顺序不保证——旧快照可能后于
//      新快照 rename、把新态覆盖回旧。
//   ② 同步 flushSaveSync 不 fence 在飞异步写：flush 写完最终态后，在飞 writer 的 rename 再次落地覆盖回旧，
//      丢失 shutdown 时刚产生的终态（如 dispose 里对挂起审批的 deny）。
//
// 本原语把「异步写」串成单写者：
//   · 串行：任一时刻至多一个写在飞（消除 ① 的乱序）。
//   · 合并：写进行中来的多次 request 合并成【一个】尾随写（只需最终态一致，不必每次都落盘）。
//   · fence：flushSaveSync 调 fence() 后，当前在飞写在 rename 前的 shouldCommit() 转 false → 主动放弃提交，
//     不覆盖随后的同步权威写（消除 ② 的常见窗口）。fence 只作废「此刻在飞」的那个写，不永久禁写——
//     fence 之后新来的 request 照常提交。
//
// doWrite(shouldCommit) 由调用方注入（读最新 state 自行序列化 + 原子写 tmp→rename），保持本模块无状态可单测；
// 调用方须在 rename 之前调用 shouldCommit()，为 false 时清理 tmp 并放弃 rename。
//
// 残留已知边界（Low）：若写恰好悬停在 `await rename` 内部（rename 系统调用已发起）时 flushSaveSync 同步写命中，
// 二者在 OS 层竞争——窗口极窄（微秒级），未消除；需要彻底消除可把 shutdown 改为 async 并 await drain()。

export function createSerialWriter(doWrite, { onError } = {}) {
  let running = null;   // 当前在飞写的 Promise（null = 空闲）
  let pending = false;  // 在飞期间是否又来了请求（合并成一个尾随写）
  let epoch = 0;        // fence 计数：每次 fence() 自增，使更早启动的在飞写在提交前作废

  async function loop() {
    do {
      pending = false;                 // 消费掉「截至此刻的所有请求」
      const myEpoch = epoch;           // 本轮写启动时的 epoch
      try {
        await doWrite(() => epoch === myEpoch); // shouldCommit：未被 fence 改动才可提交
      } catch (e) {
        if (onError) onError(e);        // 抛错不 wedge 循环：记录后继续排空
      }
    } while (pending);
    running = null;
  }

  return {
    // 请求一次写（合并 + 串行）。空闲则启动写链，否则标记尾随。
    request() {
      pending = true;
      if (!running) running = loop();
    },
    // 等待写链彻底排空（在飞 + 尾随全部完成）。空闲立即 resolve。
    async drain() {
      while (running) await running;
    },
    // 作废当前在飞写（其 shouldCommit 转 false）。供 flushSaveSync 在同步权威写前调用。
    fence() {
      epoch++;
    },
  };
}
