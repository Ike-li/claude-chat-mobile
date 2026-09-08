# 运维与排错
> 重启、日志轮转、/health /metrics、常见故障。

- **Part**: 第六部分 · 部署与运维
- **Reading Time**: ~12 min
- **Estimated Tokens**: ~991

---

常驻服务的日常运维速查、高频故障排查树、监控探针与系统体检（Doctor）。修改配置后若未生效，绝大多数情况是未执行服务重启。

## 常用运维指令速查

```
# 1. 结构化配置查看与修改
node scripts/config.js get PORT
node scripts/config.js set ACCESS_PROFILE reverse-proxy

# 2. 全面健康自检
node scripts/doctor.js

# 3. macOS 常驻服务热管理 (LaunchAgent)
npm run service:status     # 查看当前进程 PID、运行时间与错误码
npm run service:restart    # 优雅重启服务
npm run service:logs       # 查看实时日志输出

# 4. 设备授权管理
node scripts/device.js list
node scripts/device.js approve <DEVICE_ID>
```

## 高频故障排错表

| 故障现象 | 最可能根因 | 排查与修复动作 |
| --- | --- | --- |
| 外网访问报 502 / 1033 | CCM Server 未启动或隧道未正确映射端口 | 先检查 npm run service:status 确认 Server 在跑；再看 Cloudflare 隧道日志是否输出 Registered tunnel connection |
| OTP 验证通过但应用连不上 | Cloudflare Access JWT 校验失败 | 在服务端日志搜索 Access JWT ；核对 CF_ACCESS_TEAM 与 AUD 是否与控制台严格匹配 |
| 修改配置后行为未发生改变 | 常驻进程尚未重载配置 | 执行 npm run service:restart （仅 WORKDIRS 修改支持热重载免重启） |
| 手机端无法打开且控制台无报错 | 未配置 AUTH_TOKEN | 有意设计 ：未设 Token 时服务恒定仅绑 127.0.0.1 ；需配置有效 Token 并重启 |
| 新手机接入始终处于 pending | 触发设备信赖门禁 (TOFU) | 在电脑终端敲 node scripts/device.js approve   放行该设备 |
| 运行耗时任务被中断 | 误碰全局空闲超时 | 检查是否派生子代理；系统依赖 bgTasks 刷新心跳，如无子代理但任务耗时极长，调大 IDLE_TIMEOUT_MS |

## 系统体检：CLI Doctor 与 UI Doctor 的分界

 
   
    
#### CLI Doctor (scripts/doctor.js)

    
冷启动前由运维执行：检测配置文件自洽性、本地 `claude` 二进制路径、工作区写权限、端口冲突以及文件安全权限等硬性条件。

   
   
    
#### UI 运行态体检 (doctor-runtime.js)

    
服务启动后由 Web/手机端调起：输出脱敏的安全视图，包含 Access 校验生效态、设备审批队列、IPv6 限速分桶状态以及全局 `settings.json` 敏感工具白名单摘要。
