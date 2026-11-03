---
paths:
  - "app/public/**"
  - "app/src/sessions/attention.js"
---

# 前端

- 新状态别再放进 `app/public/js/app.js` 顶层作用域：放进 `app/public/js/app/` 下的模块（工厂 + context 注入，样板见 `app/public/js/app/event-dispatch.js`）。存量不动。
- 能写成纯函数的逻辑先放 `app/public/js/logic/*`：数据进数据出，不碰 DOM、window、socket、应用可变态，唯一宿主外 import 是 `i18n.js`。浏览器与 `tests/unit/logic-*.test.mjs` 零构建共用同一份文件；`logic.js` 只是 re-export barrel。
- 前后端互不 import，唯一豁免是 `app/public/js/canonicalize.js`（指纹规范化两侧共用）。
- **服务告警和「需要你(N)」是两根轴，绝不混判**：顶栏 chip 与角标只表达「点一下就能处理」的待办，服务告警只出现在抽屉「服务」小节与服务状态面板。
- **限速锁定的措辞按来源分档**：本机来源绝不说成「有人在暴力尝试」。
