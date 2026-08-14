// CCMCore.swift —— 菜单栏 app 的纯逻辑层：数据模型、状态判定、命令与 URL 拼装。
//
// 单独一个文件是为了**可测**：这里没有 AppKit、没有 Process、没有全局状态，
// 每个函数都是「给定输入返回输出」，`npm run app:test` 直接编译它跑断言。
//
// 划分依据来自一次真实教训：这 500 行 Swift 是全仓唯一没有自动化测试的代码，
// 而第一轮代理审查在里面找到 6 个真 bug，其中两个（install 参数拼错、Web UI URL 缺 token）
// 恰恰是纯字符串拼装 —— 本可以被一条断言挡住。
//
// ccm-menubar.swift 里只剩「画菜单 + 弹窗 + spawn 进程」这些非跑不可的部分。

import Foundation

// MARK: - L1 的输出契约（对应 scripts/service.js 的 STATUS_SCHEMA_VERSION = 1）
//
// 除 schemaVersion 外全部可选：Node 侧加字段是常事，而一个字段变 null 就让整份解码失败、
// 菜单整个空掉，是最糟的失败模式。宁可少显示一行。

struct ListenInfo: Decodable {
    let port: Int?
    let reachable: Bool?
}

struct UnitStatus: Decodable {
    let unit: String?
    let label: String?
    let known: Bool?
    let ownership: String?   // managed | adoptable | foreign | unknown
    let state: String?       // not-installed | stopped | running | crashed
    let pid: Int?
    let flapping: Bool?
    let drift: [String]?
    let listen: ListenInfo?
    let detail: String?

    var unitName: String { unit ?? label ?? "?" }
    var stateName: String { state ?? "unknown" }
    var isFlapping: Bool { flapping ?? false }
    var driftReasons: [String] { drift ?? [] }

    /// 菜单栏那盏灯的字符前缀。与 scripts/service.js 的 formatStatus 用同一套符号，
    /// 这样 CLI 与 GUI 说的是同一种语言。
    var lamp: String {
        if isFlapping { return "◐" }
        switch stateName {
        case "running": return "●"
        case "stopped": return "○"
        case "crashed": return "✗"
        default: return "·"
        }
    }

    /// 能不能对它做 install / uninstall。判据来自 L1 的 ownership，本文件不重算归属。
    var isWritable: Bool { ownership == "managed" || ownership == "adoptable" }

    /// 「非 shape 的漂移」才算问题。shape 表示用户换了启动方式（如机主的隧道用自写包装脚本），
    /// 那是有意配置，年年报黄只会训练用户忽略告警。
    var realDrift: [String] { driftReasons.filter { $0 != "shape" } }
}

struct SetupInfo: Decodable {
    let envExists: Bool?
    let port: Int?
    let lanUrl: String?
}

struct ServiceStatus: Decodable {
    let schemaVersion: Int?
    let platform: String?
    let supported: Bool?
    let repo: String?
    let setup: SetupInfo?
    let units: [UnitStatus]?
    let warnings: [String]?

    var unitList: [UnitStatus] { units ?? [] }
    var isSupported: Bool { supported ?? false }
    var server: UnitStatus? { unitList.first { $0.unit == "server" } }

    /// 整体健康度 → 菜单栏图标（SF Symbols 名）。优先级：环境坏 > 服务挂 > 有告警 > 正常。
    var symbol: String {
        guard isSupported, let s = server else { return "questionmark.circle" }
        if s.stateName == "crashed" { return "xmark.octagon" }
        if s.stateName == "not-installed" { return "exclamationmark.triangle" }
        if unitList.contains(where: { $0.isFlapping }) { return "exclamationmark.triangle" }
        if unitList.contains(where: { !$0.realDrift.isEmpty }) { return "exclamationmark.triangle" }
        if s.stateName != "running" { return "exclamationmark.triangle" }
        return "checkmark.circle"
    }
}

// MARK: - 环境判定

public enum EnvProblem: Equatable {
    case noRepo
    case noNode
    case none
}

/// 仓库路径的有效性判据是 **scripts/service.js 存在**，不是目录存在 ——
/// 仓库被删后父目录往往还在，只判目录会给出一个假绿。
func serviceScriptPath(in repo: String) -> String {
    (repo as NSString).appendingPathComponent("scripts/service.js")
}

// MARK: - 摘要行与菜单标题

/// 菜单栏 tooltip 与菜单首行的那句话。
/// staleSeconds 非 nil 表示上一次探测失败了 —— 此时**保留旧状态**并标注它有多旧，
/// 而不是清空（清空会让用户以为服务没了，同 public/js/app.js 断线时的做法）。
func summaryLine(status: ServiceStatus?, problem: EnvProblem, lastError: String?, staleSeconds: Int?) -> String {
    switch problem {
    case .noRepo: return "找不到仓库 —— 点开菜单重新定位"
    case .noNode: return "找不到 node —— 点开菜单重新定位"
    case .none: break
    }
    guard let s = status else { return lastError.map { "读不到状态：\($0)" } ?? "读取中…" }
    guard s.isSupported else { return "本机不支持 LaunchAgent 管理" }
    guard let server = s.server else { return "未发现 server unit" }

    var parts: [String] = []
    switch server.stateName {
    case "running": parts.append(server.isFlapping ? "运行中（曾崩溃）" : "运行中")
    case "stopped": parts.append("已停止")
    case "crashed": parts.append("已崩溃")
    default: parts.append("未安装")
    }
    if let l = server.listen, let p = l.port {
        parts.append((l.reachable ?? false) ? ":\(p)" : ":\(p) 连不上")
    }
    if let stale = staleSeconds, let e = lastError {
        parts.append("状态已过期 \(stale)s（\(e)）")
    }
    return "ccm · " + parts.joined(separator: " · ")
}

/// unit 那一行的标题。
func unitTitle(_ u: UnitStatus) -> String {
    var title = "\(u.lamp) \(u.unitName)"
    switch u.stateName {
    case "running": title += u.pid.map { "  运行中 (\($0))" } ?? "  运行中"
    case "stopped": title += "  已停止"
    case "crashed": title += "  已崩溃"
    default: title += "  未安装"
    }
    if u.ownership == "unknown" { title += "  · 非本仓" }
    else if u.ownership == "foreign" { title += "  · 手工配置" }
    return title
}

// MARK: - 命令与 URL 拼装
//
// 这一节是第一轮审查里出错最多的地方（install 少传参数、Web UI URL 缺 token），
// 而它们全是纯字符串运算 —— 正是最该被断言锁住的部分。

/// shell 单引号包裹。值里的单引号用 '"'"' 的经典写法闭合再拼接。
func shellQuote(_ s: String) -> String {
    "'" + s.replacingOccurrences(of: "'", with: "'\"'\"'") + "'"
}

/// AppleScript 字符串字面量转义。**顺序要紧**：先反斜杠后双引号，反过来会把刚插入的
/// 转义反斜杠又转义一遍。单引号在 AppleScript 里无需转义（由外层 shellQuote 负责 shell 侧）。
func appleScriptEscape(_ s: String) -> String {
    s.replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
}

func terminalScript(command: String) -> String {
    "tell application \"Terminal\"\nactivate\ndo script \"\(appleScriptEscape(command))\"\nend tell"
}

/// 某个 unit 的安装命令。**必须带齐该 unit 的必填参数**，否则 L1 的 precheck 必然拒绝 ——
/// 第一轮审查发现子菜单里的「安装」对 menubar / tunnel 是个恒失败的入口。
/// tunnel 的隧道名与 cloudflared 路径只有用户知道，所以给的是一条待补全的命令模板。
func installCommand(unit: String, repo: String, appPath: String?) -> String {
    let base = "cd \(shellQuote(repo)) && node scripts/service.js install \(unit)"
    switch unit {
    case "menubar":
        guard let app = appPath else { return base }
        return "\(base) --app=\(shellQuote(app))"
    case "tunnel":
        // 故意留成模板：这两个值本工具无从得知，让用户在终端里补完再回车。
        return "\(base) --tunnel=<隧道名> --cloudflared=$(command -v cloudflared)"
    default:
        return base
    }
}

func uninstallCommand(unit: String, repo: String) -> String {
    "cd \(shellQuote(repo)) && node scripts/service.js uninstall \(unit) --yes"
}

func logsCommand(unit: String, repo: String) -> String {
    "cd \(shellQuote(repo)) && node scripts/service.js logs \(unit) --follow"
}

func doctorCommand(repo: String) -> String {
    "cd \(shellQuote(repo)) && node scripts/doctor.js"
}

/// 首次装机向导在终端里跑的那串。每一步都看得见输出 —— 失败时报错就在眼前。
func setupCommand(repo: String, workDir: String, hooks: Bool) -> String {
    [
        "cd \(shellQuote(repo))",
        "node scripts/setup.js --yes --work-dir=\(shellQuote(workDir)) --hooks=\(hooks ? "on" : "off")",
        "node scripts/service.js install server",
        "node scripts/service.js start server",
        "node scripts/service.js status",
    ].joined(separator: " && ")
}

/// 打开 Web UI 用的地址。
///
/// **刻意不拼 `#token=`**：那需要把 AUTH_TOKEN 读进本进程内存，而 L1 专门提供了
/// `copy-token`（经 pbcopy 直送剪贴板，明文不进任何管道）。菜单的做法是先复制再打开，
/// 让用户粘贴 —— 少一个明文流经的环节。
func webUIURL(status: ServiceStatus?) -> String {
    if let lan = status?.setup?.lanUrl, !lan.isEmpty { return lan }
    let port = status?.setup?.port ?? 3000
    return "http://127.0.0.1:\(port)"
}

// MARK: - 轮询节奏

/// 菜单关着时只需要给灯上色，菜单打开时用户在盯着。
func probeInterval(menuOpen: Bool) -> TimeInterval { menuOpen ? 2 : 10 }
