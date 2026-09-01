// ccm-menubar.swift —— 常驻服务的菜单栏控制台（GUI 层）。
//
// 用 `npm run app:build` 编译（swiftc + CCMCore.swift，不建 Xcode 工程、不加 npm 依赖）。
//
// ## 唯一的架构纪律：零业务逻辑
//
// 「这个 unit 什么状态、归谁管、有没有漂移」由 scripts/service.js 的 `status --json` 决定；
// 「该显示什么话、该拼什么命令」由 CCMCore.swift 决定（那层有测试）。本文件只剩三件
// Node 做不了的事：画菜单栏、弹原生窗、spawn 进程。**永不自己解析 launchctl。**
//
// ## 三条踩过的坑（都有对应注释）
//   1. `runSync` 的超时曾经形同虚设，且顺序读两个 pipe 会死锁 —— 见该函数头注
//   2. Timer 只注册 `.default` 模式，菜单跟踪期间根本不触发 —— 见 scheduleTimer
//   3. 探测回调无条件重建菜单，会把用户正打开的菜单拆掉 —— 见 render

import AppKit
import Foundation

// MARK: - 运行环境：仓库在哪、node 在哪

// @unchecked Sendable 的依据就是下面那把 NSLock：_repo/_node 是仅有的可变态，全部经它进出。
// 声明出来不是装饰 —— 它让「后台队列可以直接持有 env」从一句注释变成编译器盯着的不变量。
final class RuntimeEnv: @unchecked Sendable {
    private static let repoKey = "CCMRepoPath"
    private static let nodeKey = "CCMNodePath"

    private let lock = NSLock()
    private var _repo: String?
    private var _node: String?

    var repo: String? { lock.lock(); defer { lock.unlock() }; return _repo }
    var node: String? { lock.lock(); defer { lock.unlock() }; return _node }

    /// **不在 init 里解析**：resolveNode 会跑一个登录 shell，而 init 发生在主线程。
    /// 早前那版每次启动都在 statusItem 创建之前同步跑 zsh，一旦 shell 启动脚本卡住
    /// 就是「菜单栏连图标都不出现」。改成由后台的第一次 refresh() 填。
    init() {}

    static func isRepo(_ path: String) -> Bool {
        FileManager.default.fileExists(atPath: serviceScriptPath(in: path))
    }

    private static func resolveRepo() -> String? {
        let candidates = [
            UserDefaults.standard.string(forKey: repoKey),
            Bundle.main.object(forInfoDictionaryKey: repoKey) as? String,
        ]
        for case let path? in candidates where isRepo(path) { return path }
        return nil
    }

    /// node 路径：**绝不依赖 PATH**（GUI app 的环境不是登录 shell）。走 `zsh -lc 'command -v node'`
    /// 与 plist 自身的启动方式同源，nvm 换版本也能跟上。失败回落到 build 时烘进 Info.plist 的那个。
    private static func resolveNode() -> String? {
        if let out = runSync("/bin/zsh", ["-lc", "command -v node"], timeout: 5)?.stdout,
           let first = out.split(separator: "\n").first {
            let p = String(first).trimmingCharacters(in: .whitespaces)
            if !p.isEmpty && FileManager.default.isExecutableFile(atPath: p) { return p }
        }
        if let baked = Bundle.main.object(forInfoDictionaryKey: nodeKey) as? String,
           FileManager.default.isExecutableFile(atPath: baked) { return baked }
        return nil
    }

    /// **每轮都重新校验**，不是只在 nil 时才解析。早前那版只补 nil，于是「启动时仓库有效、
    /// 之后被移动」会让 repo 永远保持一个失效路径 —— 菜单里连「重新定位仓库…」都不显示，
    /// 用户看到一个恒定报错且无处下手的界面。**只在后台队列调用。**
    func refresh() {
        let currentRepo = repo
        let stillValid = currentRepo.map { RuntimeEnv.isRepo($0) } ?? false
        let nextRepo = stillValid ? currentRepo : RuntimeEnv.resolveRepo()

        let currentNode = node
        let nodeValid = currentNode.map { FileManager.default.isExecutableFile(atPath: $0) } ?? false
        let nextNode = nodeValid ? currentNode : RuntimeEnv.resolveNode()

        lock.lock()
        _repo = nextRepo
        _node = nextNode
        lock.unlock()
    }

    func relocateRepo(_ path: String) {
        UserDefaults.standard.set(path, forKey: RuntimeEnv.repoKey)
        lock.lock(); _repo = path; lock.unlock()
    }

    func relocateNode(_ path: String) {
        UserDefaults.standard.set(path, forKey: RuntimeEnv.nodeKey)
        lock.lock(); _node = path; lock.unlock()
    }

    var problem: EnvProblem {
        if repo == nil { return .noRepo }
        if node == nil { return .noNode }
        return .none
    }
}

/// 调 L1。所有对服务的认知都从这里来。
// Sendable（不是 @unchecked）：只有 `private let env` 一个存储属性，且它自身 Sendable。
// 好处是将来谁往这里加一个可变 var，编译器会直接报错，而不是留下一个静默的 data race。
final class ServiceClient: Sendable {
    private let env: RuntimeEnv
    init(env: RuntimeEnv) { self.env = env }

    func status(fast: Bool) -> Probe<ServiceStatus> {
        guard let node = env.node else { return .failed("找不到 node") }
        guard let repo = env.repo else { return .failed("找不到仓库") }
        var args = [serviceScriptPath(in: repo), "status", "--json"]
        if fast { args.append("--fast") }

        guard let r = runSync(node, args, cwd: repo, timeout: 8) else { return .failed("service.js 无响应") }
        guard r.status == 0 else {
            let msg = firstLine(r.stderr)
            return .failed(msg.isEmpty ? "service.js 退出码 \(r.status)" : msg)
        }
        guard let data = r.stdout.data(using: .utf8),
              let parsed = try? JSONDecoder().decode(ServiceStatus.self, from: data) else {
            return .failed("service.js 输出无法解析")
        }
        return .ok(parsed)
    }

    /// 启停重启。**不判归属** —— 那是 L1 的事（它对 foreign/unknown 也允许启停，只拒绝写 plist）。
    func control(_ action: String, unit: String) -> Probe<Void> {
        guard let node = env.node, let repo = env.repo else { return .failed("环境不完整") }
        guard let r = runSync(node, [serviceScriptPath(in: repo), action, unit, "--json"], cwd: repo, timeout: serviceControlTimeout) else {
            return .failed("service.js 无响应")
        }
        if r.status == 0 { return .ok(()) }
        // 错误文案原样取自 L1（--json 时成功与失败都写 stdout），不在这里二次加工
        if let data = r.stdout.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let msg = obj["error"] as? String {
            return .failed(msg)
        }
        return .failed(firstLine(r.stderr))
    }

    /// 把 AUTH_TOKEN 送进剪贴板。**明文不进本进程内存** —— L1 直接 pbcopy，
    /// 这里只看退出码。这是「打开 Web UI 却没有令牌」那个问题的正解。
    func copyToken() -> Probe<Void> {
        guard let node = env.node, let repo = env.repo else { return .failed("环境不完整") }
        guard let r = runSync(node, [serviceScriptPath(in: repo), "copy-token"], cwd: repo, timeout: 10) else {
            return .failed("service.js 无响应")
        }
        return r.status == 0 ? .ok(()) : .failed(firstLine(r.stderr))
    }
}

/// 调 scripts/device.js。设备审批走 CLI 而不是 server 的 HTTP 面：这道门恰恰是
/// 「server 在跑、但你还连不上」时才需要的，让它依赖 server 在线就本末倒置了。
/// device.js 直接读写那两个 JSON，server 侧靠 fs.watch 感知并即时解锁已连接的 socket。
// 同 ServiceClient：无可变存储属性，靠编译器守住。
final class DeviceClient: Sendable {
    private let env: RuntimeEnv
    init(env: RuntimeEnv) { self.env = env }

    private func scriptPath(in repo: String) -> String {
        (repo as NSString).appendingPathComponent("scripts/device.js")
    }

    func list() -> Probe<DeviceSnapshot> {
        guard let node = env.node, let repo = env.repo else { return .failed("环境不完整") }
        guard let r = runSync(node, [scriptPath(in: repo), "list", "--json"], cwd: repo, timeout: 8) else {
            return .failed("device.js 无响应")
        }
        guard r.status == 0 else {
            let msg = firstLine(r.stderr)
            return .failed(msg.isEmpty ? "device.js 退出码 \(r.status)" : msg)
        }
        guard let data = r.stdout.data(using: .utf8),
              let parsed = try? JSONDecoder().decode(DeviceSnapshot.self, from: data) else {
            return .failed("device.js 输出无法解析")
        }
        return .ok(parsed)
    }

    /// approve / deny。**不在这里重复判「ID 在不在待审列表」** —— device.js 已有那道纵深防御
    /// （防打错 ID 把陌生 token 静默加进信任表），两处各判一次早晚会判出两套结论。
    func decide(_ verb: String, deviceId: String) -> Probe<Void> {
        guard let node = env.node, let repo = env.repo else { return .failed("环境不完整") }
        guard let r = runSync(node, [scriptPath(in: repo), verb, deviceId], cwd: repo, timeout: 15) else {
            return .failed("device.js 无响应")
        }
        if r.status == 0 { return .ok(()) }
        let msg = firstLine(r.stderr)
        return .failed(msg.isEmpty ? "device.js 退出码 \(r.status)" : msg)
    }
}

// MARK: - 菜单栏应用

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem!
    private let env = RuntimeEnv()
    private let client: ServiceClient
    private let deviceClient: DeviceClient
    // 探测与动作分队列（control 最长 40s，不能堵刷新）。动作保持并发：
    // 复制令牌 / 打开 Web UI 不该等无关 unit 的 kickstart。同 unit 启停靠 busyUnits。
    private let probeQueue = DispatchQueue(label: "ccm.menubar.probe")
    private let actionQueue = DispatchQueue(label: "ccm.menubar.action", attributes: .concurrent)
    private var busyUnits = Set<String>()

    private var latest: ServiceStatus?
    // 待审设备快照。**与 latest 分开保存**：device.js 拉取失败不该把服务状态一起清掉，
    // 反之亦然——两者是两个独立进程、两条独立的失败路径。
    private var latestDevices: DeviceSnapshot?
    private var lastError: String?
    private var lastOk: Date?
    private var timer: Timer?
    private var menuOpen = false
    private var inFlight = false
    private var wizardShown = false
    // ★ 窗口控制器必须被持有。放局部变量的话，方法一返回引用计数归零，窗口会一闪而过
    // 或干脆不出现 —— AppKit 的窗口不会替你保命。
    private var configWindow: ConfigWindowController?
    private var logWindow: LogWindowController?
    private var taskWindow: TaskWindowController?
    private var consoleWindow: ConsoleWindowController?

    override init() {
        client = ServiceClient(env: env)
        deviceClient = DeviceClient(env: env)
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Dock 图标偏好（默认关）。切成 .regular 的 app 必须有 main menu，
        // 否则菜单栏是空的、Cmd+Q / Cmd+W 全部失效 —— LSUIElement app 平时不需要它。
        ConsoleWindowController.applyDockIconPolicy()
        installMainMenu()

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let menu = NSMenu()
        menu.delegate = self
        // 手动管理 enabled：各 unit 子菜单的启动/停止/重启要在动作进行中灰显，autoenable 会把有 action 的项恒置可用
        menu.autoenablesItems = false
        statusItem.menu = menu

        render()
        probe()
        scheduleTimer()
    }

    private func scheduleTimer() {
        timer?.invalidate()
        let t = Timer(timeInterval: probeInterval(menuOpen: menuOpen), repeats: true) { [weak self] _ in
            Task { @MainActor in self?.probe() }
        }
        // ★ 必须是 .common：NSMenu 跟踪期间主 run loop 跑在 NSEventTrackingRunLoopMode，
        // 只注册 .default 的 timer 在菜单打开时**一次都不触发** —— 那样「菜单打开 2s 高频刷新」
        // 这个特性完全是白写的（代理实测 tracking 模式下 0 次触发）。
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    // MARK: 状态轮询

    private func probe() {
        guard !inFlight else { return }
        inFlight = true
        let fast = !menuOpen
        // ★ 三个依赖在**进后台闭包之前**取成局部常量。它们是 @MainActor 隔离的属性，在
        //   Sendable 闭包里经 self 访问就跨了隔离域 —— 那正是这份文件里 14 条并发告警的来源。
        //   三个类型都已声明 Sendable，按值捕获既安全又让编译器接管这条不变量。
        let env = self.env, client = self.client, deviceClient = self.deviceClient
        probeQueue.async { [weak self] in
            guard let self else { return }
            // refresh 会跑登录 shell，**必须在后台**（早前在主线程，shell 卡住就是菜单栏白板）
            env.refresh()
            let result = client.status(fast: fast)
            // 设备快照同轮拉取。**不因 status 失败而跳过**：server 挂了恰恰是最需要看
            // 待审设备的时刻之一（device.js 只读文件，不依赖 server 在线）。
            let devices = deviceClient.list()
            Task { @MainActor in
                self.inFlight = false
                var probeSucceeded = false
                switch result {
                case .ok(let s):
                    probeSucceeded = true
                    self.latest = s
                    self.lastError = nil
                    self.lastOk = Date()
                    self.maybeShowWizard(s)
                case .failed(let e):
                    // **不清空 latest**：断一次就清空会让用户以为服务没了。保留旧值 +
                    // 在摘要行标注「状态已过期 Ns」，同 public/js/app.js 断线时的做法。
                    self.lastError = e
                }
                // 同理保留旧值：拉失败时宁可显示一份可能过期的待审列表，也好过让整段消失——
                // 「没有设备在等」和「我没拉到」在菜单上长得一模一样，而后者会让机主漏掉一台设备。
                if case .ok(let d) = devices { self.latestDevices = d }
                self.writeHeartbeat(ok: probeSucceeded)
                self.render()
            }
        }
    }

    private func maybeShowWizard(_ s: ServiceStatus) {
        guard !wizardShown, s.isSupported, s.setup?.envExists == false else { return }
        wizardShown = true
        runSetupWizard()
    }

    // MARK: 渲染

    /// 这份 bundle 的自证身份。取数在这里（Bundle.main 是宿主状态），拼装在 CCMCore 的
    /// `appIdentityLine` 里（纯函数、有断言）。
    private func appIdentity() -> String {
        let info = Bundle.main
        return appIdentityLine(
            version: info.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
            buildTime: info.object(forInfoDictionaryKey: "CCMBuildTime") as? String,
            commit: info.object(forInfoDictionaryKey: "CCMBuildCommit") as? String,
            bundlePath: info.bundlePath,
            repo: env.repo)
    }

    /// 心跳落盘，供 `scripts/doctor.js` 的 D19 判断菜单栏是不是卡死了。
    ///
    /// ★ **必须写在 probe 的 MainActor 完成回调里，不能挂在 Timer tick 上。**
    ///   scheduleTimer 把 timer 注册在 `.common` 模式，而 `.common` 含
    ///   `NSModalPanelRunLoopMode` —— 模态冻结期间 timer 照常触发，tick 驱动的心跳
    ///   会在 app 已经彻底卡死时显示一切健康，正好在最需要它的时候失效。
    ///   2026-08-23 那 63 小时里被饿死的恰恰是这条回调：`inFlight` 卡在 true、
    ///   fd 冻在 2550 一个不涨，说明后续探测一次都没能启动。
    ///
    /// 成功失败都写：探测**失败**是 server 的问题（doctor 的 LaunchAgent 一项管），
    /// 探测**停摆**才是菜单栏自己的问题 —— 两者必须分得开，否则 server 一挂就误报卡死。
    ///
    /// 用 UserDefaults 而不是新建心跳文件：菜单栏本来就在用它（repo/node/Dock 图标三个键），
    /// 按 bundle id 天然分域，Node 侧一句 `defaults read` 就能读，零路径协商。
    private func writeHeartbeat(ok: Bool) {
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: HEARTBEAT_AT_KEY)
        UserDefaults.standard.set(ok, forKey: HEARTBEAT_OK_KEY)
    }

    private func render() {
        renderIcon()
        // ★ 菜单打开时不重建：removeAllItems 会把用户正在浏览的菜单连同展开的子菜单一起拆掉，
        // 高亮丢失、可能点不中目标项。打开期间只更新图标与 tooltip，内容等关闭后再刷。
        if !menuOpen { renderMenu() }
    }

    private var staleSeconds: Int? {
        guard lastError != nil, let t = lastOk else { return nil }
        return Int(Date().timeIntervalSince(t))
    }

    private func summary() -> String {
        summaryLine(status: latest, problem: env.problem, lastError: lastError, staleSeconds: staleSeconds)
    }

    private func renderIcon() {
        pushStateToConsole()
        guard let button = statusItem.button else { return }
        let name = env.problem == .none ? (latest?.symbol ?? "questionmark.circle") : "questionmark.circle"
        if let image = NSImage(systemSymbolName: name, accessibilityDescription: "ccm") {
            image.isTemplate = true // 单色，随菜单栏明暗自动适配
            button.image = image
            button.title = ""
        } else {
            // SF Symbol 拿不到时留个可点的文字，别变成一条零宽空白
            button.image = nil
            button.title = "ccm"
        }
        button.toolTip = summary()
    }

    private func renderMenu() {
        guard let menu = statusItem.menu else { return }
        menu.removeAllItems()

        let summaryItem = NSMenuItem(title: summary(), action: nil, keyEquivalent: "")
        summaryItem.isEnabled = false
        menu.addItem(summaryItem)

        // 环境错误态：给出自救入口，而不是干瞪眼
        switch env.problem {
        case .noRepo:
            menu.addItem(.separator())
            menu.addItem(action("重新定位仓库…", #selector(relocateRepo)))
            menu.addItem(.separator())
            menu.addItem(action("退出", #selector(quit), key: "q"))
            return
        case .noNode:
            menu.addItem(.separator())
            menu.addItem(action("定位 node…", #selector(relocateNode)))
            menu.addItem(.separator())
            menu.addItem(action("退出", #selector(quit), key: "q"))
            return
        case .none:
            break
        }

        for w in latest?.warnings ?? [] {
            let item = NSMenuItem(title: "⚠ \(w)", action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)
        }

        // 待审设备排在所有常规动作之前：有台设备正卡在门外用不了，这是菜单里最该被立刻
        // 看到的事。没有待审时整段不出现——常态下菜单不该为一件不存在的事留出位置。
        let pending = latestDevices?.pendingList ?? []
        if !pending.isEmpty {
            menu.addItem(.separator())
            let header = NSMenuItem(title: "🔐 \(pending.count) 台新设备等待批准", action: nil, keyEquivalent: "")
            header.isEnabled = false
            menu.addItem(header)
            for d in pending { menu.addItem(pendingDeviceItem(d)) }
        }

        menu.addItem(.separator())
        menu.addItem(action("打开控制台…", #selector(openConsole), key: "\r",
            tip: "服务状态、各 unit 与全部动作的总览窗口；刘海挡住菜单栏图标时的备用入口"))
        // 这两项与控制台按钮共用同一判据（canOpenWebUI / canCopyToken）。此前菜单里
        // 恒可点，而控制台早就门禁住了 —— 同一个产品判断只落实了一半。
        let webUIItem = action("打开 Web UI（并复制令牌）", #selector(openWebUI), key: "o",
            tip: "在浏览器打开本机 ccm，并把访问令牌复制到剪贴板——首次进入粘贴即可")
        webUIItem.isEnabled = canOpenWebUI(status: latest)
        menu.addItem(webUIItem)
        let tokenItem = action("复制访问令牌", #selector(copyToken),
            tip: "仅复制 AUTH_TOKEN（给手机手动登录、或粘贴到别处）")
        tokenItem.isEnabled = canCopyToken(status: latest)
        menu.addItem(tokenItem)

        if let units = latest?.unitList, !units.isEmpty {
            menu.addItem(.separator())
            let grouped = splitUnits(units)
            for u in grouped.primary { menu.addItem(unitItem(u)) }
            if !grouped.secondary.isEmpty {
                let more = NSMenuItem(title: "其他服务", action: nil, keyEquivalent: "")
                more.toolTip = "定时器与自启项等低频服务——「待机」是它们的正常状态"
                let sub = NSMenu()
                sub.autoenablesItems = false
                for u in grouped.secondary { sub.addItem(unitItem(u)) }
                more.submenu = sub
                menu.addItem(more)
            }
        }

        menu.addItem(.separator())
        menu.addItem(action("配置…", #selector(openConfig), key: ",",
            tip: "配置表单（读写 ccm.config.json，密钥打码）；server 没起来时也能用。改完记得从上面的 server 一行点「重启」让它生效"))
        menu.addItem(action("查看日志", #selector(openLogs),
            tip: "内嵌日志窗口，下拉框可在 server / tunnel 等各服务日志间切换"))
        menu.addItem(action("运行体检（doctor）", #selector(runDoctor),
            tip: "17 项自检：token、CLI、端口、权限、桥接状态……觉得哪里不对劲先跑它"))
        menu.addItem(action("在 Finder 中显示仓库", #selector(revealRepo),
            tip: "打开项目所在文件夹"))

        menu.addItem(.separator())
        let autostart = action("开机自启（菜单栏）", #selector(toggleAutostart),
            tip: "登录后自动出现本菜单栏图标（安装/卸载 menubar 自启项）。与 server 是否常驻无关")
        autostart.state = menubarInstalled ? .on : .off
        menu.addItem(autostart)
        if latest?.setup?.envExists == false {
            menu.addItem(action("首次安装向导…", #selector(setupWizard)))
        }

        menu.addItem(.separator())
        // 身份行紧挨着「更新桌面端」：那正是你需要确认「刚才换上的是哪一份」的时刻。
        // 放在这里而不是菜单顶部，是为了不给每次开菜单都加一行噪音。
        let idItem = NSMenuItem(title: appIdentity(), action: nil, keyEquivalent: "")
        idItem.isEnabled = false
        idItem.toolTip = "这份 CCM.app 的身份：版本 · 编译时刻 · git commit · 装在哪。"
            + "两份 bundle 的版本号是一样的，能分辨它们的是后两段"
        menu.addItem(idItem)
        menu.addItem(action("更新桌面端（重新编译）", #selector(updateApp),
            tip: "一键完成：用当前仓库源码重新编译 → 装进 /Applications → 自动重启本 app 换上新版。拉了新代码后点这一个就够"))
        menu.addItem(action("重启应用", #selector(relaunchApp),
            tip: "只重启不编译（app 行为异常时试它）；不影响 server"))
        menu.addItem(action("退出", #selector(quit), key: "q",
            tip: "关闭菜单栏图标。server 照常运行，手机不受影响"))
    }

    private var menubarInstalled: Bool {
        latest?.unitList.first { $0.unit == "menubar" }.map { $0.stateName != "not-installed" } ?? false
    }

    private func unitItem(_ u: UnitStatus) -> NSMenuItem {
        let item = NSMenuItem(title: unitTitle(u), action: nil, keyEquivalent: "")
        item.toolTip = unitTooltip(u)
        let sub = NSMenu()
        sub.autoenablesItems = false
        let name = u.unitName

        if let d = u.detail, !d.isEmpty {
            let line = NSMenuItem(title: d, action: nil, keyEquivalent: "")
            line.isEnabled = false
            sub.addItem(line)
            sub.addItem(.separator())
        }

        if u.stateName != "not-installed" {
            let idle = isControlEnabled(unit: name, busyUnits: busyUnits)
            let start = unitAction("启动", unit: name, verb: "start")
            let stop = unitAction("停止", unit: name, verb: "stop")
            let restart = unitAction("重启", unit: name, verb: "restart")
            start.isEnabled = idle
            stop.isEnabled = idle
            restart.isEnabled = idle
            sub.addItem(start)
            sub.addItem(stop)
            sub.addItem(restart)
            sub.addItem(.separator())
            sub.addItem(unitAction("查看日志", unit: name, verb: "logs"))
        } else if u.isWritable {
            // 「在终端里安装…」而不是「安装」：tunnel 的隧道名等参数只有用户知道，
            // 而 L1 的 precheck 会拒绝缺参数的调用。开终端给一条待补全的命令，比给一个
            // 点了必然报错的按钮诚实（第一轮审查抓到的就是后者）。
            sub.addItem(unitAction("在终端里安装…", unit: name, verb: "install"))
        }

        item.submenu = sub
        return item
    }

    /// 待审设备一行 + 准入/拒绝子菜单。完整 ID 放 tooltip：菜单标题里塞不下 32 位 hex，
    /// 而机主核对时需要看到全量——手机屏幕上显示的就是全量那串。
    private func pendingDeviceItem(_ d: PendingDevice) -> NSMenuItem {
        let item = NSMenuItem(title: pendingDeviceTitle(d), action: nil, keyEquivalent: "")
        item.toolTip = "完整 ID：\(d.id)\n先和手机屏幕上显示的 ID 核对，再决定是否准入。"
        let sub = NSMenu()
        sub.autoenablesItems = false

        let approve = NSMenuItem(title: "✓ 准入", action: #selector(approvePendingDevice(_:)), keyEquivalent: "")
        approve.target = self
        approve.representedObject = d.id
        approve.toolTip = "加入信任表。该设备当前那条连接会被即时解锁——server 监听 trusted-devices.json，无需重启。"

        let deny = NSMenuItem(title: "✗ 拒绝", action: #selector(denyPendingDevice(_:)), keyEquivalent: "")
        deny.target = self
        deny.representedObject = d.id
        deny.toolTip = "移出待审列表并断开该设备。这不是拉黑——同一台设备之后仍可重新申请。"

        sub.addItem(approve)
        sub.addItem(deny)
        item.submenu = sub
        return item
    }

    private func unitAction(_ title: String, unit: String, verb: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: #selector(runUnitAction(_:)), keyEquivalent: "")
        item.target = self
        item.representedObject = ["unit": unit, "verb": verb]
        return item
    }

    private func action(_ title: String, _ sel: Selector, key: String = "", tip: String? = nil) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: sel, keyEquivalent: key)
        item.target = self
        item.toolTip = tip
        return item
    }

    // MARK: NSMenuDelegate

    func menuWillOpen(_ menu: NSMenu) {
        menuOpen = true
        scheduleTimer()
        // 打开瞬间先用当前数据渲染一次（此时 menuOpen 已为 true，render 不会重建，
        // 所以这里显式调 renderMenu），再触发一次探测；探测回来的结果留到下次打开。
        renderMenu()
        probe()
    }

    func menuDidClose(_ menu: NSMenu) {
        menuOpen = false
        scheduleTimer()
        renderMenu() // 补上打开期间被跳过的那次刷新
    }

    // MARK: 动作

    // MARK: 设备审批
    //
    // 只有「准入」二次确认：它把一台设备**永久**写进信任表，之后能读会话内容、能向 claude 发消息，
    // 误点的代价不对称。拒绝是安全方向，且 denyDevice 只是移出列表不拉黑（同一设备仍可重新申请），
    // 再加一道确认只会让人在真该拒绝时犹豫。

    @objc private func approvePendingDevice(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String, !id.isEmpty else { return }
        let alert = NSAlert()
        alert.messageText = "准入这台新设备？"
        // 完整 ID 摊开在确认框里：这是整道审批唯一的核对依据，菜单标题里是截断的。
        alert.informativeText = """
        设备 ID：\(id)

        先和手机屏幕上显示的 ID 逐位核对。准入后这台设备将被永久信任——能读取会话内容、能向 claude 发消息。
        """
        alert.addButton(withTitle: "准入")
        alert.addButton(withTitle: "取消")
        alert.alertStyle = .warning
        guard runModal(alert) == .alertFirstButtonReturn else { return }
        decidePendingDevice(id, verb: "approve", label: "准入设备")
    }

    @objc private func denyPendingDevice(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String, !id.isEmpty else { return }
        decidePendingDevice(id, verb: "deny", label: "拒绝设备")
    }

    private func decidePendingDevice(_ id: String, verb: String, label: String) {
        let deviceClient = self.deviceClient
        actionQueue.async { [weak self] in
            guard let self else { return }
            let r = deviceClient.decide(verb, deviceId: id)
            Task { @MainActor in
                // ★ 用 alert 而不是写 lastError：这个回调里没有 render()，写进去当场就不显示；
                //   而紧接着的 probe() 一旦成功又会把 lastError 置回 nil —— 那条错误在被显示
                //   之前就已经消失了，「准入失败」100% 不可见。旁边 runUnitAction 的失败路径
                //   用的就是 alert，两条相邻路径此前一条看得见、一条完全吞掉。
                if case .failed(let e) = r { self.alert("\(label)失败", e) }
                // 成败都立刻重探。失败时同样要刷：那台设备可能刚被别的入口处理掉了
                // （web 端远程准入 / headless 终端回车），此时"失败"的真相是"已经没了"。
                self.probe()
            }
        }
    }

    @objc private func runUnitAction(_ sender: NSMenuItem) {
        guard let info = sender.representedObject as? [String: String],
              let unit = info["unit"], let verb = info["verb"] else { return }
        // 拆成两段：菜单项自带的 representedObject 坏掉是程序错误（静默返回即可），
        // 而「找不到仓库」是用户能处理的状况，得说出来 —— 见 requireRepo。
        guard let repo = requireRepo() else { return }

        switch verb {
        case "logs":
            // 直接打开内嵌日志窗口并预选该 unit 的源——此前在任务窗口跑 service.js logs
            // 打一段一次性文本，被机主读成「让我去某某文件看」（2026-08-17 反馈）。
            openLogsWindow(preferUnit: unit)
            return
        case "install":
            runTask("安装 \(unit)", installSteps(unit: unit, repo: repo, appPath: Bundle.main.bundlePath))
            return
        default:
            break
        }

        if verb == "stop", unit == "server" {
            let alert = NSAlert()
            alert.messageText = "停止 ccm server？"
            alert.informativeText = "手机将立刻失去连接，直到你再次启动它。"
            alert.addButton(withTitle: "停止")
            alert.addButton(withTitle: "取消")
            alert.alertStyle = .warning
            guard runModal(alert) == .alertFirstButtonReturn else { return }
        }

        busyUnits.insert(unit)
        let client = self.client
        actionQueue.async { [weak self] in
            guard let self else { return }
            let r = client.control(verb, unit: unit)
            Task { @MainActor in
                self.busyUnits.remove(unit)
                if case .failed(let e) = r { self.alert("操作失败", e) }
                self.probe()
            }
        }
    }

    /// 打开 Web UI 前先把令牌送进剪贴板 —— lanUrl 不含 `#token=`，没有这一步用户只会
    /// 落到一个令牌输入页而手上什么都没有。令牌全程走 L1 的 pbcopy，不进本进程内存。
    @objc private func openWebUI() {
        let url = webUIURL(status: latest)
        let client = self.client
        actionQueue.async { [weak self] in
            // 只判存活、不绑定：client 已经按值捕获，闭包里再没有用到 self 的地方。
            // 但这条早退有真实语义 —— app 已经退出就别再去动用户的剪贴板。
            guard self != nil else { return }
            let copied = client.copyToken()
            Task { @MainActor in
                if let u = URL(string: url) { NSWorkspace.shared.open(u) }
                if case .failed = copied {
                    // 取不到令牌 → 浏览器那边会停在令牌输入框。此前这里的注释是「未设 AUTH_TOKEN 的
                    // 本机部署本就直接可用」，那条路已被 hard-rules §1「鉴权是启动前提」取消：
                    // 没有 token 时 server 根本起不来，所以取不到只可能是读配置失败。
                    return
                }
            }
        }
    }

    @objc private func copyToken() {
        let client = self.client
        actionQueue.async { [weak self] in
            guard let self else { return }
            let r = client.copyToken()
            Task { @MainActor in
                switch r {
                case .ok: self.alert("已复制", "访问令牌已在剪贴板里，粘贴到网页的令牌框即可。")
                case .failed(let e): self.alert("复制失败", e)
                }
            }
        }
    }

    /// 内嵌日志窗口。**不再丢给 Terminal**：那要用户自己在一堆窗口里找它，
    /// 而且关掉 app 之后那个 tail 还在跑。内嵌的随窗口关闭停止轮询。
    @objc private func openConfig() {
        // ?.window == nil：窗口被关闭后 NSWindow 可能已随之释放，复用旧 controller 的
        // showWindow 会无窗可显——点击从此静默失效（2026-08-17 全菜单点击验证抓到，
        // doctor 复现 3/3）。重建 controller 是无条件正确的防御。
        if configWindow == nil || configWindow?.window == nil { configWindow = ConfigWindowController(env: env) }
        configWindow?.present()
    }

    @objc private func openLogs() { openLogsWindow(preferUnit: nil) }

    private func openLogsWindow(preferUnit: String?) {
        if logWindow == nil || logWindow?.window == nil { logWindow = LogWindowController(env: env) } // 同 openConfig 的防御
        logWindow?.present(preferUnit: preferUnit)
    }

    @objc private func runDoctor() {
        guard let repo = requireRepo() else { return }
        runTask("体检", doctorSteps(repo: repo))
    }

    @objc private func revealRepo() {
        guard let repo = requireRepo() else { return }
        NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: repo)
    }

    @objc private func toggleAutostart() {
        guard let repo = requireRepo() else { return }
        // 卸载是破坏性动作，GUI 里必须先问一句 —— CLI 那侧靠 --yes 表达意图，
        // 而菜单项点一下就执行，没有等价的「我确认」环节。
        if menubarInstalled {
            let a = NSAlert()
            a.messageText = "取消开机自启？"
            a.informativeText = "会移除菜单栏的 LaunchAgent。app 本身不受影响，随时可以再打开。"
            a.addButton(withTitle: "取消自启")
            a.addButton(withTitle: "算了")
            guard runModal(a) == .alertFirstButtonReturn else { return }
            runTask("取消开机自启", uninstallSteps(unit: "menubar", repo: repo))
        } else {
            let path = Bundle.main.bundlePath
            // 跑在仓库构建目录里就先拦一道。service.js 的 status 现在会为这种情况报一条警告，
            // 但那是【事后】——等你看到警告时 LaunchAgent 已经指错了。这里在事前问一句。
            if isRunningFromRepoBuild(bundlePath: path, repo: repo) {
                let a = NSAlert()
                a.messageText = "先装到 /Applications 再设自启？"
                a.informativeText = """
                当前运行的是仓库里的构建产物：
                \(path.dropFirst(repo.count + 1))

                它被 gitignore，git clean 或换分支就会消失，届时开机自启静默失效（登录后菜单栏没有图标，且没有任何地方会告诉你为什么）。

                建议先跑 npm run app:install（或菜单里的「更新桌面端」）装到 /Applications，从那里再勾自启。
                """
                a.addButton(withTitle: "仍然设为自启")
                a.addButton(withTitle: "取消")
                a.alertStyle = .warning
                guard runModal(a) == .alertFirstButtonReturn else { return }
            }
            runTask("设置开机自启", installSteps(unit: "menubar", repo: repo, appPath: path))
        }
    }

    @objc private func relocateRepo() {
        guard let path = pickDirectory(title: "选择 claude-chat-mobile 仓库目录") else { return }
        guard RuntimeEnv.isRepo(path) else {
            alert("这不像是 ccm 仓库", "选中的目录里没有 scripts/service.js。")
            return
        }
        env.relocateRepo(path)
        probe()
    }

    @objc private func relocateNode() {
        let panel = NSOpenPanel()
        panel.title = "选择 node 可执行文件"
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.showsHiddenFiles = true
        guard runModal(panel) == .OK, let url = panel.url else { return }
        env.relocateNode(url.path)
        probe()
    }

    @objc private func setupWizard() { runSetupWizard() }

    @objc private func quit() { NSApp.terminate(nil) }

    /// 「更新桌面端」一键项：编译+安装（任务窗口可见每步输出），成功后自动重启换新版。
    /// 失败则窗口停在失败步骤，不触发重启——旧版继续跑，永远有一个能用的 app。
    @objc private func updateApp() {
        guard let repo = requireRepo() else { return }
        runTask("更新桌面端", updateAppSteps(repo: repo), onSuccess: { [weak self] in
            // 让「全部完成」被看见一瞬，再重启换新版
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { self?.relaunchApp() }
        })
    }

    /// 重启自身：分离子进程 sleep 后 open 本 bundle，自己立即退出。
    /// 用于 app:build / app:install 升级后换上新产物 —— 此前只能「退出 + 回终端 open」。
    @objc private func relaunchApp() {
        let argv = relaunchArgv(bundlePath: Bundle.main.bundlePath)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: argv[0])
        p.arguments = Array(argv.dropFirst())
        // argv[0] 是绝对路径、这条本身不依赖 PATH，仍然统一注入：环境该怎么给只有一个答案，
        // 留一处特例就等于让下一个人自己判断「我这条需不需要」——那正是 bug 的复发入口。
        p.environment = childProcessEnvironment()
        try? p.run()
        NSApp.terminate(nil)
    }

    // MARK: 首次装机向导
    //
    // **这是 Swift 在整个方案里存在的唯一硬理由**：scripts/setup.js 的 resolveSetupPlan 规定
    // 非交互模式必须显式 --work-dir 且绝不回落 $HOME（"那等于把整个家目录交给 agent"），
    // 而零命令行用户没法输路径。NSOpenPanel 正好补上这一个洞。
    //
    // 其余每步仍然委托 CLI（判定只有一份），但在**内嵌任务窗口**里跑：用户看得见每一步的
    // 真实输出、失败时报错就在眼前，而不必切到 Terminal。桌面端不再依赖任何终端。
    private func runSetupWizard() {
        guard let repo = requireRepo() else { return }

        let welcome = NSAlert()
        welcome.messageText = "配置 ccm"
        welcome.informativeText = """
        接下来会做四件事：
        1. 选一个工作目录（claude 的默认目录）
        2. 生成 ccm.config.json（含随机访问令牌）
        3. 安装常驻服务并启动
        4. 打一次 /health，确认真的能用

        全部在一个任务窗口里执行，你能看到每一步的真实输出。
        """
        welcome.addButton(withTitle: "继续")
        welcome.addButton(withTitle: "取消")
        guard runModal(welcome) == .alertFirstButtonReturn else { return }

        guard let workDir = pickDirectory(title: "选择 claude 的工作目录") else { return }

        let hooksAlert = NSAlert()
        hooksAlert.messageText = "安装 CLI hooks 桥？"
        hooksAlert.informativeText = "装了之后，你在电脑终端里跑的 claude 会话，回合结束或需要你决策时能即时推到手机。不装也能用，只是靠轮询、没有推送。"
        hooksAlert.addButton(withTitle: "安装")
        hooksAlert.addButton(withTitle: "先不装")
        let hooks = runModal(hooksAlert) == .alertFirstButtonReturn

        runTask("首次安装", setupSteps(repo: repo, workDir: workDir, hooks: hooks))
    }

    // MARK: 主窗口与 Dock

    /// .regular 模式下必须有 main menu，否则用户看到一条空菜单栏、Cmd+Q 也按不了。
    /// 只建最小集：应用菜单（关于/隐藏/退出）+ 窗口菜单（关闭/最小化）。
    private func installMainMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 CCM", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏 CCM", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 CCM", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let winItem = NSMenuItem()
        let winMenu = NSMenu(title: "窗口")
        winMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        winMenu.addItem(withTitle: "关闭", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        winItem.submenu = winMenu
        main.addItem(winItem)

        NSApp.mainMenu = main
        NSApp.windowsMenu = winMenu
    }

    @objc private func openConsole() {
        // 与 openConfig / openLogsWindow / runTask 同一条防御：程序化建的 NSWindow 在关闭时被释放，
        // controller 还在但 .window 已成 nil，此后 showWindow 无窗可显、点击静默失效。
        // 这里漏掉这一半的代价比另外三个都大 —— 控制台正是刘海挤掉状态栏图标时的救命入口，
        // 而 applicationShouldHandleReopen（Dock 图标）走的也是本方法，关一次就两条路一起死。
        if consoleWindow == nil || consoleWindow?.window == nil { consoleWindow = ConsoleWindowController(app: self) }
        pushStateToConsole()
        consoleWindow?.present()
    }

    /// 菜单栏那盏灯与控制台用**同一份**状态，避免两处各刷各的、显示不一致。
    private func pushStateToConsole() {
        guard let c = consoleWindow else { return }
        let stale = lastOk.map { Int(Date().timeIntervalSince($0)) }
        c.refresh(status: latest, problem: env.problem, lastError: lastError,
                  staleSeconds: lastError == nil ? nil : stale, repo: env.repo,
                  identity: appIdentity())
    }

    /// 点 Dock 图标（app 已在跑、没有可见窗口时）走这里 —— 这正是刘海场景下的救命入口。
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { openConsole() }
        return true
    }

    /// 控制台按钮的分派。判定在 CCMCore 的 consoleActions，这里只负责执行。
    func performConsoleAction(_ kind: ConsoleActionKind) {
        switch kind {
        case .openWebUI: openWebUI()
        case .copyToken: copyToken()
        case .config: openConfig()
        case .logs: openLogs()
        case .doctor: runDoctor()
        case .relocateRepo: relocateRepo()
        case .relocateNode: relocateNode()
        case .setupWizard: setupWizard()
        }
    }

    // MARK: 小工具

    private func activate() {
        NSApp.activate(ignoringOtherApps: true)
    }

    /// 取仓库路径，取不到就说清楚——而不是静默什么都不发生。
    ///
    /// 菜单**渲染之后**仓库才被移动/删除时，那些菜单项仍然留在屏幕上；此前五处同形的
    /// `guard let repo = env.repo else { return }` 让点击字面意义上毫无反应，而 runTask
    /// 里那句「环境不完整」提示被它们全部抢在了前面。「点了没反应」是这个 app 反复出现的
    /// 失败形态，能少一处是一处。
    private func requireRepo() -> String? {
        if let repo = env.repo { return repo }
        alert("环境不完整", "找不到 ccm 仓库。用菜单里的「重新定位仓库…」重新指一下。")
        return nil
    }

    /// 把模态窗抬到**所有 app 的普通窗口之上**，且不依赖「这个 app 能不能被激活」。
    ///
    /// 【这道防线的代价是实测出来的，2026-08-23】机主点了「停止 server」，确认框好端端地
    /// 待在 (830,215)、260×218、没有最小化，只是被别的窗口盖住；主线程就此冻在
    /// `-[NSAlert runModal]` 里 **63 小时**。表现是「菜单能弹出、能高亮、点什么都没反应，
    /// 连『退出』也没反应」—— 状态栏菜单由系统侧（NSContextMenuImpl）渲染，所以照样弹得
    /// 出来也高亮得了，但菜单项的 action 派发必须回主线程。LSUIElement 又没有 Dock 图标、
    /// 不进 Cmd+Tab，用户手上**没有任何入口**能把那个窗口翻上来，只能去终端 `killall CCM`。
    ///
    /// 光靠 activate() 救不回来：`NSApp.activate(ignoringOtherApps:)` 自 macOS 14 起已废弃，
    /// 系统会拒绝把一个非前台的 accessory app 提到前面 —— 当时实测连 `open -a CCM.app`
    /// 之后 `frontmost` 都还是 false。所以**可见性绝不能寄托在「能否激活」上**。下面三件
    /// 事都绕开它：
    ///   - `orderFrontRegardless()` 顾名思义，不看激活权限；
    ///   - `.modalPanel` 层级压住所有 app 的普通窗口（仍低于菜单栏的 `.mainMenu`）；
    ///   - `.canJoinAllSpaces` 让它跟着用户切 Space，堵掉「窗口留在另一个桌面」那条路。
    ///
    /// 残留风险要说在前面：这仍然是**阻塞主线程**的模态。万一哪天连这三招都被系统改掉，
    /// app 会再次整体卡死且退不掉，唯一出路依旧是 `killall CCM`。彻底根治得把所有
    /// runModal 改成 `beginSheetModal` 的非阻塞回调——那是另一次改动，不在这次范围内。
    private func raiseAboveEverything(_ window: NSWindow) {
        window.level = .modalPanel
        window.collectionBehavior.insert(.canJoinAllSpaces)
        window.orderFrontRegardless()
    }

    private func runModal(_ alert: NSAlert) -> NSApplication.ModalResponse {
        activate()
        raiseAboveEverything(alert.window)
        return alert.runModal()
    }

    /// NSOpenPanel 与 NSAlert 同病同治：它一样是把主线程占死的 runModal。收进同一个包装器，
    /// `ccm-menubar-tests.swift` 里那道源码闸才能守住「没有裸 runModal」这条不变量。
    private func runModal(_ panel: NSOpenPanel) -> NSApplication.ModalResponse {
        activate()
        raiseAboveEverything(panel)
        return panel.runModal()
    }

    private func pickDirectory(title: String) -> String? {
        let panel = NSOpenPanel()
        panel.title = title
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        return runModal(panel) == .OK ? panel.url?.path : nil
    }

    private func alert(_ title: String, _ body: String) {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = body
        a.alertStyle = .warning
        _ = runModal(a)
    }

    /// 在内嵌任务窗口里跑，**不再切 Terminal**。
    ///
    /// 旧实现拼一条 shell 串交给 osascript 的 `do script`，理由是「每一步都看得见输出」——
    /// 理由对，结论错：用户要的是看得见输出，不是切换到终端。自己开窗口两个目标都满足，
    /// 且不再需要 shellQuote + AppleScript 转义那两层易错的引号处理。
    private func runTask(_ title: String, _ steps: [TaskStep], onSuccess: (() -> Void)? = nil) {
        guard let node = env.node, let repo = env.repo else {
            alert("环境不完整", "找不到 node 或仓库目录，先在菜单里重新定位。")
            return
        }
        if taskWindow == nil || taskWindow?.window == nil { taskWindow = TaskWindowController() } // 同 openConfig 的防御
        taskWindow?.run(title: title, steps: steps, node: node, cwd: repo, onSuccess: onSuccess)
    }
}

// MARK: - 入口
//
// 用 @main 而不是顶层语句：编译走 -parse-as-library（AppKit app 的标准姿势），那种模式下
// 顶层表达式非法，且 AppDelegate 带 @MainActor、不能在 nonisolated 上下文里构造。

@main
struct CCMApp {
    @MainActor
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory) // 与 Info.plist 的 LSUIElement 一致：无 Dock 图标
        // NSApplication.delegate 是 weak —— 不显式延长生命周期的话，ARC 可能在 run() 之前
        // 就把 delegate 回收掉（最后一次使用是上一行），菜单栏会变成一个点不开的死图标。
        withExtendedLifetime(delegate) {
            app.run()
        }
    }
}
