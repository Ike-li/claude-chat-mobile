// 已经从离线队列里取出、还没有结论的条目：批处理投递中的，撞上在途轮排队等本轮结束的，续接分叉闸挡下等手动重发的。
// 批处理一开始就把整批移出 offlineQueue，这些条目若只活在内存里，刷新、退出、系统回收标签页之后就没了。
// 它们与 offlineQueue 一起落盘（persistOutbox → dumpDurableOutbox），刷新后由下一次批处理重新投递；
// 投递中途被刷新的那条可能已经到了服务端，重投靠服务端按 clientMessageId 去重（REL-01）。
// 只在有了结论时注销：送达、永久拒收、挪回输入框、重新入队，或用户按了停止（那之后不再自动发）。
export function createOutboxInFlight() {
  const items = new Map(); // clientMessageId → 条目（取最近一次改投后的那份）
  return {
    hold(item) { if (item?.clientMessageId) items.set(item.clientMessageId, item); },
    settle(item) { if (item?.clientMessageId) items.delete(item.clientMessageId); },
    items: () => [...items.values()],
  };
}
