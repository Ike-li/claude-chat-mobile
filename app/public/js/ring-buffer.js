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
  // 真环形：固定数组 + head/len，驱逐 O(1)，避免 Array.shift 的 O(n)
  const slots = max > 0 ? new Array(max) : null;
  let head = 0;
  let len = 0;

  return {
    push(item) {
      if (max === 0) return;
      if (len < max) {
        slots[(head + len) % max] = item;
        len++;
      } else {
        slots[head] = item;
        head = (head + 1) % max;
      }
    },

    toArray() {
      if (!len) return [];
      const out = new Array(len);
      for (let i = 0; i < len; i++) out[i] = slots[(head + i) % max];
      return out;
    },

    head() { return len ? slots[head] : undefined; },

    tail() { return len ? slots[(head + len - 1) % max] : undefined; },

    size() { return len; },

    isEmpty() { return len === 0; },

    clear() { head = 0; len = 0; if (slots) slots.fill(undefined); },

    capacity() { return max; },
  };
}
