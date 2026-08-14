// ccm-menubar.swift —— 常驻服务的菜单栏控制台。
//
// 用 `npm run app:build` 编译（swiftc 单文件 → .app bundle，不建 Xcode 工程、不加 npm 依赖）。
//
// ## 唯一的架构纪律：本文件零业务逻辑
//
// 「这个 unit 什么状态、归谁管、有没有漂移、该显示什么话」全部由 scripts/service.js 的
// `status --json` 决定，本文件只把那份 JSON 渲染成菜单。**永不自己解析 launchctl 输出**，
// 也不自己拼人类可读文案——那些判据（漂移的语义比对、flapping 的四档分类、ownership 的
// 归属护栏）在 Node 侧有 190 多个单测护着，在这里重写一遍等于让它们慢慢分叉。
//
// 后果是这个文件出 bug 的最坏情况只是「菜单显示不对」，不会做错事：它没有删除逻辑、
// 没有路径计算、没有状态判定。
//
// ## 为什么状态灯用 SF Symbols 而不是 public/icons/ 里那套
// LSUIElement=1 的 app 没有 Dock 图标、不进 app switcher，唯一可见的美术资源就是菜单栏那个
// item —— 它应该是 template image（单色、随系统明暗与菜单栏着色自动适配），而 PWA 那套是
// 彩色位图。用 SF Symbols 还省掉了 .icns 与整条图标构建链。

import AppKit
import Foundation

// MARK: - L1 的输出契约（对应 scripts/service.js 的 STATUS_SCHEMA_VERSION = 1）
//
// 字段全部可选或带默认：Swift 侧解码失败会让整个菜单空掉，而 Node 侧加字段是常事。
// 宁可少显示一行，也不能因为多了个不认识的字段就整个瞎掉。

struct ListenInfo: Decodable {
    let port: Int
    let reachable: Bool
}

struct UnitStatus: Decodable {
    let unit: String
    let label: String
    let known: Bool
    let ownership: String   // managed | adoptable | foreign | unknown
    let state: String       // not-installed | stopped | running | crashed
    let pid: Int?
    let flapping: Bool
    let drift: [String]
    let listen: ListenInfo?
    let detail: String

    /// 菜单栏那盏灯的字符前缀。与 scripts/service.js 的 formatStatus 保持同一套符号，
    /// 这样 CLI 与 GUI 看到的是同一种语言。
    var lamp: String {
        if flapping { return "◐" }
        switch state {
        case "running": return "●"
        case "stopped": return "○"
        case "crashed": return "✗"
        default: return "·"
        }
    }

    /// 这个 unit 是否允许 install / uninstall。判据来自 L1 的 ownership，本文件不重算。
    var isWritable: Bool { ownership == "managed" || ownership == "adoptable" }
}

struct SetupInfo: Decodable {
    let envExists: Bool
    let port: Int?
    let lanUrl: String?
}

struct ServiceStatus: Decodable {
    let schemaVersion: Int
    let platform: String
    let supported: Bool
    let repo: String
    let setup: SetupInfo
    let units: [UnitStatus]
    let warnings: [String]

    var server: UnitStatus? { units.first { $0.unit == "server" } }

    /// 整体健康度 → 状态灯图标。优先级：环境坏 > 服务挂 > 有告警 > 正常。
    var symbol: String {
        guard supported else { return "questionmark.circle" }
        guard let s = server else { return "questionmark.circle" }
        if s.state == "crashed" { return "xmark.octagon" }
        if s.state == "not-installed" { return "exclamationmark.triangle" }
        if units.contains(where: { $0.flapping }) { return "exclamationmark.triangle" }
        if units.contains(where: { !$0.drift.filter { $0 != "shape" }.isEmpty }) { return "exclamationmark.triangle" }
        if s.state != "running" { return "exclamationmark.triangle" }
        return "checkmark.circle"
    }
}

// MARK: - 运行环境：仓库在哪、node 在哪
//
// 两个都可能失效（仓库被移动、nvm 换版本），失效时不是崩溃而是进入一个能自救的错误态。

final class RuntimeEnv {
    private static let repoKey = "CCMRepoPath"
    private static let nodeKey = "CCMNodePath"

    private(set) var repo: String?
    private(set) var node: String?

    init() {
        repo = RuntimeEnv.resolveRepo()
        node = RuntimeEnv.resolveNode()
    }

    /// 仓库路径三级解析。有效性判据是 **scripts/service.js 存在**，不是目录存在 ——
    /// 仓库被删后父目录往往还在，只判目录会给出一个假绿。
    private static func resolveRepo() -> String? {
        let candidates = [
            UserDefaults.standard.string(forKey: repoKey),
            Bundle.main.object(forInfoDictionaryKey: repoKey) as? String,
        ]
        for case let path? in candidates where isRepo(path) { return path }
        return nil
    }

    static func isRepo(_ path: String) -> Bool {
        FileManager.default.fileExists(atPath: (path as NSString).appendingPathComponent("scripts/service.js"))
    }

    /// node 路径：**绝不依赖 PATH**。GUI app 的环境不是登录 shell，PATH 里通常没有 homebrew。
    /// 走 `zsh -lc 'command -v node'` 与 plist 自身的启动方式同源（终端等价性），
    /// nvm 换版本也能自动跟上。失败回落到 build 时烘进 Info.plist 的那个。
    private static func resolveNode() -> String? {
        if let out = runSync("/bin/zsh", ["-lc", "command -v node"])?.stdout,
           let first = out.split(separator: "\n").first {
            let p = String(first).trimmingCharacters(in: .whitespaces)
            if !p.isEmpty && FileManager.default.isExecutableFile(atPath: p) { return p }
        }
        if let baked = Bundle.main.object(forInfoDictionaryKey: nodeKey) as? String,
           FileManager.default.isExecutableFile(atPath: baked) { return baked }
        return nil
    }

    func relocateRepo(_ path: String) {
        UserDefaults.standard.set(path, forKey: RuntimeEnv.repoKey)
        repo = path
    }

    func relocateNode(_ path: String) {
        UserDefaults.standard.set(path, forKey: RuntimeEnv.nodeKey)
        node = path
    }

    func refresh() {
        if repo == nil { repo = RuntimeEnv.resolveRepo() }
        if node == nil { node = RuntimeEnv.resolveNode() }
    }
}

// MARK: - 进程调用

/// 简易结果类型。Swift 的 Result 要求错误类型遵循 Error，而这里的「错误」只是一句给用户看的话，
/// 为它造一个 Error struct 属于纯样板。
enum Probe<T> {
    case ok(T)
    case failed(String)
}

struct RunResult {
    let status: Int32
    let stdout: String
    let stderr: String
}

/// 同步跑一个命令。只在后台队列里调用 —— 主线程跑这个会卡住整个菜单栏。
@discardableResult
func runSync(_ launchPath: String, _ args: [String], cwd: String? = nil, timeout: TimeInterval = 10) -> RunResult? {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: launchPath)
    task.arguments = args
    if let cwd { task.currentDirectoryURL = URL(fileURLWithPath: cwd) }

    let out = Pipe(), err = Pipe()
    task.standardOutput = out
    task.standardError = err

    do { try task.run() } catch { return nil }

    // 超时兜底：service.js 正常在 100ms 内返回，卡住多半是 launchctl 或 plutil 挂了。
    let deadline = Date().addingTimeInterval(timeout)
    let outData = out.fileHandleForReading.readDataToEndOfFile()
    let errData = err.fileHandleForReading.readDataToEndOfFile()
    while task.isRunning && Date() < deadline { usleep(20_000) }
    if task.isRunning { task.terminate(); return nil }
    task.waitUntilExit()

    return RunResult(
        status: task.terminationStatus,
        stdout: String(data: outData, encoding: .utf8) ?? "",
        stderr: String(data: errData, encoding: .utf8) ?? ""
    )
}

/// 调 L1。所有对服务的认知都从这里来。
final class ServiceClient {
    private let env: RuntimeEnv
    init(env: RuntimeEnv) { self.env = env }

    private func script(_ name: String) -> String? {
        guard let repo = env.repo else { return nil }
        return (repo as NSString).appendingPathComponent("scripts/\(name)")
    }

    /// `service.js status --json`。fast=true 跳过 TCP 探测，给高频轮询用。
    func status(fast: Bool) -> Probe<ServiceStatus> {
        guard let node = env.node else { return .failed("找不到 node") }
        guard let repo = env.repo, let js = script("service.js") else { return .failed("找不到仓库") }

        var args = [js, "status", "--json"]
        if fast { args.append("--fast") }
        guard let r = runSync(node, args, cwd: repo, timeout: 8) else { return .failed("service.js 无响应") }
        guard r.status == 0 else {
            return .failed(firstLine(r.stderr).isEmpty ? "service.js 退出码 \(r.status)" : firstLine(r.stderr))
        }
        guard let data = r.stdout.data(using: .utf8),
              let parsed = try? JSONDecoder().decode(ServiceStatus.self, from: data) else {
            return .failed("service.js 输出无法解析")
        }
        return .ok(parsed)
    }

    /// 启停重启。**不判归属**——那是 L1 的事（它对 foreign/unknown 也允许启停，只拒绝写 plist）。
    func control(_ action: String, unit: String) -> Probe<Void> {
        guard let node = env.node, let repo = env.repo, let js = script("service.js") else {
            return .failed("环境不完整")
        }
        guard let r = runSync(node, [js, action, unit, "--json"], cwd: repo, timeout: 30) else {
            return .failed("service.js 无响应")
        }
        if r.status == 0 { return .ok(()) }
        // 错误文案原样取自 L1，不在这里二次加工
        if let data = r.stdout.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let msg = obj["error"] as? String {
            return .failed(msg)
        }
        return .failed(firstLine(r.stderr))
    }
}

func firstLine(_ s: String) -> String {
    s.split(separator: "\n").first.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
}

// MARK: - 菜单栏应用

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem!
    private let env = RuntimeEnv()
    private lazy var client = ServiceClient(env: env)
    private let queue = DispatchQueue(label: "ccm.menubar.probe")

    private var latest: ServiceStatus?
    private var lastError: String?
    private var lastUpdate: Date?
    private var timer: Timer?
    private var menuOpen = false
    private var inFlight = false

    // 菜单关着时只需要给灯上色，10s 足够；打开时用户在盯着，2s。
    private var interval: TimeInterval { menuOpen ? 2 : 10 }

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu

        render()
        probe()
        scheduleTimer()

        // 全新机器：.env 都没有，直接把装机向导递到脸前。
        if env.repo != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                guard let self, let s = self.latest, s.supported, !s.setup.envExists else { return }
                self.runSetupWizard()
            }
        }
    }

    private func scheduleTimer() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.probe() }
        }
    }

    // MARK: 状态轮询

    private func probe() {
        guard !inFlight else { return }
        env.refresh()
        inFlight = true
        let fast = !menuOpen
        queue.async { [weak self] in
            guard let self else { return }
            let result = self.client.status(fast: fast)
            Task { @MainActor in
                self.inFlight = false
                switch result {
                case .ok(let s):
                    self.latest = s
                    self.lastError = nil
                    self.lastUpdate = Date()
                case .failed(let e):
                    // **不清空 latest**：断一次就把面板清空会让用户以为服务没了。
                    // 保留旧值 + 在摘要行标注「状态已过期 Ns」，同 public/js/app.js 断线时的做法。
                    self.lastError = e
                }
                self.render()
            }
        }
    }

    // MARK: 渲染

    private func render() {
        renderIcon()
        renderMenu()
    }

    private func renderIcon() {
        guard let button = statusItem.button else { return }
        let name: String
        if env.repo == nil || env.node == nil {
            name = "questionmark.circle"
        } else if let s = latest {
            name = s.symbol
        } else {
            name = "questionmark.circle"
        }
        let image = NSImage(systemSymbolName: name, accessibilityDescription: "ccm")
        image?.isTemplate = true // 单色，随菜单栏明暗自动适配
        button.image = image
        button.toolTip = summaryLine()
    }

    private func summaryLine() -> String {
        if env.repo == nil { return "找不到仓库 —— 点开菜单重新定位" }
        if env.node == nil { return "找不到 node —— 点开菜单重新定位" }
        guard let s = latest else { return lastError.map { "读不到状态：\($0)" } ?? "读取中…" }
        guard s.supported else { return "本机不是 macOS？" }
        guard let server = s.server else { return "未发现 server unit" }

        var parts: [String] = []
        switch server.state {
        case "running": parts.append(server.flapping ? "运行中（曾崩溃）" : "运行中")
        case "stopped": parts.append("已停止")
        case "crashed": parts.append("已崩溃")
        default: parts.append("未安装")
        }
        if let l = server.listen { parts.append(l.reachable ? ":\(l.port)" : ":\(l.port) 连不上") }
        if let e = lastError, let t = lastUpdate {
            parts.append("状态已过期 \(Int(Date().timeIntervalSince(t)))s（\(e)）")
        }
        return "ccm · " + parts.joined(separator: " · ")
    }

    private func renderMenu() {
        guard let menu = statusItem.menu else { return }
        menu.removeAllItems()

        // ── 摘要行（不可点）
        let summary = NSMenuItem(title: summaryLine(), action: nil, keyEquivalent: "")
        summary.isEnabled = false
        menu.addItem(summary)

        // ── 环境错误态：给出自救入口，而不是干瞪眼
        if env.repo == nil {
            menu.addItem(.separator())
            menu.addItem(action("重新定位仓库…", #selector(relocateRepo)))
            menu.addItem(.separator())
            menu.addItem(action("退出", #selector(quit), key: "q"))
            return
        }
        if env.node == nil {
            menu.addItem(.separator())
            menu.addItem(action("定位 node…", #selector(relocateNode)))
            menu.addItem(.separator())
            menu.addItem(action("退出", #selector(quit), key: "q"))
            return
        }

        // ── L1 的告警原样透出（文案不在本文件加工）
        for w in latest?.warnings ?? [] {
            let item = NSMenuItem(title: "⚠ \(w)", action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)
        }

        menu.addItem(.separator())
        menu.addItem(action("打开 Web UI", #selector(openWebUI), key: "o"))

        // ── 各 unit
        if let units = latest?.units, !units.isEmpty {
            menu.addItem(.separator())
            for u in units { menu.addItem(unitItem(u)) }
        }

        menu.addItem(.separator())
        menu.addItem(action("查看日志", #selector(openLogs)))
        menu.addItem(action("运行体检（doctor）", #selector(runDoctor)))
        menu.addItem(action("在 Finder 中显示仓库", #selector(revealRepo)))

        menu.addItem(.separator())
        let autostart = action("开机自启（菜单栏）", #selector(toggleAutostart))
        autostart.state = menubarInstalled ? .on : .off
        menu.addItem(autostart)
        if latest?.setup.envExists == false {
            menu.addItem(action("首次安装向导…", #selector(setupWizard)))
        }

        menu.addItem(.separator())
        menu.addItem(action("退出", #selector(quit), key: "q"))
    }

    private var menubarInstalled: Bool {
        latest?.units.first { $0.unit == "menubar" }.map { $0.state != "not-installed" } ?? false
    }

    /// 单个 unit 的行 + 它的操作子菜单。
    /// 能不能 install/uninstall 完全看 L1 给的 ownership —— 本文件不重算归属。
    private func unitItem(_ u: UnitStatus) -> NSMenuItem {
        var title = "\(u.lamp) \(u.unit)"
        switch u.state {
        case "running": title += u.pid.map { "  运行中 (\($0))" } ?? "  运行中"
        case "stopped": title += "  已停止"
        case "crashed": title += "  已崩溃"
        default: title += "  未安装"
        }
        if u.ownership == "unknown" { title += "  · 非本仓" }
        else if u.ownership == "foreign" { title += "  · 手工配置" }

        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        let sub = NSMenu()

        if !u.detail.isEmpty {
            let d = NSMenuItem(title: u.detail, action: nil, keyEquivalent: "")
            d.isEnabled = false
            sub.addItem(d)
            sub.addItem(.separator())
        }

        if u.state != "not-installed" {
            sub.addItem(unitAction("启动", unit: u.unit, verb: "start"))
            sub.addItem(unitAction("停止", unit: u.unit, verb: "stop"))
            sub.addItem(unitAction("重启", unit: u.unit, verb: "restart"))
            sub.addItem(.separator())
            sub.addItem(unitAction("查看日志", unit: u.unit, verb: "logs"))
        } else if u.isWritable {
            sub.addItem(unitAction("安装", unit: u.unit, verb: "install"))
        }

        item.submenu = sub
        return item
    }

    private func unitAction(_ title: String, unit: String, verb: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: #selector(runUnitAction(_:)), keyEquivalent: "")
        item.target = self
        item.representedObject = ["unit": unit, "verb": verb]
        return item
    }

    private func action(_ title: String, _ sel: Selector, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: sel, keyEquivalent: key)
        item.target = self
        return item
    }

    // MARK: NSMenuDelegate —— 打开时提速，关闭时降频

    func menuWillOpen(_ menu: NSMenu) {
        menuOpen = true
        scheduleTimer()
        probe()
    }

    func menuDidClose(_ menu: NSMenu) {
        menuOpen = false
        scheduleTimer()
    }

    // MARK: 动作

    @objc private func runUnitAction(_ sender: NSMenuItem) {
        guard let info = sender.representedObject as? [String: String],
              let unit = info["unit"], let verb = info["verb"] else { return }

        if verb == "logs" { openLogsFor(unit: unit); return }

        // install 走 CLI 而不是在这里拼参数：tunnel 要 --tunnel/--cloudflared，
        // menubar 要 --app，各自的前置检查都在 L1 的 precheck 里。
        if verb == "install" {
            openTerminal(command: "cd \(shellQuote(env.repo ?? "")) && node scripts/service.js install \(unit)")
            return
        }

        if verb == "stop", unit == "server" {
            let alert = NSAlert()
            alert.messageText = "停止 ccm server？"
            alert.informativeText = "手机将立刻失去连接，直到你再次启动它。"
            alert.addButton(withTitle: "停止")
            alert.addButton(withTitle: "取消")
            alert.alertStyle = .warning
            guard alert.runModal() == .alertFirstButtonReturn else { return }
        }

        queue.async { [weak self] in
            guard let self else { return }
            let r = self.client.control(verb, unit: unit)
            Task { @MainActor in
                if case .failed(let e) = r { self.alert("操作失败", e) }
                self.probe()
            }
        }
    }

    @objc private func openWebUI() {
        // 优先用 L1 给的 lanUrl（它知道真实端口与本机 IP）；拿不到就回落 localhost。
        let url = latest?.setup.lanUrl ?? "http://127.0.0.1:\(latest?.setup.port ?? 3000)"
        if let u = URL(string: url) { NSWorkspace.shared.open(u) }
    }

    @objc private func openLogs() { openLogsFor(unit: "server") }

    private func openLogsFor(unit: String) {
        guard let repo = env.repo else { return }
        openTerminal(command: "cd \(shellQuote(repo)) && node scripts/service.js logs \(unit) --follow")
    }

    @objc private func runDoctor() {
        guard let repo = env.repo else { return }
        openTerminal(command: "cd \(shellQuote(repo)) && node scripts/doctor.js")
    }

    @objc private func revealRepo() {
        guard let repo = env.repo else { return }
        NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: repo)
    }

    @objc private func toggleAutostart() {
        guard let repo = env.repo else { return }
        let appPath = Bundle.main.bundlePath
        let verb = menubarInstalled ? "uninstall menubar --yes" : "install menubar --app=\(shellQuote(appPath))"
        openTerminal(command: "cd \(shellQuote(repo)) && node scripts/service.js \(verb)")
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
        guard panel.runModal() == .OK, let url = panel.url else { return }
        env.relocateNode(url.path)
        probe()
    }

    @objc private func setupWizard() { runSetupWizard() }

    @objc private func quit() { NSApp.terminate(nil) }

    // MARK: 首次装机向导
    //
    // **这是 Swift 在整个方案里存在的唯一硬理由**：scripts/setup.js 的 resolveSetupPlan 规定
    // 非交互模式必须显式 --work-dir 且绝不回落 $HOME（"那等于把整个家目录交给 agent"），
    // 而零命令行用户没法输路径。NSOpenPanel 正好补上这一个洞。
    //
    // 其余每一步都委托给 CLI，并且**开一个真 Terminal 窗口跑**——让用户看见真实输出，
    // 而不是一个转圈的 spinner。失败时报错就在眼前，不用我在这里翻译。
    private func runSetupWizard() {
        guard let repo = env.repo else { return }

        let welcome = NSAlert()
        welcome.messageText = "配置 ccm"
        welcome.informativeText = """
        接下来会做三件事：
        1. 选一个工作目录（claude 的默认目录）
        2. 生成 .env（含随机访问令牌）
        3. 安装常驻服务并启动

        全部在一个终端窗口里执行，你能看到每一步的真实输出。
        """
        welcome.addButton(withTitle: "继续")
        welcome.addButton(withTitle: "取消")
        guard welcome.runModal() == .alertFirstButtonReturn else { return }

        guard let workDir = pickDirectory(title: "选择 claude 的工作目录") else { return }

        let hooksAlert = NSAlert()
        hooksAlert.messageText = "安装 CLI hooks 桥？"
        hooksAlert.informativeText = "装了之后，你在电脑终端里跑的 claude 会话，回合结束或需要你决策时能即时推到手机。不装也能用，只是靠轮询、没有推送。"
        hooksAlert.addButton(withTitle: "安装")
        hooksAlert.addButton(withTitle: "先不装")
        let hooks = hooksAlert.runModal() == .alertFirstButtonReturn ? "on" : "off"

        let script = [
            "cd \(shellQuote(repo))",
            "node scripts/setup.js --yes --work-dir=\(shellQuote(workDir)) --hooks=\(hooks)",
            "node scripts/service.js install server",
            "node scripts/service.js start server",
            "node scripts/service.js status",
        ].joined(separator: " && ")
        openTerminal(command: script)
    }

    // MARK: 小工具

    private func pickDirectory(title: String) -> String? {
        let panel = NSOpenPanel()
        panel.title = title
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        return panel.runModal() == .OK ? panel.url?.path : nil
    }

    private func alert(_ title: String, _ body: String) {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = body
        a.alertStyle = .warning
        a.runModal()
    }

    /// 开一个 Terminal 窗口跑命令。同 src/ops/log-terminal.js 的做法（那是仓库里已有的
    /// 桌面集成先例）：长任务与安装流程都走真终端，让输出可见、失败可查。
    private func openTerminal(command: String) {
        let escaped = command
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        let osa = "tell application \"Terminal\"\nactivate\ndo script \"\(escaped)\"\nend tell"
        queue.async {
            runSync("/usr/bin/osascript", ["-e", osa], timeout: 15)
        }
    }
}

/// shell 单引号包裹。值里的单引号用 '"'"' 的经典写法闭合再拼接。
func shellQuote(_ s: String) -> String {
    "'" + s.replacingOccurrences(of: "'", with: "'\"'\"'") + "'"
}

// MARK: - 入口
//
// 用 @main 而不是顶层语句：编译走 -parse-as-library（AppKit app 的标准姿势），那种模式下
// 顶层表达式是非法的，而且 AppDelegate 带 @MainActor、不能在 nonisolated 上下文里构造。

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
