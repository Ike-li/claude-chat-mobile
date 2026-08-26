// logic.js —— app.js 的纯决策逻辑，已按领域拆进 ./logic/，本文件退化为 re-export barrel。
//
// 【为什么拆】原本 3044 行、191 个 export 堆在单文件，唯一共同点是「能被 node:test 测」——
// 那是技术属性不是领域。实测 211 个顶层声明只有 86 条内部依赖边、95 个完全零耦合、最高入度 4：
// 它从来不是一个模块，是一个容器。单文件还会把耦合藏成合法的同文件调用——拆分时才暴露出
// formatUptime / formatRttMs 两个纯格式化原语被混在领域模块里，让 connection 与 service-diag
// 互相依赖（下沉到 logic/format.js 后解开）。
//
// 【红线仍然有效，由每个子模块各自承担】只做数据→数据，不碰 DOM / window / socket / 应用可变
// 状态；唯一允许的宿主外 import 是 ./i18n.js。子模块之间可互相 import 但不得成环。
//
// 【barrel 保留的理由】public/js/app.js（127 个符号）与 29 个 logic-*.test.mjs 继续走这里、
// 一行不改——app.js 是说好要冻结的巨石，测试迁移的收益低于 diff 噪声。
// public/js/app/ 下的领域模块已改为直接 import 子模块，依赖面对 import 边界守卫可见。

export * from './logic/attachments.js';
export * from './logic/bg-tasks.js';
export * from './logic/composer.js';
export * from './logic/connection.js';
export * from './logic/format.js';
export * from './logic/message-time.js';
export * from './logic/mirror.js';
export * from './logic/models-effort.js';
export * from './logic/outbox-send.js';
export * from './logic/panel-state.js';
export * from './logic/permissions.js';
export * from './logic/service-diag.js';
export * from './logic/session-search.js';
export * from './logic/statusline.js';
export * from './logic/tool-cards.js';
