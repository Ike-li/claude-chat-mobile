// bounded-map.js —— Map 容量上限的两种惯用法。
//
// 仓库里曾有 12 处各自手写的「插入时淘汰最旧」，写法分两派：一派先判 size 再腾位再 set，
// 另一派先 set 再看 size 超没超。两派稳态行为其实一致（Map 保插入序，淘汰的都是最旧那条，
// 稳态 size 都等于 cap），差别只有瞬时是否多占一格 —— 对所有调用点都不可观测。
//
// 之所以值得收敛：这个不变量是【安全承诺】而非风格问题。2026-08-03 抓到过一次真实缺口 ——
// rlStates 的 cap 只做在 HTTP 那条写入路径上，socket.io 握手那条是裸 set，绕过上限。
// 每多一份手写拷贝，就多一个「新加的写入入口忘了套上」的机会，而它的失效方式是内存单调增长，
// 长期跑着的实例上要几周才看得出来。收敛成一个函数后，加新表时套不套得上是显式可见的。
//
// 两个函数的区别只在【写入是否刷新位置】，也就是淘汰顺序按插入序还是按最近使用：
//   · setCapped —— FIFO。重复写同一个键不改变它的位置，也不触发淘汰。
//   · setLru    —— LRU。写入即把键移到尾部，冷键先被淘汰。

// FIFO 容量上限：不存在的新键且已满时，先淘汰插入序最靠前的那条，再写入。
// 返回同一个 map 引用（原地改），便于链式写法。
// 调用方保证 cap > 0（现有 DEDUP_CAP/MAX_SESSIONS/TOOL_INPUT_MAX/… 均为正整数）；
// cap<=0 时行为未定义——需要「写了也立即清空」请用 setLru（它有 while 守卫）。
export function setCapped(map, key, value, cap) {
  if (!map.has(key) && map.size >= cap) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
  return map;
}

// LRU 容量上限：写入即把键刷到尾部（先 delete 再 set），超上限时淘汰最久未写/未刷新的。
// 读命中也想刷新位置的调用方，在读路径上自行 delete+set（本模块不介入读）。
export function setLru(map, key, value, cap) {
  map.delete(key);                       // 已存在 → 刷到尾部；不存在 → no-op
  map.set(key, value);
  while (map.size > cap) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;     // 防御：cap<=0 时不空转
    map.delete(oldest);
  }
  return map;
}
