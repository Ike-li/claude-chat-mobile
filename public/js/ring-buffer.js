// ring-buffer.js —— 固定容量环形缓冲区（纯数据→数据，零 DOM/socket 依赖）。
// app.js clientLogBuffer 的数据结构。浏览器 import + node:test 共用。
//
// 用法：
//   const buf = createRingBuffer(100);  // cap=100
//   buf.push(item);                     // 追加，溢出挤掉最旧
//   buf.toArray();                      // 按插入顺序返回副本
//   buf.head(); buf.tail();             // 查看首尾（不取出）
//   buf.size(); buf.isEmpty();          // 尺寸查询
//   buf.clear();                        // 清空
//   buf.capacity();                     // 容量上限

export function createRingBuffer(cap) {
  const max = Math.max(0, cap | 0);
  const buf = [];

  return {
    push(item) {
      if (max === 0) return;
      buf.push(item);
      while (buf.length > max) buf.shift();
    },

    toArray() { return [...buf]; },

    head() { return buf.length ? buf[0] : undefined; },

    tail() { return buf.length ? buf[buf.length - 1] : undefined; },

    size() { return buf.length; },

    isEmpty() { return buf.length === 0; },

    clear() { buf.length = 0; },

    capacity() { return max; },
  };
}
