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
    // ★ isFlapping 的语义在 6a38e7c 里从「上次退出码 ≠ 0」换成了「1 小时内 ≥3 次重启」，
    // 这句文案上一版没跟上：对一个一次都没崩过、只是被 kickstart 过几次的 unit 说「曾崩溃」，
    // 是编造的事实。「上次是不是非正常退出」在 lastExitAbnormal 里，不由这里下结论。
    case "running": parts.append(server.isFlapping ? "运行中（频繁重启）" : "运行中")
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
///
/// ## unit 必须 shellQuote（2026-08-14 第三轮审查）
/// 它不是常量：scripts/service.js 对未知 unit 走 `label.slice(labelPrefix.count + 1)`，
/// label 来自 `~/Library/LaunchAgents` 的**文件名**。而这串最终经 osascript 的
/// `do script` 交给 shell 执行。前置条件（能写那个目录）本身已等于有用户级执行权，
/// 所以不是新的信任边界，但同一文件里 repo/appPath/workDir 都过了 shellQuote，漏这一个纯属不一致。
func installCommand(unit: String, repo: String, appPath: String?) -> String {
    let base = "cd \(shellQuote(repo)) && node scripts/service.js install \(shellQuote(unit))"
    switch unit {
    case "menubar":
        guard let app = appPath else { return base }
        return "\(base) --app=\(shellQuote(app))"
    case "tunnel":
        // 故意留成模板：这两个值本工具无从得知，让用户在终端里按 ↑ 调出来补完再回车。
        // ★ 占位符必须 shellQuote：`do script` 是**立刻执行**的（同 src/ops/log-terminal.js），
        // 裸写 `<隧道名>` 时 `<` `>` 是重定向算符，实测 zsh 报 `no such file or directory: 隧道名`
        // 并以退出码 1 结束 —— node 一次都没跑，用户拿到的错误比 precheck 那句还没信息量。
        // 加引号后命令能真正跑到 precheck，报的是「装 tunnel 需要 --tunnel=… 与 --cloudflared=…」。
        return "\(base) --tunnel=\(shellQuote("隧道名")) --cloudflared=$(command -v cloudflared)"
    default:
        return base
    }
}

func uninstallCommand(unit: String, repo: String) -> String {
    "cd \(shellQuote(repo)) && node scripts/service.js uninstall \(shellQuote(unit)) --yes"
}

func logsCommand(unit: String, repo: String) -> String {
    "cd \(shellQuote(repo)) && node scripts/service.js logs \(shellQuote(unit)) --follow"
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

// MARK: - 配置 schema（L1 的输出契约，对应 src/ops/config-file.js 的 CONFIG_SCHEMA_VERSION）
//
// 数据来自 `node scripts/config.js schema --json`。与 ServiceStatus 同一条失败模式纪律：
// **除 schemaVersion 外全部可选** —— Node 侧加字段是常事，而一个字段变 null 就让整份解码失败、
// 配置窗口整个空掉，是最糟的结果。宁可少渲染一行。

struct LocalizedText: Decodable {
    let zh: String?
    let en: String?
    /// 中文优先：这个 app 的读者是机主本人，界面其余部分也是中文。
    var text: String { zh ?? en ?? "" }
}

struct MaskedSecret: Decodable {
    let set: Bool?
    let length: Int?
}

struct ToggleLiterals: Decodable {
    let on: String?
    let off: String?
}

struct ConfigItem: Decodable {
    let key: String?
    let kind: String?
    let label: LocalizedText?
    let help: LocalizedText?
    let readonly: Bool?
    let secret: Bool?
    let masked: MaskedSecret?
    let value: String?
    let values: ToggleLiterals?
    // `default` 是 Swift 关键字，必须反引号转义。漏声明它不会报错，只会静默解码成 nil ——
    // PORT 的「默认 3000」这类提示在窗口里凭空消失，而没有任何迹象说明为什么。
    // tests/unit/desktop-schema-contract.test.mjs 就是抓这类漏字段的。
    let `default`: String?
    let unit: String?
    let min: Int?
    let max: Int?

    var name: String { key ?? "" }
    var kindName: String { kind ?? "text" }
    var isSecret: Bool { secret ?? false }

    /// 能不能在窗口里编辑它。
    ///
    /// **判据是 kind 而不是 readonly 字段。** readonly 是服务端给**手机面板**的渲染提示：
    /// list 项被标成 readonly 只因为前端没有数组编辑器，而桌面端完全可以做一个。
    /// 照搬那个字段会让 WORKDIRS 在桌面上也变成只读 —— 与 scripts/config.js 的 schema
    /// 输出把 list 标为「仅 CLI / 桌面端可改」是同一处判断。
    var isEditable: Bool { kindName != "readonly" }

    /// 输入框里应该预填什么。secret 永远不预填明文 —— 服务端根本没下发它（只给 {set,length}）。
    var displayValue: String {
        if isSecret { return (masked?.set ?? false) ? "••••••••" : "" }
        return value ?? ""
    }

    /// toggle 当前是开还是关。方向由「哪一侧字面量是空串」决定，同 src/ops/config-file.js
    /// 的 toggleDefaultsOn —— 空串那侧是默认态，因为空值写不进配置文件。
    var toggleIsOn: Bool { ConfigItem.decodedToggle(self, current: value ?? "") }

    /// 同上，但值从 `config get --json` 来。
    ///
    /// ## ★ 两个取值域，别搞混（这里出过一次实打实的 P0）
    ///
    /// `item.values` 里的 on/off 是 **.env 字面量**（`''` / `'off'` / `'1'` / `'on'`），
    /// 而 `config get --json` 下发的是 **JSON 真值的字符串化**（`"true"` / `"false"`，
    /// 见 scripts/config.js 的 formatValueForDisplay 走 JSON.stringify）。
    ///
    /// 拿后者去比前者，每一个设置过的开关都会显示反 —— 而且保存路径用同一个错基线做
    /// before/after 比对，于是唯一"能提交"的改动是把已有的值再写一遍：开着的关不掉、
    /// 关着的开不了，状态栏还报「已保存 1 项」。
    ///
    /// 未设置的项不在 `get` 的输出里，`current` 为空 —— 那时才回落到 values 判默认方向
    /// （空串那侧是默认态，同 src/ops/config-file.js 的 toggleDefaultsOn）。
    static func decodedToggle(_ item: ConfigItem, current: String) -> Bool {
        guard item.kindName == "toggle" else { return false }

        switch current.trimmingCharacters(in: .whitespaces).lowercased() {
        case "true": return true
        case "false": return false
        default: break
        }

        // 空值 / 认不出的值 → 该项没有显式配置，取 schema 声明的默认方向
        return (item.values?.on ?? "").isEmpty
    }

    /// secret 是否已设置。**判据来自 `config get` 而不是 schema**：
    /// cmdSchema 传的是 `buildEnvView({})`，masked 恒为 `{set:false}`，照它渲染的话
    /// 「已设置的 CF_ACCESS_AUD」和「从没设过」长得一模一样。
    static func secretDisplay(current: String) -> String {
        current.isEmpty ? "" : "••••••••"
    }
}

struct ConfigGroup: Decodable {
    let id: String?
    let label: LocalizedText?
    let items: [ConfigItem]?

    var visibleItems: [ConfigItem] { (items ?? []).filter { !$0.name.isEmpty } }
}

struct ConfigSchema: Decodable {
    let schemaVersion: Int?
    let groups: [ConfigGroup]?

    var groupList: [ConfigGroup] { groups ?? [] }

    /// 能不能解码这份 schema。版本对不上时宁可显示一句提示，也不要拿旧字段猜新格式。
    func isCompatible(with supported: Int) -> Bool { (schemaVersion ?? 0) == supported }
}

/// 本 app 支持的配置 schema 版本。与 src/ops/config-file.js 的 CONFIG_SCHEMA_VERSION 对齐；
/// tests/unit/desktop-schema-contract.test.mjs 双向校验，改一边另一边会红。
let SUPPORTED_CONFIG_SCHEMA_VERSION = 1

// MARK: - 配置命令（argv 形式）
//
// 与上面那批 install/uninstall 命令的关键差别：**这些不经 shell**。
// 那批要交给 osascript 的 `do script`（用户要看见输出），所以每个参数都得 shellQuote；
// 这批直接 Process 传 argv，参数边界由系统保证 —— 路径里有空格、引号、`$(...)` 都无所谓，
// 天然免疫注入。所以这里刻意**不做**任何引号处理，加了反而会把引号当成值的一部分写进配置。

func configScriptPath(in repo: String) -> String {
    (repo as NSString).appendingPathComponent("scripts/config.js")
}

func configSchemaArgs(repo: String) -> [String] {
    [configScriptPath(in: repo), "schema", "--json"]
}

func configGetArgs(repo: String) -> [String] {
    [configScriptPath(in: repo), "get", "--json"]
}

/// 保存一批改动。空表返回 nil —— 没有改动就不该起一个进程。
func configSetArgs(repo: String, changes: [(key: String, value: String)]) -> [String]? {
    guard !changes.isEmpty else { return nil }
    return [configScriptPath(in: repo), "set"] + changes.map { "\($0.key)=\($0.value)" }
}

/// 删除一项。同样是 argv，不经 shell。
func configUnsetArgs(repo: String, keys: [String]) -> [String]? {
    guard !keys.isEmpty else { return nil }
    return [configScriptPath(in: repo), "unset"] + keys
}

/// toggle 在 CLI 侧接受 true/false —— scripts/config.js 的 parseCliValue 专门为此写了一套
/// 解析（**不能**送 'off'/'1' 这些 .env 字面量：那是给配置文件读的，CLI 层语义相反）。
func toggleArgValue(_ isOn: Bool) -> String { isOn ? "true" : "false" }

// MARK: - 日志窗口
//
// 常驻部署把日志重定向到文件，要看得自己 tail。窗口里显示尾部若干行即可 ——
// 一个几百 MB 的日志（DEBUG_SDK_MESSAGES 长开曾刷到 149MB）整份读进内存会直接卡死 UI。

let LOG_TAIL_BYTES = 256 * 1024

/// 从一段日志文本里取最后 n 行。**按行数截而不是按字节**：按字节截会把第一行切成半截，
/// 而日志的第一个字符往往是时间戳，半截时间戳比没有更让人困惑。
func lastLines(_ text: String, _ n: Int) -> [String] {
    let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    return lines.count <= n ? lines : Array(lines.suffix(n))
}

/// 日志文件路径：配置里的 LOG_FILE 优先，否则回落常驻部署的默认位置。
/// 两者都拿不到时返回 nil —— 显示「未配置日志文件」比对着一个不存在的路径报错强。
func resolveLogPath(configured: String?, home: String) -> String? {
    if let c = configured, !c.isEmpty { return c }
    let fallback = (home as NSString).appendingPathComponent("Library/Logs/ccm-server.log")
    return FileManager.default.fileExists(atPath: fallback) ? fallback : nil
}

// MARK: - 配置来源

/// `config get --json` 除了值还告诉我们这些值是从哪读的。
///
/// 桌面端需要它来区分两种状态：已迁移（可直接编辑保存）与仍在旧版 `.env`（写入会被 L1 的
/// guardWriteTarget 拒绝，因为那会生成一份只含本次改动的新文件、把整份 .env 遮蔽）。
/// 不区分的话，老用户会看到一张能填的表单、点保存却收到一句「去命令行跑 migrate」。
struct ConfigSnapshot {
    let values: [String: String]
    let source: String

    /// 仍在旧格式上。此时该引导迁移，而不是让用户填表单。
    var isLegacyEnv: Bool { source == "env" }
    /// 一份配置都还没有（全新安装）——窗口该提示去跑 setup 而不是显示空表单。
    var isUnconfigured: Bool { source == "none" }
}

func configMigrateArgs(repo: String) -> [String] {
    [configScriptPath(in: repo), "migrate", "--json"]
}
