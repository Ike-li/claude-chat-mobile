// jsonl-scan.js —— 逐行扫 JSONL（transcript）的引擎：回显（sessions/history.js）与续接分叉判定
// （sessions/resume-anchor.js）共用。
//
// 自己按 '\n' 切行，不用 readline：在 54MB / 300MB 的真实 transcript 上实测快 1.5–4 倍，行越长差得越多
// （300MB 那份只有 1.2 万行）。顺带交出每行结束处的字节偏移，文件只增长时从这里接着读（4a 增量解析）。
// 与 readline（crlfDelay: Infinity）差两处，都是 readline 当换行、这里不认：
// ① U+2028 / U+2029。JSON.stringify 把它们原样写进字符串，readline 把这样的行切成两半、整条丢掉——
//    这是改用本引擎时顺手修掉的旧 bug（真机 1081 份 transcript 里 4 份共 12 条，2026-10-31）。
// ② 单独的 '\r'。合法 JSON 的字符串里没有裸 '\r'，它只可能夹在 token 之间当空白，CLI 不这么写。
// '\r\n' 的 '\r' 留在行尾，JSON.parse 当空白吃掉。
// 按字节切不会切坏多字节字符：UTF-8 里 0x0A 只会是换行本身。

// 一块 1MB：300MB 那份（平均一行 24KB）比 64KB 快约 25%、比 256KB 快约 10%，54MB 那份三者持平（2026-10-31 实测）。
// 一块解析完才让出事件循环，54MB 那份一块约 3ms。
const DEFAULT_HIGH_WATER_MARK = 1024 * 1024;

/**
 * 从头逐行扫 fh，每个能解析的行 JSON.parse 一次，交给 onEntry(entry, end)。end 是这一行内容结束处的字节偏移
 * （换行符的位置；最后一行没有换行时是扫描范围的末尾）。空行、解析失败的行（写到一半的尾行）跳过。
 * opts.start / opts.end：只扫 [start, end) 这段字节，start 须在行首。返回时（含抛出）fh 已关闭。
 * 返回续读位置：扫过的最后一个换行符之后（一个都没有就是 start）。没有换行的尾行即使解析成功交出去了，
 * 也不算扫过——它可能写到一半，下次从它的行首重扫。
 */
export async function scanJsonl(fh, onEntry, { start = 0, end, highWaterMark = DEFAULT_HIGH_WATER_MARK } = {}) {
  if (end != null && end <= start) { await fh.close(); return start; }
  const stream = fh.createReadStream({ highWaterMark, start, ...(end != null ? { end: end - 1 } : {}) });
  const emit = (text, lineEnd) => {
    let entry;
    try { entry = JSON.parse(text); } catch { return; }
    onEntry(entry, lineEnd);
  };
  let pending = []; // 跨块的半行
  let base = start; // 当前块开头在文件里的偏移
  let resume = start;
  try {
    for await (const chunk of stream) {
      let from = 0, nl;
      while ((nl = chunk.indexOf(10, from)) !== -1) {
        if (pending.length) {
          pending.push(chunk.subarray(from, nl));
          emit(Buffer.concat(pending).toString('utf8'), base + nl);
          pending = [];
        } else if (nl > from) {
          emit(chunk.toString('utf8', from, nl), base + nl);
        }
        from = nl + 1;
      }
      if (from > 0) resume = base + from;
      if (from < chunk.length) pending.push(chunk.subarray(from));
      base += chunk.length;
    }
    if (pending.length) emit(Buffer.concat(pending).toString('utf8'), base);
  } finally {
    stream.destroy(); // 读完已自行关闭；中途抛出（含 onEntry 抛）时也要把句柄关掉
  }
  return resume;
}
