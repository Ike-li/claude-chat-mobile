---
paths:
  - "desktop/**"
  - "app/src/ops/service-units.js"
---

# macOS 桌面端

- `desktop/launchd/server.plist.template` 的启动命令 `exec <node> app/server.js` 与 `app/src/ops/service-units.js` 解析它的后缀**必须逐字一致**，漏改一边会让服务面板的 repo/node 恒为 null。
- `npm run check` 里的 `app:test` 含 `swiftc -typecheck`，所以 check 全绿蕴含能编译；但 typecheck 不产出 bundle，改了菜单栏要真跑起来仍需 `npm run app:build` 或 `npm run app:install`。
- `app:test` 按指纹缓存（`desktop/*.swift` 内容 + swiftc 版本 + 编译参数），没动 `desktop/` 时跳过；`CCM_FORCE_SWIFT_VERIFY=1` 强制重跑。
