# 变更记录

## v1.9.0 — 2026-09-13

Changes since v1.8.1.

### Verified environment
- claude CLI: 2.1.269
- Agent SDK: @anthropic-ai/claude-agent-sdk 0.3.263

### Features
- feat(push): 推送订阅补上「关闭」这条出路

### Fixes
- fix(release): 补齐发版中断后三个救不回来的断点
- fix(web): 重载历史走驾驶轴 cwd，修锁屏回来「历史消息加载失败」
- fix(server): 换 cwd 后「本实例 cwd」的消费点一并走驾驶轴
- fix(agent): 会话中途 EnterWorktree 后实例 cwd 跟着走
- fix(push): 改预览开关不得把已关掉的推送偷偷订回来
- fix(ci): 分片时长片段改成非隐藏文件名，并让上传捞空直接红
- fix(web): 回执去用户此刻在看的那一层，并让审计面板说出是哪道保护拦的
- fix(web): 抽屉里删除失败的理由要留在抽屉里，两道保护的拒绝也记审计
- fix(web): 兜底清 busy 的善后也收敛成一处，广播看门狗补清乐观 marker
- fix(web): 可恢复错误不解锁发送闸；ticker 自检对齐 bgActive 口径
- fix(e2e): P0-17i 镜像三态改由用例显式推进，拆掉与 mock 定时器的赛跑
- fix(web): retry 行不跟「回放中性」走；文档补上纯后台任务的例外
- fix(ci): 分片编排的 spec 发现改递归——嵌套目录会被静默漏跑
- fix(web): 对账保住「后台任务+前台轮并存」，自检一并收发送闸
- fix(web): 回放对 live 行全字段中性，并让对账口径与广播一致（排除 bgActive）
- fix(web): 清掉悬留的乐观 busy marker，并在回放后对账运行态
- fix(web): 回放的轮次终止事件也不得写运行态（对称补齐），并修正文档口径
- fix(e2e): mock 新增会话须排在最近列表前 8 之外，否则挤掉 P0-11am 的断言对象
- fix(ui): 状态栏判据改读表面 DOM，中断表面补收起；compose 换区走 syncTopContextLabel
- fix(web): 回放事件不再点亮运行条，并给 busy 加每秒自检兜底
- fix(ui): 新会话页显示工作区文件入口与状态栏
- fix(gate): 基线 pin 改回 7d4aa87——判据是图里的 revision，不是这轮动没动过图
- fix(gate): 图 12 已重出，第 14 道门禁那条从「欠着」挪回断言表

### Other
- test(logic): 给 format.js 补单元测试
- docs(ci): 记下 8 片的实测墙钟 140s 与零 flaky
- perf(ci): 分片数 6 → 8，贴着地板取满收益
- docs(ci): 把分片注释里的推算数字换成两轮实测值
- perf(ci): e2e 分片摊到 6 台 runner，并让 LPT 分配在 CI 上真正生效
- test(agent-lifecycle): 空闲回收用例改用 60s 阈值，消掉对定时器精度的依赖
- refactor(web): instances 快照的运行态判据收敛到一处，四个消费点共用
- perf(ci): e2e 定在 4 分片并配 retries:1——三个档位都实测过
- perf(ci): e2e 分片数 4 → 2，实测 4 分片会让 P0-17i 假红
- perf(ci): e2e 接进分片并行编排，整轮 CI 11.1 分钟降到约 3.4 分钟
- docs: 逐份核对文档与实现，修四处门禁抓不到的不一致
- docs(branch): GitHub 默认分支切回 master，文档跟上并说清为什么撤掉那道防线
- test(history-list): 超时下界留 5ms 抖动余量，这条断言会偶发假红

**Full Changelog**: https://github.com/Ike-li/claude-chat-mobile/compare/v1.8.1...v1.9.0

## v1.8.1 — 2026-09-12

Changes since v1.8.0.

### Verified environment
- claude CLI: 2.1.268
- Agent SDK: @anthropic-ai/claude-agent-sdk 0.3.263

### Fixes
- fix(release): LAST_TAG 锚到 origin/master，否则每次发版都多算一整个已发布版本

### Other
- docs(readme): 按「终端等价性」重写，300→140 行，配图换成真会话实拍

**Full Changelog**: https://github.com/Ike-li/claude-chat-mobile/compare/v1.8.0...v1.8.1

## v1.8.0 — 2026-09-12

Changes since v1.7.0.

### Verified environment
- claude CLI: 2.1.268
- Agent SDK: @anthropic-ai/claude-agent-sdk 0.3.263

### Features
- feat(worktree): 托管 worktree 的会话在父仓可见可驾驶，并补上新会话创建入口
- feat(approval): 「永久不再问」——审批规则终于能活过本次会话
- feat(settings): 工作区列表在手机上可编辑——唯一免重启的配置项不再是唯一改不了的
- feat(settings): 「排查」页能读 server 进程日志——第四条日志终于有面
- feat(settings): 手机上扫码接入新设备（两步展开 + 到时自动隐藏）
- feat(settings): 审批规则只读面——手机上终于能看到哪些工具不弹审批
- feat(settings): statusline 桥接进面板——两个 CLI 桥不再一个有面一个隐身
- feat(settings): 「这台电脑」页显示 MCP 服务器与 skills 数
- feat(rewind): 说清回退没做完的部分——哪些文件没恢复、几个链接被跳过
- feat(rewind): G5 脏改动预警——只报会被覆盖且找不回来的那些
- feat(rewind): 回退后把那一轮的原话回填输入框——下一步多半是改一改重说
- feat(rewind): 长按用户气泡回退该轮文件——分叉出回到那一刻的新会话，原会话完整保留
- feat(ui): 子代理内部工具报错累进聚合卡标题的 ❌ 计数
- feat(devices): 设备列表拼上浏览器并支持起别名——三条都叫「Android」的问题
- feat(agent): 回来时的会话摘要与下一步建议，两个默认开的旁路提问
- feat(qr): 公网二维码——自动解析地址，受 Access 保护的域名不带令牌
- feat(qr): 桌面端菜单栏加二维码入口，PNG 走管道、token 明文不进 Swift 进程
- feat(ui): 子代理聚合卡显示用量与最近工具，接通 task_progress 的 tool_use_id
- feat(devices): 设备元数据旁挂 device-profiles.json，四端可辨识 + Web/菜单栏吊销
- feat(gates): 漂移闸断言 15→22 条，新增「图欠着的话」分组
- feat(qr): 终端二维码投递连接地址+token，免在手机上手输 64 位令牌
- feat(gates): 架构图集漂移闸 + README 链接上线的图集
- feat(unread): 手动标记的会话不受分页截断，目录头未读角标可点跳转

### Fixes
- fix(release): pipefail 下 grep -q 让版本号推导把命中判成未命中
- fix(race): 六处竞态与陈旧快照 —— PR #24 自动审查的批次四（收尾）
- fix(worktree): 托管 worktree 的四处接线欠账 —— PR #24 自动审查的批次三
- fix(config,qr): 四处「看着成功、实际没生效」—— PR #24 自动审查的批次二
- fix(security): 授权面收不窄 + rewind 两处 fail-open —— PR #24 自动审查的三条 P1
- fix(ci): quality 与 unit-test 的两处恒红都不是代码问题，是环境与门禁口径
- fix(ui): 下一步建议条加 ✕、新一轮开跑即收起，迟到的建议直接丢掉
- fix(ui): 流内 live 活动行会卡在消息流顶部，改由 observer 兜底顶回末尾
- fix(agent): 送进 SDK 的用户消息补上 origin:{kind:'human'}——缺它时正文关键词触发整条路静默死掉
- fix(e2e): mock 的 instances 广播补齐 service/canRestart，P0-25c 并行下不再间歇红
- fix(help): 访问帮助页三条说法与代码不符，逐条改正并补上二维码
- fix(settings): 服务状态/服务与配置面板改左上返回箭头——✕ 会把人扔回主页
- fix(settings): 语言选择器改自绘按钮组——原生下拉在手机上弹到了页面另一头
- fix(ui): 下一步建议加标签行——不写明点了会怎样，用户不敢碰
- fix(ui): 子代理卡不再铺原始输入 JSON，底栏不再与流内复读
- fix(service): 菜单栏/CLI 重启不再被判成崩溃循环——记意图与强杀绑成单一入口
- fix(history): 刷新后子代理卡不再是空壳，展开时按需读 subagents 流水
- fix(devices): CF Access 开着时信任表管不到隧道连接——面板改说真话 + 新增 DEVICE_APPROVAL_SCOPE
- fix(ui): 子代理一次 spawn 只留一张卡，通用工具卡的槽位并进聚合卡
- fix(ui): 顶栏 RTT 往返延迟恢复全时段常驻显示
- fix(ui): 状态图标换图标时一并换色，历史回放的成功卡不再残留进行中色
- fix(push): 前台 Bash 不再被当成后台任务播报完成通知
- fix(effort): 回合进行中可切具体思考强度档——busy 守卫下移到重路径

### Other
- build(release): 版本号按提交历史推导，并把变更记录落进仓库
- build(release): 发版改走 PR 并等真 CI，不再直推 master
- ci: dependabot 的 PR 落到 dev，并拦住任何非发版 PR 进 master
- test(outbox): 给 ack 契约登记新增的 instanceId 字段
- docs(getting-started): 首次验收把「CLI 未登录」从卡点改判成一道可验的硬门
- docs: 逐篇核对文档与实现，修 26 处事实不符
- chore(gates): 三条 PENDING 随重出图归位，基线同步到 7d4aa87
- test(guard): 钩子改成 deny+指路，长任务不再停下来等人点确认
- test(guard): mutate 也带上执行位守卫；两份文档跟上强制机制
- test(isolation): 单测数据根收进一次性目录——data/ 从逐文件白名单改成目录级封堵
- test(guard): 执行位守卫铺开到 invariants/server 与 integration，配一道接线闸
- test(guard): 破坏性测试自带执行位守卫——宿主机上真红，不再只靠钩子和文档
- test(scope): 补 WORKDIRS 写入侧的 SCOPE-01 守护——白名单锚点本身可以被写歪
- refactor(settings): 通用设置改两级导航——主轴从「作用域」换成「意图」
- test(rewind): 补齐拒绝档——真 server 上的守卫与「文件回了但没分叉成」那一支
- test(rewind): 真 agent turn 端到端——成功支此前一次都没在真 server 上产出过
- docs: 命令速查——npm run 不是命令全集，CLAUDE.md 那份用户拿不到
- docs(desktop): 桌面端异常时的终端退路——GUI 特有失效不是服务故障
- docs(qr): 三处补上 qr.js 的可发现性——启动横幅、README、部署文档
- chore(deps): bump hono from 4.13.0 to 4.13.7
- refactor(config): WORK_DIR 并入 WORKDIRS 首项，删掉三处静默回落家目录的洞
- docs: 补更新说明（双语），并修 /health 的 versions.server 恒 unknown

**Full Changelog**: https://github.com/Ike-li/claude-chat-mobile/compare/v1.7.0...v1.8.0

## v1.7.0 — 2026-09-08

Changes since v1.6.2.

#### Verified environment
- claude CLI: 2.1.263
- Agent SDK: @anthropic-ai/claude-agent-sdk 0.3.263

#### Features
- feat(sync): 接上 commands_changed，slash 命令中途变化能到手机端
- feat(tasks): 后台任务完成后可查看 CLI 落盘的输出
- feat(tasks): 后台任务行显示耗时与用量，task_progress.usage 此前一字未读
- feat(sessions): 桌面端 Code 模式的会话在列表里显示运行态，不再只有一个未读点
- feat(uploads): 附件落盘搬出用户工作目录，靠 additionalDirectories 保住免审批
- feat(doctor): Tailscale 一等路径——检测 + 指路 + 配方，不装不起不保活
- feat(auth): TRUSTED_PROXY=loopback——反代下登录限速可按 X-Forwarded-For 末跳分桶
- feat(push): 说清 Web Push 的 Google 依赖——订阅失败给人话，文档按平台分岔
- feat(unread): 长按标未读 + 未读改文字标签 + 顶栏角标说人话
- feat(access-profile): 新增 direct（公网直连），并按它自己的判据做针对性检查
- feat(auth)!: 鉴权是启动前提——无 AUTH_TOKEN 拒绝启动，删掉本机免鉴权路径
- feat(access): 公网访问方案声明 ACCESS_PROFILE + 监听地址可配置 BIND_MODE，CF 鉴权收敛为 authStrategy
- feat: 顶栏连接绿点改为有事才出现
- feat: 会话未读点——抽屉行与首页最近行，上次打开后有新活动才亮
- feat: FILE_EDIT 直写开关进装机问询，doctor/web 体检双端加公网迹象提示
- feat: 地址枚举改按地址段判定，隧道内地址不再被隐藏；补自建公网入口文档
- feat: 子 agent 进度摘要开关进配置面板，唯一会计费的开关不再只藏在源码里
- feat: 抽屉会话行按驾驶方区分「运行中」与「终端运行中」
- feat: 通知横幅带上项目名和会话标题
- feat: 后台任务横幅按构成改标题，混合时分组
- feat: 工作区抽屉按标题搜索，并砍掉「从列表移除」

#### Fixes
- fix(installers): 两个 bridge 把版本化 node 真身写进 settings.json——node 一升级就静默失效
- fix(sessions): 桌面端运行态补判加归因——web 续接后自己写的 pending 被记到桌面端头上
- fix(ui): 去掉 msg-in 的 fill-mode——动画层压过内联样式，三处透明度全是死的
- fix(agent): 静默吞 status 心跳，把兜底日志从噪音里救回来
- fix(statusline): ctx% 分档反转——实测 summary 也带 maxTokens，冷路径本该用它
- fix(e2e): P0-17k 误用 600ms 窗口的场景变体，高并发下必然超时
- fix(unread): 读完直接锁屏不落已读位点，换设备复亮
- fix(long-press): 桌面右键第二次起静默无反应，一个闩承担了两种生命周期
- fix(unread): 手动标未读在当前会话上当场不亮，isViewing 短路管辖面过宽
- fix(tasks): housekeeping 任务不再往消息流打完成条、不再弹通知
- fix(agent): task_updated 被静默吞，后台任务「已暂停」显示成「运行中」
- fix(tests): E2E 分片编排漏传 config 恒全红，改为复用 test:e2e 并按核数自适应
- fix(sessions): 会话打不开时落到目标会话自己的页面，列表行点击前先预警
- fix(sidebar): #sessionsDot 认识 terminal_waiting，抽屉折叠时页外等审批不再无声
- fix(sessions): session:list 的 cwd 级终端汇总补上 waiting 半边，页外等审批不再看不见
- fix(http): 关掉 X-Powered-By、data-cf-access 改写而非重复注入，依赖漏洞清零
- fix(tests): doctor readiness 断言依赖宿主机装没装 claude——CI 红了 3 天
- fix(gates): 变异掩码不认正则字面量——25 处运算符只产出 1 个变异体，报告还写着「全部杀死」
- fix(tests): 临时目录泄漏收根到 preload——逐个修会撞上同一个坑 N 次
- fix(tests): 测试基建自己在泄漏临时目录——/tmp 里攒了 9846 个
- fix(logic): 逐条过完 14 个模块的存活变异体，挖出两个真缺陷
- fix(mutate): tests/v2 整个在自动关联的盲区——判据工具自己失明比没有工具更糟
- fix(infra): 容器测试一直跑在别的项目的镜像里——ccm-test:local 这个名字全机共享
- fix(files): 点开工具卡预览会卡死整个服务——三条读取路径里 tool:preview 那条漏了特殊文件闸
- fix(mirror): CLI 等审批时手机既看不见也拦不住——漏认了 registry 的第四个 status
- fix(usage): 额度百分比不再往下跳——旧发迟到覆盖了新值，再补一道展示层单调护栏
- fix(unread): 已读位点搬上服务端共享——换设备后在另一台读过的会话不再整屏复亮
- fix: 清掉会话里挂着的三处遗留问题（死文件 / 脆弱判据 / 文档作用域）
- fix(service): 升级后 plist 过期被说成「用户自定义」，三个出口都在说反话
- fix(settings): 空态三处：把等待说成没开始、读不出状态就整段消失、空网格
- fix(hooks-bridge): L2 探活打不带 token 的 /health，撞的正是登录限速桶
- fix(auth): 退避短锁被说成「登录尝试过多」；凭据门开着还在自动重连
- fix(settings): 会话 ID 懒创建期只藏行、留下孤儿标题；改为就地说明
- fix(general-settings): 分段导航漏出滚动内容；偏好面板排版分层
- fix(drawer/unread): 刷新后未读角标空窗 12s 且空窗期在说谎
- fix(header-chip): 其他工作区「运行中」不再占顶栏；色调表升格为准入表
- fix(service-diag): IPv6 loopback 归桶后被说成公网暴力尝试
- fix(workdirs): doctor 与 server 同一选择，WORK_DIRS env 不再被内联吃掉
- fix(unread): PWA 切后台但 socket 未断时胶囊恒 0
- fix(service-alert): 告警说不出「是谁/为什么」，还把「需要你」挤出顶栏
- fix(mirror): web 自己写的 pending 尾部把手机锁死——锁的建立与释放改看同一组证据
- fix(smoke): entrypoint 与 question 两个场景的存量假设过期，修好后 12 个场景全绿
- fix(doctor): 缺 AUTH_TOKEN 的说法与 bindDiagnostic 对齐——是拒绝启动不是绑 loopback
- fix(auth-ui): Tailscale MagicDNS 域名判成隧道内，补上 100.64/10 的域名那半
- fix(access-profile): 托管隧道归 reverse-proxy，Tailscale 两种拓扑分开说
- fix(auth): HTTP 与 socket 的拒绝语义合一，限速时告诉用户还要等多久
- fix(test): 集成测起 server 也摘掉继承来的生产键，清单与 smoke 共用一份
- fix(workdirs)!: WORK_DIRS 环境变量压过配置文件内联 WORKDIRS
- fix(smoke): concurrency 收尾等子进程退出，不再把 server 落成孤儿
- fix(auth): IPv6 限速按 /64 归桶，堵住换源地址绕过登录限速
- fix(desktop): runSync 收尸改用 waitpid+poll，不再把 waitUntilExit 丢到 GCD 线程
- fix(desktop): 菜单栏跑的体检报「找不到 claude」——GUI 血统的 PATH 只有四个系统目录
- fix: 历史全量重载不再与乐观气泡撞成两条
- fix: 在线发消息立即出现气泡，不再等服务端回包才上屏
- fix: statusline 热路径缓存 getContextUsage，避免每 10s 打 ~22 次 count_tokens
- fix: 配置面板标出被 env 覆盖的键，并补齐 web-recon E2E
- fix: 二轮审查补齐 busy 看门狗与发送时序同源约束
- fix: 「正在重发（发往其它会话）」误报——客户端 ack 超时 5s 短于服务端上界
- fix: 压缩后 ctx% 跳回压缩前的值——compact_boundary 没清 lastUsage

#### Other
- docs(gateway): 第三方网关的推荐通道写成 CLI settings 文件的 env 块，服务端文案不再说「只能从 shell」
- refactor(dist): 装机改拉 GitHub 对 master 的源码归档，发版不再打包上传资产、不改写 package.json
- docs: 补英文版一条会致配置静默失效的警告，并把两处清单降级为导览
- docs: 通读全部 14 篇后的第二轮一致性修复——含一条描述不可达行为的安全说明
- docs: 文档与代码一致性核对——14 条漂移，门禁一条都抓不到
- test(integration): ack 形状守卫从 2 条扩到 22 条，改表驱动
- docs(testing): 假绿形态清单补三条——都是这两天各踩了一次的
- test(e2e): 补 mock 的三处应答，撑开三段前端零覆盖的失败路径
- test(integration): ack 形状守卫试点——守键集而非键值，把默认答案从「绿」反转成「红」
- chore(deps): Agent SDK 0.3.201→0.3.263，接住 stderr 上屏与 interrupt 连坐后台任务
- refactor(ci): upstream-watch 改手动拉取，删掉 CLI 那条伪信号轴
- test(e2e): mock 补齐 5 处 agent:event 去程字段，撑开两段从未被走过的前端分支
- perf(e2e): 分片改按实测时长均衡（LPT），全量 167s → 140s
- refactor(frontend): app.js 的 150 符号 import 拆成一符号一行——多会话并行时这一行必撞
- perf(check): app:test 按指纹缓存，npm run check 从 22s 降到 5s
- refactor(ui): 工具卡标题改用模型写的 description，视觉从「卡片」降为「行」
- docs(testing): 补「怎么知道自己写慢了」一节，并点名 infra/ 不在门禁覆盖范围
- perf(tests): 两个单测文件在空等，test:unit 从 62s 降到 12s
- docs(claude): 开头补 Claude Code 用途说明与 AGENTS.md 符号链接提示
- test(infra): 四档公网方案的新用户装机演练容器，并修掉它抓出的四个真问题
- docs: 文档对齐代码——Serve 下限速合桶、公网信号集、Access 口径
- docs(ui): 残留的 Cloudflare 中心措辞——菜单栏 tunnel tooltip、PUBLIC_URL 帮助文案、两处注释
- refactor(auth): 公网基线正名——AUTH_TOKEN + 设备审批对所有拓扑相同，Cloudflare Access 降为可选加层
- docs(tests): 补齐 tests/unit/ 的文件级说明，并修掉 8 个指向已拆分旧文件的头注
- refactor(tests): 测试树去掉迁移时态命名，并把「编号 ⇔ 登记表」变成硬闸
- test(frontend): 横幅接线断言删掉，架构守卫留下——两者性质不同，不该一起搬
- test(v2): 未读接线搬到 S2——PWA 切后台攒的未读，切回来看不看得见
- test(desktop): 补上 §11 点名的两条——双 pipe 并发排空与不留僵尸
- test(v2): SRV-003 搬到 S2 行为断言——终端写过之后 web 必须换实例，否则模型看不到那几轮
- test(fixtures): 假 CLI 加可驱动档——默认行为逐字不变，新能力显式 opt-in
- test(v2): /health.busy 补上行为断言——运维探针会不会把「正在跑」报成空闲
- Revert "test(v2): SRV-001 从源码文本断言搬到 S2 行为断言"
- test(v2): SRV-001 从源码文本断言搬到 S2 行为断言——搬的过程里先写错了一版
- test(v2): 两个零测试的前端工厂 + RESOURCE-01——后者第一版是永远绿的，靠正对照才发现
- test(history): 200 字符阈值本身没有用例——两条样本离分界 11 和 114 个字符
- test(agent): 台账里只有一条记录时，那次审批决定会被静默丢弃——没有用例把目标放在索引 0
- test(files): 文件头声称守护 FILES-3，实际一条断言都没有——顺带 30 个魔数变异体全存活
- test(auth): DEVICE-01 的双本机条件只守住了一半——peer 那边谁改都不会红
- test(logic): 收掉留下的两条——一条是真缺口，一条我判错了
- test(logic): statusline 前端展示 61% → 93%——量了 16 个模块，只有它值得补
- test(v2): SYNC-01 的 handler 层——补上了不等于补对了
- test(v2): MSG-01 / SOCKET-01 落回 S2——「需要真 CLI 吗」是个太粗的问法
- test(uninstall): 卸载对称性补上「没多删」那一半——顺带发现 .ccm-uploads 报告是死代码
- test: 堵住 devices.test.mjs 的生产数据风险，落地只读变异槽，修索引行跨行
- test(v2): 追新旧测试的共同缺口——补 8 个从没被任何断言执行过的行为
- test(v2): 补齐三个文件的覆盖缺口（约 82 个变异点），再删对应旧文件（2669 行）
- test(v2): 把旧测试独占咬住的 12 个变异点搬进 v2，再删对应的 4 个旧文件（846 行）
- test: 删除 11 个已被 v2 完全替代的旧测试文件（1795 行），依据是变异对比数据
- test(v2): 批次 5 —— S2 层四个文件（真组装根 + 假 CLI），并把 S1/S2 按执行位置分开
- test(v2): 批次 4 —— 通知抑制、状态栏越界值、配置源选择、待办轴聚合四个域
- test(v2): 新测试树首批 14 个文件 + 接线，按「伤害域 × 执行槽」而非测试流派组织
- style(icons): redesign app icon as terminal spark
- refactor(gates): 三个发假绿灯的门禁退役——「✅ 达标」与「11 个核心文件 0 覆盖」本来是同一次打印
- docs(claude-md): 参考资料搬进 architecture.md、装饰性计数改定性——每次会话必读的那份被架构叙述稀释了
- refactor(effort): 切思考强度不再重建实例——「SDK 无 effort 运行时控制」这个前提早就不成立了
- docs: 补清 8-16 漏网的死引用——上轮只扫了 src/ 与 public/js，tests/ 整树和 index.html 没碰
- refactor: 探针改名 classifyProbeState；/health.busy 与 stateOf 分家
- test(auth): IPv4-mapped loopback 必须还原成 127.0.0.1 才判本机
- chore(repo): 清除仓库中的本机特定表述——开源读者读不懂的「机主」「Clash」「隔壁仓库名」
- refactor(repo): 运行时代码收进 app/（src + public + server.js）
- refactor(repo): 测试与门禁收进 tests/；发版打一个裁剪过的分发包
- chore: setup 列出 ACCESS_PROFILES 全表；测试摘 BIND_*；压缩过长注释
- refactor(conn-banner): everConnected 从 app.js 顶层搬进横幅控制器
- style(icons): redesign app icon as terminal bubble
- docs: 补齐强制 token 与 IPv6 分桶的文案面，修四处失效行号引用
- test(smoke): 三处断言脆性改为等条件成立，不再钉工具名与固定 sleep
- docs: README 按三支柱重写「为什么需要它」，正面回应官方 Remote Control
- refactor: config.js 迁 ops/，补上前端接收面契约门禁
- refactor: 六处「同一个事实两份来源」收敛，配两道对照闸

**Full Changelog**: https://github.com/Ike-li/claude-chat-mobile/compare/v1.6.2...v1.7.0

## v1.6.2 — 2026-08-25

Changes since v1.6.1.

#### Verified environment
- claude CLI: 2.1.245
- Agent SDK: @anthropic-ai/claude-agent-sdk 0.3.201

#### Other
- docs: 加 QQ 群入口——群聊拦不住贴 token，防护只能前置到 issue 模板与群公告

**Full Changelog**: https://github.com/Ike-li/claude-chat-mobile/compare/v1.6.1...v1.6.2

## v1.6.1 — 2026-08-25

Changes since v1.6.0.

#### Verified environment
- claude CLI: 2.1.245
- Agent SDK: @anthropic-ai/claude-agent-sdk 0.3.201

#### Features
- feat(desktop): 菜单栏自证身份——版本号在「两个 CCM」问题上零判别力，能分辨的是编译时刻与 commit
- feat(desktop): 三道机器闸补上 1842 行的验证盲区，顺带修掉三处「点了没反应」

#### Fixes
- fix(desktop): app:install 留下的中间产物与安装版同 bundle id——Spotlight 里两个 CCM 分不清
- fix(desktop): 确认框沉到别的窗口后面，把菜单栏整个冻死 63 小时——连「退出」都点不动
- fix(settings): 安全体检展开后没有回程路径——报告把整个设置列表顶出屏幕
- fix(desktop): 菜单栏每次 spawn 漏 2 个 pipe fd——撞上限后停止按钮静默失效、状态永久停在过期快照
- fix(agent): 撞额度墙只透传英文原文、quotaLimits 整个丢弃——手机端把撞墙渲染成回合成功
- fix(server): /JS/foo.js 绕过模块改写，大小写折叠盘上发出未戳版本的源码

#### Other
- docs: 全文档 review 补三处门禁盲区——vendor 分发了 NOTICES 没声明的文件
- docs: README 按用户旅程重写——章节改名连带断掉 4 条锚点，而 check 全绿
- docs: 文档导航按读者分组——repository-map 是给 inventory:check 的，不是给人读的
- docs: 设备审批「本机就跳过」漏了 Host 条件，与 deployment.md 互相矛盾——四层核查另抓出五类分叉
- docs(claude-md): 补代码地图与模块边界——七域分层、import 硬闸五规则、前端 logic 纯函数层此前全无着墨

**Full Changelog**: https://github.com/Ike-li/claude-chat-mobile/compare/v1.6.0...v1.6.1

## v1.6.0 — 2026-08-19

Changes since v1.5.1.

#### Verified environment
- claude CLI: 2.1.235
- Agent SDK: @anthropic-ai/claude-agent-sdk 0.3.201

#### Features
- feat(setup): 向导支持一次登记多个工作区，提示语改讲人话
- feat(doctor): 第 18 项检查——shell 环境变量压过配置文件时列出键名
- feat(uninstall): npm run uninstall 一键卸载——只删产品自己装的，--purge 按白名单清数据面
- feat(device): 桌面端菜单加设备审批入口，新设备接入改为主动推送
- feat(desktop): 「更新桌面端」一键项——编译→安装→自动重启（onSuccess 回调；关窗/失败不触发）
- feat(desktop): unit「查看日志」直开内嵌日志窗口并预选源——退役任务窗口一次性文本输出
- feat(desktop): 菜单可理解性——状态词按 unit 语义定制＋「重启服务」直达＋次要服务折叠＋全员 tooltip
- feat(doctor): D17 配置格式可见性——legacy .env 恒 ok 不催迁，仅在 doctor 告知迁移能力
- feat(desktop): 日志窗口多源下拉＋「重启应用」＋app:install 装进 /Applications
- feat(service): 真实渲染路径补契约测试，模板 label 统一到 com.ccm.*
- feat(setup): 装机时可选编译桌面控制台；文档写清分发立场
- feat(desktop): 控制台主窗口 + 可选 Dock 图标（刘海挤掉菜单栏图标时的第二条路）
- feat(desktop): 桌面端不再依赖终端，运维动作全部内嵌
- feat: 老版本用户的升级路径（启动噪音、拒绝文案、桌面端迁移入口）
- feat(config): 未登记的配置键放行给子进程（读取侧宽容、写入侧仍严格）
- feat(desktop): 配置窗口与日志窗口（schema 驱动，server 挂了也能用）
- feat(service): 非 macOS 也有重启历史（server 自身启动记录）
- feat(config): 配置 CLI（headless 的唯一入口，也是 desktop 端的数据源）
- feat(config): 全部入口切到统一配置层
- feat(config): 统一配置层 ccm.config.json（结构化 · 类型化 · 可迁移）
- feat(check): n=1 假设面从注释里的偶然提及变成可枚举的登记簿
- feat(service): 重启历史进 UI，flapping 判据从「上次退出码」换成频率
- feat(desktop): Swift 抽出可测的纯逻辑层，并修掉审查发现的 6 条
- feat(desktop): 菜单栏控制台，服务状态从「要主动去查」变成一眼可见
- feat(config): 配置改完能就地重启，重启入口不再只对开发者模式可见
- feat(config): 手机上改 .env，保存后可一键重启
- feat(service): 常驻服务管理沉成可编程的一层，服务状态第一次可见

#### Fixes
- fix(devices): 审批指引不说「在哪儿」——回车窗口指代不明、命令不带路径、写操作不回显数据目录
- fix(doctor): 清除建议给错了（exec 保留环境）、workdirs 标签用旧键名、headless server 被报成外来占用
- fix(server): 手机点「立即重启」在 npm start 下假成功真死亡——判据改「退出后有人拉起」
- fix(uninstall): 卸载后残留的菜单栏 app 进程按 appPath 锚定探测并 SIGTERM
- fix(service): 停掉的定时器一直显示「待机」，手机上改三次配置被判成崩溃重启循环
- fix(desktop): 关一次控制台就永久打不开，跑体检时点更新会打断正在写 /Applications 的安装
- fix(config): 坏配置被 doctor 报成「尚未配置」并 exit 0，而 server 用同一个文件起不来
- fix(setup): 向导问了桌面控制台却把答案丢了，覆盖提示说的又不是它要写的文件
- fix(desktop): 开机自启指向仓库构建产物，而三条自查路径全都看不见
- fix(agent): 静默告警从 error 改走 system/notice——每告一次误杀一次在途轮，且锁屏全程不可见
- fix(setup): 向导 WORK_DIR 输错可以重来，不用重跑整个向导
- fix(service): 周期 job 的 stopped 是待机不是故障——判据换成 plist 里的调度形态
- fix(service): 连点 kickstart 撞节流不再报「未知错误」
- fix(desktop): 窗口 controller 单例防坏死——window 释放后重建（关过任务窗则 doctor/装服务/更新全部静默失效）
- fix(agent): usage RPC 加在途去重与迟到结果认领——本地超时不再把「慢」读成「坏」
- fix: 端口冲突时装机向导不再假成功
- fix: 子代理审查剩余项 6 条（含两个契约门禁盲区）
- fix(cli): 用法行不再带 ✗ 前缀；doctor 跟随 locale 双语
- fix(config): 子代理审查发现的 11 条缺陷（3 条 P0）
- fix(check): 两道新门禁各自漏在最想守住的那条边上
- fix(docs): 契约计数没人拦，hard-rules 把入向 42 写成 40
- fix(config): 改一次值就把 .env 里的 export 前缀弄丢了
- fix(ui): 重启记录整段绕过 i18n，清空公网 2FA 零告警
- fix(desktop): tunnel「安装」的占位符被 shell 当成重定向，node 一次都没跑
- fix(service): stop 之后 start 不起来，safe-path 的理由描述的是已废弃的设计
- fix(service): 重启历史记不到 server 自己，还把周期 job 当成崩溃循环
- fix(config): .env 值以反斜杠结尾会让 dotenv 吞掉后面的配置项
- fix(service): 重启判据补上第二个条件，bootout 与确认流程各修一处
- fix(config): 上一版的引号修复引入了 shell 命令注入
- fix(doctor): D16 在服务已装未运行时报绿，文案还自相矛盾
- fix(service): 重启判据取样有偏导致误判，uninstall 补默认拒绝的确认
- fix(config): 配置写入的三处静默损坏与一处白名单绕过
- fix(doctor): PORT 项在常驻部署下不再恒红，新增 LaunchAgent 安装态检查

#### Other
- docs(getting-started): 补三处「代码里有、文档里无」——限速 429 最容易被当成故障
- test(device): 补「审批后真的能用」——此前所有测试都停在「门开了」
- refactor(desktop): 菜单栏删掉顶层「重启服务」——与 server 子菜单同源，两个「重启 X」易点错
- docs(ops): 启动入口叙事收敛到代码层——只剩 headless 与 desktop 两条
- test(ci): 覆盖率门槛挂进 CI——doctor 改成 --full 才跑之后它一个执行点都不剩
- docs(hard-rules): §6 安全分层收缩为摘要+引用——五层图唯一权威版留在 architecture.md（与 §3.1 同风格）
- refactor: 退役「生成旧格式 .env」能力——.env.example/--env/buildEnvContent 移除，schema 成配置项唯一事实源
- chore: ignore Codex 瞬时 RPC 文件——存在的瞬间会随机打红 inventory 门禁
- docs(env-example): 头注自我定位——旧格式模板、常规安装走 setup 生成 ccm.config.json
- docs(setup): 头注跟上现实——默认生成 ccm.config.json 而非 .env
- docs: 桌面端「查看日志」描述补上多源下拉（跟随 f514e77）
- refactor: 取消 deploy/，LaunchAgent 模板并入 desktop/launchd/——desktop 收敛为 macOS 唯一专属入口
- chore: 删掉名不副实的 CI_SKIP；CI actions 升到 v7 消 Node 20 弃用警告
- test(integration): server 子进程钉空 systemd 监管信号，修 CI dev:restart 红
- test(setup): --desktop 两用例钉死 platform=darwin，修 Linux CI 红
- docs: 清理注释里指向已下线 design.md 的死引用（~110 处）
- chore: 删掉 28 个已无外部调用方的导出；NOTICE 链接三方声明
- docs: 文档追上这轮的配置层与桌面端
- chore: 删掉三个已无调用方的导出
- i18n(doctor): doctor-checks 的诊断文案跟随 locale
- docs(config): 文档切到 ccm.config.json，并把配置文件加进 gitignore
- refactor(logic): logic.js 按领域拆成 14 个模块，barrel 保留
- test: 补齐四处「删掉整段也照样绿」的空白
- refactor(service): 采样器 glue 抽出可测层，env:set / dev:restart 补审计记录

**Full Changelog**: https://github.com/Ike-li/claude-chat-mobile/compare/v1.5.1...v1.6.0

## v1.5.1 — 2026-08-13

Changes since v1.5.0.

#### Verified environment
- claude CLI: 2.1.225
- Agent SDK: @anthropic-ai/claude-agent-sdk 0.3.201

#### Features
- feat(doctor): CLAUDE_CONFIG_DIR 被设置时告警本仓不支持

#### Fixes
- fix(agent): 静默看护与视图活动分家，告警并报本轮时长并全部落盘
- fix(sync): 重连重定基线补 wasOwnTurn，己方刚跑完的轮次不再被判成终端写入
- fix(log): sys_info 等 17 处埋点补落文件，排障不再只拿半边
- fix(agent): 轮次结算改按 uuid 精确出槽，消掉 force 槽吃掉新轮 result 的假 busy
- fix(sessions): project 目录名编码对齐 CLI，历史缓存判据补 size
- fix(agent): 自己接住 CLI stderr，让「会话被后台 agent 占用」的文案真正生效

**Full Changelog**: https://github.com/Ike-li/claude-chat-mobile/compare/v1.5.0...v1.5.1

## v1.5.0 — 2026-08-07

Changes since v1.4.0.

#### Verified environment
- claude CLI: 2.1.224
- Agent SDK: @anthropic-ai/claude-agent-sdk 0.3.201

#### Features
- feat(doctor): 新增附件占用可见性检查——只报不删（R9-uploads）
- feat(frontend): 连接状态顶部横幅（打开/重连给出页面级可见反馈）
- feat(frontend): 消息流稀疏式时间戳 + 修拉历史在途的顺序竞态
- feat(doctor): 新增日志开关长开检出（开关 + 日志体积双判据）
- feat(check): 破坏性删除守卫扩到生产代码——盯「目录段由代码算出」这一形态
- feat(test): 测试进容器 + PreToolUse 钩子拦宿主机破坏性命令
- feat(check): 破坏性删除守卫 + 让唯一碰真实目录的单测改跑假 HOME
- feat(ci): 上游版本守望——SDK/CLI 落后就开 issue 并附变更摘录
- feat(mutate): 加变异检查工具——回答「测试会不会开口」
- feat(check): 事件契约补上反向闸——此前只查「不许多」不查「不许少」

#### Fixes
- fix(audit): files:write 的审计 target 记真实落点所属工作区，不再记声明的 cwd（R10）
- fix(statusline): 快照目录加 24h TTL 清扫，写入即回收死文件（R9）
- fix(auth): 空 Host 不再等同真本机，消掉反代置空 Host 的设备门绕过面（R8）
- fix(server): 置换失败不再留 viewing 死指针；档位广播按实例真实值不谎报（R1/R7）
- fix(mirror): 给用户接管加 fencing token，在飞 tick 不再把刚接管的会话重新上锁
- fix(agent): 补齐两条退出路径的清理与可见性缺口（R3/R4）
- fix(frontend): sync:since 两处裸 ack 改 socket.timeout，ack 蒸发不再加载卡永转
- fix(http): 鉴权中间件的 next() 移出 try——下游 handler 抛错不再被计成鉴权失败
- fix(hooks): 投递箱删除面收紧为自家事件命名形态，不再删用户目录下无关 json
- fix(server): externalDirty 忙拒收负 ack 补 busy 维，离线重发落 blocked 终态
- fix(agent): 中断结算看门狗清账改为弃置在途槽，新轮真 result 不再被陈旧占位吸收
- fix(frontend): session:history ACK 超时 abort 闸门会永久丢掉被扣住的追平
- fix(guard): 递归开关不紧跟 rm 时破坏性删除守卫整条旁路
- fix(outbox): 离线重发 stale 死信被当可重试而无限重排队
- fix(agent): 修 localcmd 进度路径的 8 项 review 发现
- fix(agent): 治 web 端 slash 命令 fork 形态的四处次生伤害
- fix(frontend): 修历史闸门永久卡死等 6 项 code review 发现
- fix(server): commitProcessed 排在副作用之后，异常时会重复投递给 Claude
- fix(server): ASSET_HOT_RELOAD 漏接 /js/app.js 与 index.html
- fix(local-command): stdout+stderr 并存时 live 与历史结论相反
- fix(doctor): MODEL_SETTINGS 判据改「按档位 per 目录」，并补回用户级 env
- fix(guard): 删除门禁漏掉 argv 数组形态与 -R/--recursive
- fix(guard): 宿主机测试闸失效为放行——单个 & 不分段 + 白名单只认脚本名
- fix(web): finalizeStreams 高亮抛错不再把气泡卡在半透明
- fix(server): user:message 异常路径释放 in-flight + rlStates 握手侧过 cap + onExit 清理集补齐
- fix(mutate): 沙箱 HOME 补 USERPROFILE，堵 win32 整层失效
- fix(notify): ntfy 请求加 8s 显式超时
- fix(check): 删除门禁扫描面补 rmdirSync 递归与 shell rm
- fix(history): readHeadMeta 尾窗字面 null 行不再吞掉 ai-title
- fix(agent): init 非法 session_id 不再透传 onSessionId
- fix(mirror): stop() 拦不住在飞 tick，定时器被收尾重排回来
- fix(git): rename 条目字段顺序颠倒 + name-status 遍历错位
- fix(web): clearAll 补清指纹不符集合，防正常审批卡被误标篡改
- fix(check): 破坏性删除门禁清死代码，删除点护栏改前缀判据
- fix(coverage): 覆盖率报告按目录树还原完整路径，缺口量化进输出
- fix(assets): /js 子模块不再被启动预读冻死开发循环
- fix(agent): 本地 slash 命令输出在 web 端可见
- fix(test): 容器实跑通——三处环境依赖修掉，宿主机白名单据实修正
- fix(check,doctor,docs): 硬性规则清单化后的四项过时/缺口修复
- fix(test): 删除护栏放到执行删除那一刻——第二发子弹在单测里，上一版防护漏了它
- fix(test): CI stub 必须读完 stdin 再退出，否则 SDK 写 stdin 抛 EPIPE 打死测试进程
- fix(mutate): 变异运行隔离到一次性 HOME——它删掉过机主的真实数据
- fix(agent): SDK 消息转译对畸形输入 fail-safe，并补属性测试
- fix(mutate): 自动关联只取单测——集成测试会把变异循环吊死
- fix(coverage): 门槛 65→75，并打印「分母缺口」
- fix(test): 集成层三处硬伤——429 假红、CI 整体跳过、死 helper 与裸 sleep
- fix(cli-settings): worktree 网关隔离告警判据挪位 + 清理残留的明文 settings 文件
- fix(statusline): 额度不可用判定收敛到 statusline 层 + usage RPC 节流
- fix(test): shared-data-dir 断言不再硬编码检出目录名
- fix(test): awaitTtlSettled 的 keepalive 加上界，防 TTL 回归时挂死 job
- fix(test): TTL 到期用例显式撑住事件循环，修 Node 20 下 cancelledByParent

#### Other
- docs(readme): 负空间定义独立成段
- docs(readme): 「它解决的是」独立成段
- docs(readme): 重写定位段并瘦身，中英文同步
- docs(comments): 修正注释里的导航错误与计数漂移
- docs: 对齐文档与代码——修正 ctx 窗口猜表、会话列表数据源等 12 处冲突
- docs(hard-rules): 登记 UP-1——web 端 slash 恒 fork 是上游既定行为
- chore(deps): 清三条依赖安全告警 socket.io-parser/fast-uri/hono
- docs: 新增 n=1 硬性规则与技术债索引
- chore: coverage 删无人读的 totalLines；cf-access 超时命名
- refactor(guard): 三份括号配平扫描器收敛为 balancedCalls
- refactor(server): clearTables 共享清表；user:message 去掉恒真 typeof ack
- refactor(shared): Map 有界写入收敛为 setCapped/setLru
- docs(git): parsePorcelainZ 头注释仍写着 e7a2536 刚修掉的错误字段序
- chore(deps): bump ip-address
- docs: 删除已完成的 refactor-plan，修正 doctor 描述与架构代码入口
- refactor(guard): 宿主机钩子判据从黑名单反转为域内白名单
- docs(guard): npm test 那条拦截理由点名到文件和形态
- docs: check 的门禁清单补上破坏性删除守卫
- docs(vendor): 许可证声明 MIT → AGPL-3.0-only
- test(mirror-engine): 按变异检查反推补 12 个用例，杀死率 48% → 60%
- test(mirror-engine): 补编排层 19 个用例（0 → 97% 行覆盖）
- chore(privacy): 清除注释里残留的机主用户名与私有项目目录名
- refactor(P4a): mirror/catchUp 引擎收敛为 src/server/mirror-engine.js
- docs: 计划书写回 3b 否决结论与 app.js 剩余候选实测表
- refactor: UI shell 三个子系统按状态所有权归模块
- refactor: 删除单测文件 800 行硬上限，判据改为行为域归属
- refactor(P3-3a): 审批/选择题子系统按状态所有权整体归模块
- refactor(P2): 事件契约上移 src/shared/protocol.js，运行时与门禁同源
- refactor(P1): 数据目录与工具摘要单点化
- refactor(P0): 状态归属规则入 CLAUDE.md + 清两处死重复
- docs: 新增重构计划书（P0–P5 状态所有权收敛）并登记 inventory
- ci: 拆 quality job + Node 20/24 矩阵 + timeout/concurrency
- docs: 移除 README.en.md 失效的英雄图引用
- docs: README 瘦身为入口，拆出首次使用指南与架构说明（中英各一份）
- perf(server): /js/** 子模块源码改启动时预读，请求期零磁盘访问
- ci: test.yml 加顶层 permissions: contents read（收窄 GITHUB_TOKEN）
- Merge pull request #10 from Ike-li/dev
- chore(deps): npm audit fix 清掉 4 条依赖告警（仅传递依赖，直接依赖不动）

**Full Changelog**: https://github.com/Ike-li/claude-chat-mobile/compare/v1.4.0...v1.5.0

## v1.4.0 — 2026-07-31

## 这一版在做什么

**让出问题的时候看得见。**

本版 68 条 fix 对 36 条 feat——性格是把已有功能做扎实，而非堆新特性。四条主线：

- **API 错误可见性**：上游网关报错时，状态行不再是一个沉默的等待动画——按 CLI 的形态整行顶替成错误码 + 重试倒计时（`✻ API 错误 503 · 4s 后重试 · 第 2/10 次`，秒表走动）。此前被吞进日志的一批 SDK 提示（模型拒绝、压缩失败、额度耗尽、子 agent 报错）现在会上屏；刷新后历史里的 API 错误也差异化渲染，不再混进普通回复。
- **推送可自证**：修掉 Service Worker 注册位置导致订阅静默挂死的根因，补上订阅状态显示与「发一条测试推送」——不用等真事发生才知道推送通没通。
- **终端会话即时通知**：可选的 CLI hooks 桥，把「回合结束 / 需要你」从磁盘轮询变成即时信号。
- **英文界面全量覆盖**（624 词条）。

此外：设置按作用域拆成「会话设置 / 通用设置」两层，底栏模型·权限·思考合并成一条摘要 chip；后台任务详情可展开查看进度历史。四轮全量代码审查产出的修复占了本版 fix 的相当比例，含数条安全加固（反代 loopback 不再跳过设备审批、环境变量白名单过滤、审批弹窗点击劫持等）。

#### ⚠️ 破坏性变更

**git worktree 的自动探测已移除。** worktree 路径须显式写入 `workdirs.json` 才作为工作区出现，`cwd` 合法性只认白名单。升级后原先靠自动探测出现的 worktree 会消失，需手工登记。这是把隐式鉴权收紧为显式白名单。

#### 行为变更

运行中的**消息排队已移除，改为「一轮一条」**：回合进行中发送键变停止键，不再堆积待发消息。

---

<details>
<summary>完整 commit 列表（120 条）</summary>

Changes since v1.3.0.

#### Verified environment
- claude CLI: 2.1.220
- Agent SDK: @anthropic-ai/claude-agent-sdk 0.3.201

#### Features
- feat(ui): API 错误可见性对齐 CLI——重试态整行顶替状态行 + 打通被吞的 SDK 自由文本 + 历史错误差异化
- feat(compose): 消息排队移除改「一轮一条」——运行中禁发送，发送位变停止钮 + 常驻提示
- feat(workspace): 工作区两功能不再藏在 chooser 后——合并 tab 面板 + pill 挂改动角标
- feat(release): 发版说明与 README 徽章带上 claude CLI / Agent SDK 版本
- feat(worktree-env): 注入 worktree settings.env 到 CLI 子进程环境
- feat(task-detail): 后台任务详情面板——点击任务行展开进度历史
- feat(task-detail): 后台任务详情面板——点击任务行展开进度历史
- feat!: 拆除 git worktree 自动探测，改为显式 workdir
- feat(live-sessions): 添加全局硬上限 MAX_LIVE_SESSIONS + shutdown 等待 SDK/CLI 子进程最终退出确认
- feat(lifecycle): 在途轮 90 秒零 SDK 消息发网关挂起告警（只提示不中断）
- feat(ui): Transcript 三档密度、ctx 常显、回合末锚定与运行中纠偏
- feat(ui): 侧栏「偏好与通知」命名、推送深链与通用设置锚点
- feat(ui): statusline 折叠显 git·ctx 可复制；会话设置纵向预算让权限首屏可见
- feat(ui): Composer 输入区 A/C polish——Bypass 标红、热区、空态藏发送、/@ 发现
- feat(ui): 权限档跟 SDK 枚举同源，文案固定 CLI 英文不走 i18n
- feat(ui): 顶栏安静化——工作区名固定、RTT 差网才显、＋ 与邻钮同材质
- feat(ui): 会话设置去折叠 + 底栏模型/权限/思考合并为一条摘要 chip
- feat(ui): composer 铃铛迁侧栏、删与底栏 chip 重复的独立齿轮入口
- feat(ui): 设置按作用域拆成「会话设置 / 通用设置」，模型·强度·权限折叠成紧凑列表
- feat(push): 加「发一条测试推送」，让推送链路可自证
- feat(ops): 可选日志窗口——常驻服务起停时自动开/关一个 tail 日志的终端窗口
- feat(hooks): 补上采纳缺口——首装向导询问 + 手机端一键开关 + 启动日志与镜像页提示
- feat(hooks): CLI hooks 桥——终端会话「回合结束/需要你」由轮询变即时信号
- feat(mirror): 消费 CLI 进程注册表自报态，替代终端形态猜测 + 补外部会话列表徽标
- feat(settings): 配置面板补 CLI 配置刷新入口（补齐 6580101 ⑦ 的落点偏差）
- feat(pwa): 主屏应用名 Claude → CCM
- feat(i18n): 英文界面全量覆盖（586 词条）+ 修复 t 遮蔽与顶层求值三类真 bug
- feat(pwa): 移动端体验八项修复
- feat: 九项功能 roadmap 全量落地 + review 修复（CodeMirror 编辑器/会话分叉/@ 引用/i18n 等）
- feat(ui): 顶部 pill 可查看工作区 git 改动（只读）
- feat(ui): 未读跳转加仿微信"以下为新消息"分割线
- feat(test): P0 E2E 双分片并行编排（4.3分钟→2.5分钟）
- feat(ui): 网关映射模型展示真实模型名而非档位别名
- feat(ui): 未读悬浮胶囊 + sync 补发防连响
- feat(diag): 诊断时间线新增 statusline 额度不可用原因 + 补齐 rebindDiagLogs 接线
- feat(ui): 设置面板加 GitHub 仓库外链入口

#### Fixes
- fix(mirror): 回合以本地命令输出告终被误判「终端驾驶中」——system 行漏认 + 切入锁加 tailEntrypoint 判据
- fix(ui): 后台任务面板——详情内联进任务卡片 + 头行整块可点折叠，删三角钮
- fix(ui): 迟到的 sessionId 要同步输入条——setInstances 补上漏掉的 syncComposerVisibility
- fix(ui): CLI 未吐 init 期间刷新/重连不再白屏——空首页判定加 live 豁免 + 恢复路径加 hasSessionId 闸
- fix(compose): 「当前任务运行中」提示去重——删常驻小字行，只留 placeholder
- fix(watchdog): 前台长跑工具被误告「模型无响应」——静默看护加在途工具豁免
- fix(ui): 审批不再阻断导航 + 「疑似中断」文案按事实判定，E2E 清零剩余 3 红
- fix(test): 修 6 个既有 E2E 红——折叠段/隐藏发送钮/缺失 mock 场景/漏收词条
- fix(setup): 无 TTY 下静默失败且先印假成功——加非交互参数并修入口守卫
- fix(resume): web 打开会话不再 SIGTERM CLI 后台任务——删除自动释放锁，改为明说打不开
- fix(agent): setModel 无条件下发打穿 F1——恢复差分并拆出 attemptedModel
- fix(mirror): 终端在跑却不显示只读镜像——注册表自报判据两处失效 + 重连丢锁
- fix(worktree): canonical settings 改回实时读 + 补隔离失效告警
- fix(mirror,scout): 续接文案回归 + scout 残留清理 + 超限错误不可重试
- fix(worktree): 隔离各 worktree 的网关配置，防主 checkout settings.local.json 污染
- fix(ui): 任务详情面板 progressHistory 清理缺口 + 接入 taskDetailState
- fix(agent): cacheToolOutput/redactBase64 遇循环引用会抛错或栈溢出
- fix(ui): unify web and CLI session status in drawer
- fix(ui): remove model icon from composer summary
- fix(security): resolvedEnv 白名单过滤，防覆盖 PORT/AUTH_TOKEN
- fix(fidelity): review findings — base64 安全红线 + truncated 前端接线
- fix(fidelity): 工具输出缓存原文 + task_progress 补 truncated
- fix(model-chain): 对齐 CLI 原生模型解析 + 刷缓存 + 删 inheritedMode
- fix(mirror): web-initiated sessions skip stale interrupted banner after refresh (qarunner UI)
- fix(test): 强制 LOG_TERMINAL=off，隔离机主桌面日志窗
- fix(test): spawnServer 孤儿子进程回收 + 测试认证空值防 .env 回填
- fix(test): metrics-endpoint 集成测试限速自伤致挂起
- fix(mirror): 杀掉 CLI 后续接排队不再干等 5 分钟
- fix(lifecycle): idle 中断文案标明「零 SDK 消息」判定
- fix(bg-tasks): 稳定后台任务横幅——生命周期 TTL + 进度摘要 + 展示粘性
- fix(statusline): ctx 窗口只认运行时真值，删掉按模型名猜的静态映射
- fix(gate): 补门禁自身的扫描面与规则漏洞
- fix(backend): 防线失效四条 + 状态机与同步盲区七条
- fix(frontend): 审批点击劫持、通知隐私旁路、事件派发中断等七条
- fix(mirror): 服务重启腰斩的 web 回合不再误显「终端会话运行中」
- fix: 全量审查确认的 statusline/会话/worktree/推送等多面真 bug
- fix(ui): 模型磁贴/发送 pin 真实 wire；ultracode 改 Settings 会话 flag
- fix(ui): 模型列表与发送走 CLI 透传，doctor 提示 model/DEFAULT 冲突
- fix(ui): 去掉显示密度/双 ctx/纠偏 placeholder，精简会话设置
- fix(auth): 反代 loopback 不再跳过设备审批；catchUp 并行读
- fix(ui): 发送 outbox 耐久化 + 在线 timeout 自动重试
- fix(agent): interrupt settle 槽防迟到 result 假 idle
- fix(ui): @ 文件搜索候选上限 20 → 50
- fix(ui): @ 文件候选改为与 / 同款纵向浮层列表
- fix(ui): 打 @ 无反应——空 query 也返回文件候选，对齐 CLI
- fix(ui): 附件缩略图改 data URL，避开 CSP 对 blob: 的拦截
- fix(ops): 关日志 Terminal 窗口先 Ctrl-C+kill+exit，避免系统确认框卡死
- fix(ui): 会话设置「模型」折叠头显示滞后于新选择，误停在上一轮旧模型
- fix(ui): 待批设备卡片盖住顶栏，有请求时侧栏/首页/日志全点不到
- fix(ui): server 重启不再误报「停止操作未能正常结束」
- fix(push): SW 迁到站点根，修复推送订阅静默挂死
- fix(ui): 推送状态行在真机上永远空白——齿轮按钮不走 app.js 的 open 包装
- fix(ui): 未订阅推送时说明「推送带内容预览」开关是空转的
- fix(push): 推送订阅状态可见化 + 堵掉两条静默失败路径
- fix(hooks): UI 装/卸 hooks 时在服务端日志留痕
- fix(ui): 终端会话推送开关移到配置面板通知组；重读 CLI 配置补排版与成功反馈
- fix(diag): 心跳埋点独立限额，防 catchup/tick 挤掉状态转换记录
- fix(agent): 中断成功路径补结算兜底，修 busy 永挂无解
- fix(sidebar): 会话列表恢复无条件 revalidate，修复改名/截断变化刷不出来
- fix: 全仓库审查 28 项修复（指纹/git冲突识别/竞态/资源泄漏等）
- fix(agent): 空闲看门狗改优先中断而非强杀，对齐 CLI 终端等价性
- fix(statusline): 修正 sonnet-5/opus-4-6+ 等当前代模型上下文窗口误判 200k
- fix(session): 空闲回收竞态导致切入会话历史空白
- fix(ui): 客户端日志上翻阅读时不再被新条目拽回底部
- fix(ui): scrollBottom 的 force 请求会被排队中的非强制 rAF 早退吞掉
- fix(sync): 切回会话/断线重连后离开期间的新内容强制落底
- fix(sync): broadcast 权威态兜底清空丢终止事件后卡死的本地 busy
- fix(effort): resume 旧会话思考强度兜底改读 CLI 真实默认档

#### Other
- chore: gitignore 加 .qoder/（IDE 本地配置挡住发版预检）
- test(e2e): 补历史 API Error 差异化渲染的前端覆盖
- ci: 拆开 unit/integration 跑法修 force-exit 腰斩单测 + Node 20→24
- test(bg-task): 补折叠热区键盘路径覆盖——Enter/Space 生效 + 「停止」的 Enter 不连带折叠
- test(security): 补 filterSafeResolvedEnv 回归测试
- refactor(server): 删除死函数 inheritedMode
- docs(ui): 修正抽屉重构后过期的函数名注释引用
- docs: worktree 检出位改为仓库外平级目录
- chore(test): 按行为域拆出四个测试文件 + i18n 孤儿 key 清理
- docs: 展示契约（模型/effort/statusline）+ 可执行锚点
- perf: dedup 原地写、history LRU、唯一 tmp、有界缓存
- docs(deployment): PWA 图标须对匿名可达，否则 Android 装成快捷方式
- docs(ui): 「终端会话推送」补一句边界说明，澄清它不是推送总闸
- refactor(env): sdkChildEnv 抽到 src/shared，统一 ccm 派生子进程的 env 漏斗
- refactor(server): 抽出 session:switch/fork 的打开聚焦收尾，消除 13 组逐行重复
- docs(readme): hero 图改引用 gh-pages assets 绝对 URL

**Full Changelog**: https://github.com/Ike-li/claude-chat-mobile/compare/v1.3.0...v1.4.0


</details>

## v1.3.0 — 2026-07-21

## 概览

自 2026-07-07 发布 `v1.2.1` 以来，`dev` 分支在约两周时间内（7 月 8 日至 7 月 20 日）积累了 231 个提交。内容大致分三块：约三分之一是新增能力（65 个 `feat`），接近一半是修复与加固（107 个 `fix`），其余是文档、内部重构、测试基建等不直接影响使用体验的工作。

这次更新的主线是把"手机和电脑上的终端谁在真正驱动这个会话"这件事重新做扎实——包括只读镜像的稳定性、消息排队与草稿保护、审批与设备信任、通知节流，以及一整套面向自托管使用者的状态可观测性面板；同时做了一轮系统性的移动端 UI/UX 审查修复和一轮安全加固审查。

## 新增功能

#### 1. Web 与终端 CLI 的同步机制全面加固（本次更新的核心）

- **驾驶状态判断更准**：过去靠磁盘多久没变化判断终端是否还在跑，长任务无输出时会被误判为"已结束"；现在直接读消息链末尾形态判断，解决了"看起来没在跑、其实还在跑"的问题，并新增三种驾驶状态提示和"立即同步"按钮。
- **接管更安全**：终端仍在处理时从手机接管，现在会先排队等这一轮真正结束再发送，避免两边同时写入同一会话导致分叉。
- **只读镜像稳定性**：长任务期间不再被提前误判解锁；重连、切会话、终端里跑本地 `/config` 等场景不再误锁/误解锁；去掉了不准确的倒计时提示。
- **续接体验更完整**：从手机续接原生终端会话会正确带上该会话最后使用的模型和权限模式。
- **支持 git worktree 会话**：终端里 `cd` 进 worktree 再 `/resume`，手机端现在也能看到并续接。
- **诊断时间线**：交互日志抽屉新增"诊断"标签页，记录镜像/排队/停止/控制历史状态变化，可事后回放。

#### 2. 消息发送、排队与草稿保护
第二条消息显示"排队中"并可撤回重编辑；弱网重复点发送不会重复发送；切会话/切模型/切思考强度不再清空未发送草稿；用户主动停止现在独立于"完成"/"出错"呈现。

#### 3. 审批与设备信任
- 批准前核对操作指纹防篡改；审批加超时、服务重启后不再采信过期请求；新增审批与安全事件持久化留痕。
- 询问弹窗新增"跳过"选项，支持多选和自由文本作答。
- 拒绝设备现在对称断开连接；修复 macOS 文件监听偶发失灵导致审批广播丢失的问题。
- 新会话默认权限档读取本机 CLI 实际配置；补上 SDK 新增的 "auto" 权限档。

#### 4. 通知与"等我"提醒
推送内容最小化（不带命令/问题原文）；同会话同类通知短时间内节流；新增跨会话"等我"聚合入口（按等待时长排序）；新增任务完成提示音/震动；新增 ntfy 作为不依赖第三方 SDK 的推送通道。

#### 5. 状态可观测性：诊断、面板与状态栏
新增带鉴权的运行时指标端点；服务状态面板"判定化"——不再堆裸计数字，只在真正值得关注时升级为带时效窗告警；状态栏对齐终端 CLI 呈现（上下文总量/git 分支/token 格式），修复上下文使用率显示放大 5 倍、偶发 150%/-5% 异常值的问题；客户端日志持久化+一键导出+前端报错上报；服务端日志加时间戳前缀+新增轮转脚本。

#### 6. 子 agent 与后台任务可见性
子 agent 输出单独折叠展示；后台任务支持点击停止；Task 清单对齐终端呈现样式。

#### 7. 附件、图片与文件预览
支持剪贴板直接粘贴图片、发送前预览；历史附件可点击查看原图（在线/缓冲回放/服务重启后三种场景均支持）；工具卡片 base64 自动脱敏、JSON 高亮；新增项目文件只读浏览。

#### 8. 会话与历史管理
会话删除做成两级（移除列表 / 二次确认彻底删除）；会话列表加载改走 SDK 快速路径；thinking 内容可折叠回显；子 agent 消息正确挂靠在发起消息下。

#### 9. 界面布局与视觉
首页拆分为"最近工作区"入口与独立新建会话页；模型/权限/思考强度选择器合并进输入框底栏；长指令气泡默认折叠；原生确认弹窗全部替换为项目自己风格的底部面板；PWA 图标重新设计（暖砖橙 CLI 提示符风格）。

#### 10. 性能
切会话时几项前置检查改并行执行；长会话历史改分块渲染；诊断时间线补充端到端耗时记录。

## 修复与改进

- **安全加固**：登录限速（指数退避+阈值锁定）+ 修正"信任来源 IP"判断；文件上传/预览/浏览路径的多处 symlink 跟随与路径穿越修复；日志脱敏规则扩展；修复绕过工作目录白名单的路由漏洞和并发续接"双开"问题；运维脚本纵深防御补充。
- **多会话切换状态串扰修复**：迟到的异步确认写错会话视图、进度/审批卡片残留或误撤、已回答问题重复弹出、"需要你"列表重复项、正在使用的会话被误删、出错时前端卡在"处理中"等一批高频操作下的可靠性问题。
- **Windows 兼容性**：审计后修复 4 处从未被测试覆盖的平台 bug（`which`→跨平台可执行文件查找、statusline 桥接脚本硬编码 `/bin/sh`、工作目录配置只认 `/` 开头路径、状态栏项目名截取不识别 Windows 路径）。这几处修复尚未在真实 Windows 环境验证过。
- **移动端 UI/UX 系统性打磨**：颜色对比度、发送按钮状态区分、代码块复制按钮遮挡、审批面板误触、Plan 内容 Markdown 渲染、焦点管理等一批界面细节修复。
- **其它**：移除"服务自上次连接后已重启"提醒（误报多、参考价值低）；侧栏重复的额度入口合并。

## 内部性工作（不逐条列出）

三份内部设计文档（PRD/HLD/LLD）的多轮评审记录、工程门禁（ESLint/模块边界守卫/事件契约校验）、仓库目录重构、宣传物料生成与后续下线清理、测试基建修复等，与最终使用体验无直接关系，未在上面详细展开。

**Full Changelog**: https://github.com/Ike-li/claude-chat-mobile/compare/v1.2.1...v1.3.0

## v1.2.1 — 2026-07-07

## Changes

- Reworked project documentation to remove AI-generated tone and make wording more direct.
- Updated the bilingual README, capabilities docs, design/deployment/interface docs, docs landing page, specs notes, SECURITY.md, and CLAUDE.md.
- Bumped package version to 1.2.1.

## Validation

- npm run check
- npm test
- git diff --check

## v1.2.0 — 2026-07-07

## What's Changed
* chore: 许可证 MIT → AGPL-3.0-only（含 Section 7 附加条款） by @Ike-li in https://github.com/Ike-li/claude-chat-mobile/pull/3
* fix(license): LICENSE 改为纯 AGPL-3.0 官方全文以修复 GitHub 识别 by @Ike-li in https://github.com/Ike-li/claude-chat-mobile/pull/4
* feat(landing): bilingual static landing page for GitHub Pages by @Ike-li in https://github.com/Ike-li/claude-chat-mobile/pull/5
* docs(readme): link to the landing page (GitHub Pages) by @Ike-li in https://github.com/Ike-li/claude-chat-mobile/pull/6
* ci(pages): 发布改用 GitHub Actions 部署 + preview:landing 脚本 by @Ike-li in https://github.com/Ike-li/claude-chat-mobile/pull/7
* [codex] test P0 auth failure UI by @Ike-li in https://github.com/Ike-li/claude-chat-mobile/pull/8


**Full Changelog**: https://github.com/Ike-li/claude-chat-mobile/compare/v1.1.3...v1.2.0

## v1.1.3 — 2026-07-02

Changes since v1.1.2.

#### Fixes
- fix(scripts): release.sh 用 trap 还原 bump + 本地解析仓库名

#### Other
- chore: 加 scripts/release.sh 一键发版脚本

**Full Changelog**: https://github.com/Ike-li/claude-chat-mobile/compare/v1.1.2...v1.1.3

## v1.1.2 — 2026-07-02

Patch release — test-suite reliability. No product changes vs v1.1.1.

#### Fixes
- **`npm test` is reliable again.** A test bug in `server.test.mjs` let the `dev:restart` test actually restart (and kill) the throwaway test server — the owner's `.env` `DEV_MODE=1` leaked into the spawned server, so the restart fired, killed the shared server, and cascaded into failures plus a hung runner. The test now pins `DEV_MODE=0`.
- Integration tests that need a real `claude` agent turn (`claude-lifecycle`, `session-switch`, `websocket-events`) are now **opt-in** — skipped by default and in CI, run only with `RUN_CLAUDE_INTEGRATION=1`. They are slow, token-spending, and inherently flaky, so they no longer break the default run.
- `npm test` / `npm run test:integration` now use `--test-force-exit` so in-process integration servers can't hang the runner.

Default `npm test` is now **436/436 green and exits cleanly** (unit + the reliable integration tests: server, auth, upload).

**Full Changelog**: https://github.com/Ike-li/claude-chat-mobile/compare/v1.1.1...v1.1.2

## v1.1.1 — 2026-07-02

Patch release — CI fix only. No product changes vs v1.1.0.

#### Fixes
- Integration tests under `test/integration/` now **skip in CI** (matching `server.test.mjs`) instead of failing. They spawn a real server, and CI has no `claude` CLI, so `server.js` preflight would exit — now the whole suite self-skips when `process.env.CI` is set. `test:unit` and the shipped product are byte-identical to v1.1.0.

**Full Changelog**: https://github.com/Ike-li/claude-chat-mobile/compare/v1.1.0...v1.1.1

## v1.1.0 — 2026-07-02

First feature release since v1.0.0 (25 commits). Highlights: background-task push notifications, a full QA / integration test suite, workspace hot-reload, and a developer restart mode.

#### Features
- **Web push for background tasks** — Workflow / background Agent / background Bash completions notify your phone
- **Background task progress banner** with live `task_progress` refresh
- **Persist permission mode & thinking effort** across resume (`sessions.json`), restored on reconnect
- **Hot-reload `workdirs.json`** + per-workspace session limits (no restart needed)
- **Developer mode** — restart the standing server straight from the web UI
- **Richer activity status** — Shell / Workflow / subagent visibility; status line shows the current subtask (Agent description)
- **Status line metrics** — cumulative cache reuse + cache-TTL invalidation countdown
- **Per-block copy buttons** on code blocks, always visible
- Workspace status legend; short session IDs; real model ID in logs; permission-mode chip; landing-page help entry

#### Fixes
- Mobile session fixes: full history echo + memory cap / keyboard-inset gap / cross-workspace log residue
- Attachment picker bottom-half white-screen regression (E17)
- `AskUserQuestion` / `ExitPlanMode` no longer look frozen after you answer
- Double-counted cumulative `cache_read`; empty model grid when the models event arrives late
- 8 code-review findings (notifications / state machine / latch / hot-reload)
- Split runtime vs dev dependencies — skip the unused chrome-headless-shell download

#### Internal & Docs
- Full QA infrastructure + integration test suite (`test/integration/`)
- Adopted a **`master` (stable) + `dev` (development)** branch model; CI now runs on `dev` too
- Moved `server.test.mjs` into `test/integration/` so `test:unit` stays pure-logic / zero-token
- Docs: branch & release model (design.md §7), deploy plist templates, README use-cases section, quick-start tweaks

**Full Changelog**: https://github.com/Ike-li/claude-chat-mobile/compare/v1.0.0...v1.1.0

## v1.0.0 — 2026-06-28

**Use your real local `claude` CLI from your phone** — same agent, `CLAUDE.md`, MCP servers, skills, hooks, and logged-in session you use at your desk. The goal is *terminal equivalence*: typing to claude on your phone behaves exactly like typing at your computer — edit code, run commands, resume a conversation — except now from bed.

## Highlights
- Drives your **local** CLI via the Claude Agent SDK — no bundled Claude, **no extra API key** (reuses your existing login)
- Streaming replies, tool-call cards, **dangerous actions bounced to your phone for approval**
- Five permission modes, per-message model switching, multi-repo / multi-session tabs
- File & image upload, Web Push, a web-native status line
- **Self-hosted, locked by default** — LAN / temporary tunnel / fixed production (Cloudflare Access 2FA)

## Get started
See the [Quick Start](https://github.com/Ike-li/claude-chat-mobile#quick-start). **Read the [Security Model](https://github.com/Ike-li/claude-chat-mobile#security-model) before exposing it to the public internet** — at its core this is a remotely reachable code-execution channel into your shell.

Personal project, provided as-is. macOS / Linux, Node ≥ 20.
