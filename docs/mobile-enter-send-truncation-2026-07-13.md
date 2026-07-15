# 移动端「回车换行被当成发送、长内容截断」排查报告

## 1. 文档控制

| 项目 | 值 |
| --- | --- |
| 排查日期 | 2026-07-13 |
| 代码快照 | `dev@46319750a3f7dce7ef78d4f6610de7e944085c32`（含工作区未提交改动） |
| 现象来源 | 机主报告：手机 web 端输入过长内容会被截断，桌面浏览器正常 |
| 排查方式 | 代码静态分析 + puppeteer 移动端 viewport（375×812, isMobile, hasTouch）复用 `scripts/visual-mock-server.js` 实测复现 |
| 结论 | **主因**：回车键语义在移动端错误地把「换行」当成「发送」（非视觉截断、非数据层截断）。**另附次要真问题**：长文本输入框达上限后滚动/显示缺陷（GPT 交叉排查印证，见 §7） |
| 修复状态 | **§8.1（主因）已实施（2026-07-14，工作区未提交）**；§8.2（次要滚动/显示缺陷）未做，机主本轮明确只要求先修 §8.1。实施：`public/js/logic.js` 新增纯函数 `shouldSendOnEnter`（触摸设备下回车恒不发送）+ `public/js/app.js:1979-1991` 接线（`matchMedia('(pointer: coarse)')`/`maxTouchPoints` 判触摸、动态 `enterKeyHint`）。验证：`test/logic.test.mjs` 单测 5 例 + `scripts/visual-e2e-runner.js` 新增 TC-23（移动 viewport 真实按键回归：回车后 `#input.value` 保留两行未被清空/截断）；`npm test`/`npm run test:visual`/`npm run check` 均过。生产 server 尚未重启，线上未生效。 |

## 2. TL;DR

一句话根因：输入框的 `keydown` 处理器把**任何非 Shift 的回车都当作发送**（`app.js:1956`），配合 `enterkeyhint="send"`（`index.html:943`）。桌面用户靠 **Shift+Enter** 换行来规避发送；但**手机软键盘没有 Shift+Enter 组合**，用户按回车想「换行分段」时 `e.shiftKey === false`，条件命中 → 立即 `send()`。结果：想发的多行长消息，在第一个换行处就被单独发出，Claude 只收到换行前的前半段——表现为「换行被截断 / 内容一多就自动发送」。

## 3. 现象（机主精确描述）

- 桌面版：换行正常，多行内容能完整发送。
- 手机端：**换行则被截断**；或**内容多的时候会自动发送出去**。
- 后果：发送到达时，**Claude 只收到被截断的前半段内容**。
- 关键判别信息：截断是「发送出去、看到 Claude 回复」后才发现的 —— 即**数据真的没送全**，不是显示看不全。

## 4. 根因分析

### 4.1 触发代码

```js
// public/js/app.js:1953-1961
let composing = false;
inputEl.addEventListener('compositionstart', () => { composing = true; });
inputEl.addEventListener('compositionend', () => { composing = false; });
inputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229 && !composing) {
    e.preventDefault();
    send();              // ← 非 Shift 的回车一律发送
  }
});
```

```html
<!-- public/index.html:943 -->
<textarea id="input" rows="1" placeholder="给 Claude 发消息..." enterkeyhint="send" ...>
```

### 4.2 机制：为什么桌面正常、手机截断

发送逻辑只认「Enter 且未按 Shift」。这套「Enter 发送 / Shift+Enter 换行」是**桌面物理键盘**的约定：

- **桌面**：想换行 → 按住 Shift 再回车 → `e.shiftKey === true` → 不满足发送条件 → textarea 正常插入 `\n`，多行内容完整保留，最后一次性发送。**换行有「逃生舱」。**
- **手机**：软键盘上**不存在 Shift+Enter 这个组合手势**。用户想在长文本里换行/分段，只能按回车键 → `e.shiftKey === false` → 条件命中 → `preventDefault()` + `send()` 立刻把当前内容发出去。**换行没有逃生舱，任何回车都是发送。**

因此：桌面用户能打出多行长消息完整送达；手机用户每次想换行都会触发一次提前发送，把「本应是一条的多行长消息」在换行处切断，Claude 只收到第一段。这精确对应机主说的「换行被截断」和「内容多时自动发送」（内容多 → 自然需要换行分段 → 一换行就发出去了）。

`enterkeyhint="send"` 是加剧因素：它把移动键盘的回车键标注为「发送」动作键，一方面强化误发，另一方面会让部分 IME 把回车作为 action 直接派发 `keydown Enter`（而非插入换行符），使问题更稳定复现。

### 4.3 与 CLI 等价性的关系

CLAUDE.md 要求「CLI 有什么 web 就有什么」。但终端里「回车=提交、多行靠粘贴/续行」是**桌面终端**语义，不能原样搬到触摸设备。移动 IM 的通行约定恰恰相反：**手机上回车=换行，发送靠独立的发送按钮**（微信、Telegram、WhatsApp 移动端皆如此）。当前代码把桌面语义无差别套到手机，缺了移动端该有的「回车换行」，才是这个 bug 的本质。

## 5. 复现证据（puppeteer 移动 viewport 实测）

模拟手机用户输入两行：打「第一行内容」→ 按 `Enter`（意图换行）→ 打「第二行内容」，同时 hook `WebSocket.prototype.send` 捕获真实发送帧：

| 观测点 | 实测值 | 含义 |
| --- | --- | --- |
| 按 Enter 后 `#input.value` | `""`（空） | 回车触发了发送，输入框被清空 |
| 实际发出的 `text` | `["第一行内容"]` | **只发出前半段**，第二行从未随该消息送达 |
| 之后 `#input.value` | `"第二行内容"` | 第二行沦为孤立的下一条输入 |

桌面对照（Shift+Enter）：打「甲」→ Shift+Enter → 打「乙」：

| 观测点 | 实测值 | 含义 |
| --- | --- | --- |
| `#input.value` | `"甲\n乙"`（未清空、未发送） | Shift+Enter 正确换行、不触发发送 |

复现脚本为一次性排查工具，已随排查结束删除（未纳入测试套件）。

## 6. 已排除的假设（排查过程留痕，避免重复走弯路）

初次按「过长截断」字面排查时，曾实测排除以下方向：

| 被排除假设 | 实测/代码证据 | 结论 |
| --- | --- | --- |
| 数据层 `value` 截断 | 键盘逐字输入 1000 字 → `value.length === 1000`；注入 8000/60000 字 → `value.length` 完整；发送帧长 8017（含完整 8000 字） | textarea 不因长度丢内容 |
| `text.length > 50000` 门槛截断 | 该分支是**拒发并报错**（`app.js:1870`），不是截断；且拒发后 `value` 完整保留（实测 60000 未变短） | 与本 bug 无关 |
| CSS `max-height:144px` 视觉截断 | `clientHeight=144` 而 `scrollHeight=5494/41062`，超出部分需内部滚动、滚动条被 `#input::-webkit-scrollbar{display:none}` 隐藏 | 真实存在「看不全」的体感，但**不丢数据**，非本次「内容被截断送达」的主因（机主已确认是发送后 Claude 收到残缺）。但它本身是个独立真缺陷，见 §7 |

关键：`max-height` 视觉封顶**不是**本次「内容被截断送达」的主因（主因是回车语义，见 §4）；但它本身是一个**独立、真实、值得一并修复的次要缺陷**——长文本在手机上难以滚动查看。详见 §7。

## 7. 次要独立问题：长文本输入框的显示/滚动缺陷（GPT 交叉排查印证）

一次独立的第三方（GPT）只读排查，核对了同样的事实（无 `maxlength`、发送不 slice、50000 是拒发），但**主结论判定为「纯视觉/滚动缺陷、内容仍完整躺在 `value` 里」——该主结论与机主现象矛盾、不成立**：视觉滚动缺陷无法解释机主明确描述的「**自动发送出去**」和「**Claude 收到残缺**」（若内容完整留在 `value`，点一次发送必然发出完整内容）。它漏检了 `keydown Enter → send()` 这条真正的触发链。

不过该排查**准确地指出了一个真实的次要缺陷**，值得单独登记与修复：

- `autosize()`（`app.js:2151`）把高度封顶 144px（`Math.min(scrollHeight, 144)`），Tailwind 又叠加 `max-h-36`+`resize-none`（`index.html:944`）；
- 达到上限后**没有显式定义内部滚动行为**（无显式 `overflow-y`），滚动条被 `#input::-webkit-scrollbar{display:none}` 隐藏（`index.html:417`）；
- iOS Safari/PWA 下叠加固定高度 flex 布局 + `visualViewport` 动态改 footer padding + textarea 内外滚动手势竞争，**光标所在行不能稳定滚入可见区**；
- 净效果：内容确实都在 `value` 里，但超出 144px 后手机端难以滚动查看末尾/光标位置，主观像「后面看不见」。这是**可用性缺陷**，独立于主 bug，两者互不为因果，但会叠加恶化长文本体验。

## 8. 修复方向（8.1 已实施，8.2 建议未实施）

> 注：8.1 与 8.2 相互独立，可分别实施。2026-07-14：机主确认先做 8.1；`public/js/app.js` 当时的并发改动（服务状态可见性功能）与输入框/发送逻辑无交集，未构成冲突。

### 8.1 主因修复：移动端回车语义（`app.js:1956` + `index.html:943`）—— ✅ 已实施（2026-07-14）

核心：在移动/触摸设备上让**回车 = 换行**，发送只走发送按钮；桌面保持 Enter 发送 / Shift+Enter 换行。

1. **区分设备语义**（`app.js:1956` keydown 处理器）：
   - 触摸设备（`matchMedia('(pointer: coarse)').matches` 或 `navigator.maxTouchPoints > 0`）：回车**不发送**，走 textarea 默认换行，发送仅靠 `#btnSend`。
   - 非触摸设备：维持现状（Enter 发送、Shift+Enter 换行）。
   - **实施**：判定逻辑抽为纯函数 `shouldSendOnEnter({ shiftKey, isTouchDevice })`（`public/js/logic.js`），`isTouchDevice` 在 `app.js` 里只计算一次；keydown 处理器改为在 IME 守卫之外再加这一个判定。
2. **`enterkeyhint`**（`index.html:943`）：移动端改为 `enter`（换行）或按设备动态设置，不再固定 `send`，消除「回车键=发送」的误导与 IME action 派发。
   - **实施**：未改 `index.html` 静态属性（保留 `send` 作非 JS/桌面默认），改为 `app.js` 初始化时按 `isTouchDevice` 用 `inputEl.enterKeyHint` 动态覆盖。
3. **可选兜底**：即便保留手机回车发送，也应提供换行入口（如长按发送键换行、或输入框旁「换行」键）——**未实施**（本次直接采用「触摸设备回车=换行」的方案，不再需要这个兜底）。
4. 回归用例（`scripts/visual-e2e-runner.js`）：移动 viewport 下「输入含 `\n` 的多行文本 → 回车 → 断言 `value` 未被清空、未产生 `user:message` 帧」。
   - **实施**：新增 TC-23（该文件全局 viewport 本就是 `isMobile+hasTouch`）；用 `page.keyboard.press('Enter')` 真实按键，断言 `#input.value` 保留两行完整内容 + `#messages` 仍是发送前的空态。跑通证实了 Puppeteer 的 `hasTouch` 模拟下 `matchMedia('(pointer: coarse)')`/`maxTouchPoints` 确实按预期判为触摸设备。
   - 单测：`test/logic.test.mjs` 新增 `shouldSendOnEnter` 5 例（桌面/触摸 × Shift 各分支 + 空入参安全）。
   - 真机（iOS Safari / Android Chrome 实体软键盘）未验证，仅 Puppeteer 触摸模拟 + 单测覆盖。生产 server 需重启才生效。

### 8.2 次要修复：长文本输入框滚动/显示（§7，`app.js:2151` + `index.html`）

让输入框达到 144px 上限后有明确、稳定的内部滚动行为，并在输入时把光标行滚入可见区。

1. **显式滚动样式**（`#input` CSS，`index.html`）：

   ```css
   #input {
     overflow-y: auto;
     overscroll-behavior: contain;      /* 阻断滚动链，减少内外滚动手势竞争 */
     -webkit-overflow-scrolling: touch; /* iOS 惯性滚动 */
   }
   ```

2. **`autosize()` 区分未达/达上限，并同步光标可见性**（`app.js:2151`）：

   ```js
   function autosize() {
     const maxHeight = 144;
     inputEl.style.height = 'auto';
     const h = Math.min(inputEl.scrollHeight, maxHeight);
     inputEl.style.height = `${h}px`;
     inputEl.style.overflowY = inputEl.scrollHeight > maxHeight ? 'auto' : 'hidden';
     // 坑：不可无条件 inputEl.scrollTop = scrollHeight——否则用户把光标移到长文本中间
     // 编辑时会被强行拉回底部。应仅在光标接近文本尾部（或新增内容在尾部）时才滚到底，
     // 或依赖浏览器 selection 可见性处理。
     updateSendButtonState();
   }
   ```

3. `#input::-webkit-scrollbar{display:none}`（`index.html:417`）取舍：隐藏滚动条更美观，但抹掉了「还有内容可滚」的提示；若保留，建议配合别的可滚提示（如底部渐隐遮罩）。

## 9. 相关代码位置

| 位置 | 作用 |
| --- | --- |
| `public/js/app.js:1956-1961` | keydown 回车发送判定（**主因**根因主体） |
| `public/js/app.js:1803` `send()` | 发送函数，读 `inputEl.value.trim()` 整条 emit，本身不截断 |
| `public/js/app.js:1870` | `text.length > 50000` 拒发（非截断，已排除） |
| `public/js/app.js:2151-2155` `autosize()` | 高度封顶 144px（**次要问题**：达上限后滚动行为未定义，见 §7/§8.2） |
| `public/index.html:943-944` | `enterkeyhint="send"` + `max-h-36`/`resize-none` textarea |
| `public/index.html:417` | `#input::-webkit-scrollbar{display:none}` 隐藏滚动条（加剧「看不全」体感） |
