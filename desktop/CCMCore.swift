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

/// unit 的调度形态，来自 scripts/service.js 的 `extractSchedule`（读 plist 算出）。
/// 它回答的是「这个 unit 期望常驻吗」—— stopped 是故障还是健康待机，全看这个。
struct ScheduleInfo: Decodable {
    let kind: String?              // resident | periodic | on-demand | unknown
    let everySeconds: Int?         // StartInterval
    let calendar: [String: Int]?   // StartCalendarInterval（单字典形态）

    /// launchd 的 StartCalendarInterval 有**两种**合法形态：单个字典，以及字典数组（多个时刻）。
    /// service-units.js 的 extractSchedule 只判 `typeof === 'object'`（数组也满足）后原样透传，
    /// 所以数组真的会到达这里。
    ///
    /// 而本文件「字段全 optional，一个坏字段杀不死解码」的纪律只覆盖 null 与缺字段 ——
    /// Swift 的 optional **不容忍类型不匹配**：`[String: Int]?` 撞上数组会抛 typeMismatch，
    /// 冲出整个 ServiceStatus 的解码，菜单于是永久停在「读不到状态」，没有 unit、没有启停项。
    /// 机主本机就跑着手写的 com.ccm.tunnel-watch，而 buildUnknownUnits 会收编任意 com.ccm.*，
    /// 所以这不是假想场景。JS 侧对同一形态是优雅降级的（「待机 · 定时触发」），两侧不能分叉。
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try? c.decodeIfPresent(String.self, forKey: .kind)
        everySeconds = try? c.decodeIfPresent(Int.self, forKey: .everySeconds)
        // 解不出单字典形态就留 nil —— idleLabel 会回落到「待机 · 定时触发」，与 JS 侧一致。
        // 用 `try?` 而不是分支穷举：将来 launchd 再多一种形态也不会把整份状态带下水。
        calendar = try? c.decodeIfPresent([String: Int].self, forKey: .calendar)
    }

    private enum CodingKeys: String, CodingKey { case kind, everySeconds, calendar }
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
    let schedule: ScheduleInfo?
    /// launchd 域里还有没有这个 job。false = 已被 bootout：plist 还在磁盘上、调度形态也照样
    /// 读得出来，但它永远不会再触发了。缺字段（旧版 CLI）时为 nil，按「不知道」保守处理。
    let loaded: Bool?

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
        case "stopped": return isIdleByDesign ? "◌" : "○"
        case "crashed": return "✗"
        default: return "·"
        }
    }

    /// 「此刻没有进程」是不是正常。周期任务与打火即退任务的 stopped 是健康待机。
    ///
    /// ★ 前提是它还在 launchd 域里。被 bootout 之后 plist 照样在磁盘上、schedule 也照样解析
    /// 得出来，可它永远不会再触发 —— 那不是待机，是停了。少了 loaded 这一项，主行会显示
    /// 「◌ logrotate 待机 · 每天 03:47」，而同一份状态在子菜单 detail 里写的是
    /// 「已停止（每天 03:47 不会触发）」，两个界面对着同一个事实说相反的话。
    /// loaded 缺字段（旧版 CLI）时按 nil 处理，维持旧行为，不凭空把正常待机改成告警。
    var isIdleByDesign: Bool { stateName == "stopped" && loaded != false && idleLabel(for: schedule) != nil }

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

/// 子进程该拿到的环境：**只把 PATH 换成登录 shell 的那份，其余一个键都不动。**
///
/// 【为什么必须换 PATH】GUI 启动的 app 由 LaunchServices 拉起，继承 launchd 的
/// `PATH=/usr/bin:/bin:/usr/sbin:/sbin`，它不读 ~/.zshrc / ~/.zprofile。装在 ~/.local/bin、
/// /opt/homebrew/bin、nvm 目录下的工具在这个 PATH 里一律「不存在」。2026-08-27 的现场：
/// 菜单栏跑 scripts/doctor.js，doctor 内部 `which claude` 落空 → CLAUDE_BIN 报红 → 退出码
/// 非零 → 后面十几项检查全被腰斩；而 web 面板同时显示 CLAUDE_BIN 正常，因为 server 的 plist
/// 用 `zsh -lc` 起，PATH 是全的。
///
/// 【为什么只搬 PATH，不搬整个 environment】后者看着更省事，实则会重新制造 2026-08-19 的
/// 幽灵 env 事故：~/.zshrc 里一个 `export AUTH_TOKEN=旧值` 就会压过 ccm.config.json
/// （「环境变量始终压过文件」是本仓的既定规则），于是同一个脚本从菜单栏跑和从终端跑读到
/// **两份不同的配置**，且完全无症状。配置的事实源必须只有 ccm.config.json 一个。
/// PATH 是唯一的例外，因为它不是配置、而是「上哪找可执行文件」的宿主环境事实。
///
/// loginPath 为 nil 或空白时原样返回：宁可维持现状（doctor 照旧报红），也不能把 PATH 清掉
/// ——那会让失败模式从「一项红」恶化成「连 /usr/bin 都找不到，什么都跑不了」。
func childEnvironment(base: [String: String], loginPath: String?) -> [String: String] {
    guard let p = loginPath?.trimmingCharacters(in: .whitespacesAndNewlines), !p.isEmpty else { return base }
    var env = base
    env["PATH"] = p
    return env
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
        let reachable = l.reachable ?? false
        // ★ 服务没在跑、端口却通 —— 那个端口被**别的进程**占着，正是端口冲突的 signature。
        // 此前这里只显示 ":4567"，与「已崩溃」并排，反而暗示端口一切正常，
        // 而端口恰恰就是崩溃的原因。
        if server.stateName != "running" && reachable {
            parts.append(":\(p) 被其它进程占用")
        } else {
            parts.append(reachable ? ":\(p)" : ":\(p) 连不上")
        }
    }
    if let stale = staleSeconds, let e = lastError {
        parts.append("状态已过期 \(stale)s（\(e)）")
    }
    return "ccm · " + parts.joined(separator: " · ")
}

/// unit 那一行的标题。stopped 的状态词按**调度形态**定制（idleLabel）：定时器与
/// 打火即退任务的「停止」是健康待机——照写「已停止」会被读成故障，用户真的来问过。
func unitTitle(_ u: UnitStatus) -> String {
    var title = "\(u.lamp) \(u.unitName)"
    switch u.stateName {
    case "running": title += u.pid.map { "  运行中 (\($0))" } ?? "  运行中"
    // 走 isIdleByDesign 而不是直接问 idleLabel：后者只看调度形态，而「待机」还有一个前提 ——
    // 它得还在 launchd 域里。被 bootout 的定时器 schedule 照样解析得出，却永远不会再触发。
    case "stopped": title += "  " + (u.isIdleByDesign ? (idleLabel(for: u.schedule) ?? "已停止") : "已停止")
    case "crashed": title += "  已崩溃"
    default: title += "  未安装"
    }
    if u.ownership == "unknown" { title += "  · 非本仓" }
    else if u.ownership == "foreign" { title += "  · 手工配置" }
    return title
}

/// stopped 的语义化文案，由 plist 里的调度形态算出（与 service-units.js 的 describeSchedule 同口径）。
///
/// ★ 判据**不是 unit 名字表**。名字表只能覆盖仓库自带的模板，而最容易被误读的恰恰是用户自建的
/// unit —— 机主的 com.ccm.tunnel-watch 每 30s 救一次隧道，落进 default 被标「已停止」，
/// 它还同时挂着「非本仓」，读起来就像装了没启用；机主本人为此来问过。用户随时可能再加一个
/// watch，名字表永远追不上，而 plist 里 KeepAlive / StartInterval / StartCalendarInterval
/// 本来就写着答案。
///
/// 返回 nil = 这个 stopped 没有「待机」说法（常驻服务，或形态判不出来）—— 那时照常说「已停止」，
/// 保守回落也覆盖旧版 CLI 不下发 schedule 字段的情况。
func idleLabel(for schedule: ScheduleInfo?) -> String? {
    guard let s = schedule else { return nil }
    if s.kind == "on-demand" { return "随登录自启" }
    guard s.kind == "periodic" else { return nil }
    if let secs = s.everySeconds {
        return secs >= 60 ? "待机 · 每 \(Int((Double(secs) / 60).rounded())) 分钟触发" : "待机 · 每 \(secs) 秒触发"
    }
    if let cal = s.calendar {
        let pad = { (n: Int) in String(format: "%02d", n) }
        // 只给 Minute 不给 Hour 是 launchd 的「每小时第 N 分」，别补一个没写的小时进去。
        if let h = cal["Hour"] { return "待机 · 每天 \(pad(h)):\(pad(cal["Minute"] ?? 0))" }
        if let m = cal["Minute"] { return "待机 · 每小时第 \(m) 分" }
    }
    return "待机 · 定时触发"
}

/// 菜单里 unit 的分组：server / tunnel 是使用者日常关心的主服务（「手机能不能连」），
/// 其余（定时器、自启项、用户自加的 watch…）收进「其他服务 ▸」——平铺时它们与 server
/// 同权重，而它们的「待机」常态恰恰最容易被读成故障。
func splitUnits(_ units: [UnitStatus]) -> (primary: [UnitStatus], secondary: [UnitStatus]) {
    let primaryNames = ["server", "tunnel"]
    return (units.filter { primaryNames.contains($0.unitName) },
            units.filter { !primaryNames.contains($0.unitName) })
}

/// start/stop/restart 进行中把对应菜单项灭掉，否则关菜单再开再点会叠两次 kickstart。
/// unit 是否**存在**由 `unitItem` 的 `not-installed` 分支管，这里只判「此刻能不能点」。
func isControlEnabled(unit: String, busyUnits: Set<String>) -> Bool {
    !busyUnits.contains(unit)
}

/// `ServiceClient.control` 的 runSync 上限。必须长过 `scripts/service.js` 的 kickstart
/// 窗口（25s）：GUI 先杀 node 等于把还在节流的合法 `launchctl` 一道杀掉。
let serviceControlTimeout: TimeInterval = 40

/// unit 行的悬停解释。菜单里的实现词汇（logrotate / tunnel-watch / 归属标注）对使用者
/// 不自明——tooltip 用人话补一句「它是干嘛的、什么状态算正常」。
func unitTooltip(_ u: UnitStatus) -> String {
    var text: String
    switch u.unitName {
    case "server": text = "ccm 本体：手机连接的就是它。改配置后需要重启它才生效。"
    case "tunnel": text = "Cloudflare 公网隧道：手机在外网访问全靠它。"
    case "logrotate": text = "日志轮转定时器：每天 03:47 醒来跑一次即退，平时显示待机是正常的。"
    case "menubar": text = "本 app 的「随登录启动」项：登录时拉起 app 后即退，平时显示待机是正常的。"
    default: text = "非本项目模板的 LaunchAgent（com.ccm.* 前缀被一并纳入显示）。"
    }
    if u.ownership == "foreign" { text += "「手工配置」= 启动方式是你自定义的，本工具只帮启停、不覆写。" }
    if u.ownership == "unknown" { text += "「非本仓」= 不是本项目安装的，本工具只帮查看与启停。" }
    return text
}

// MARK: - URL 拼装
//
// ## 这里曾经还有一整套 shell / AppleScript 命令拼装
//
// shellQuote、appleScriptEscape、terminalScript 与 5 个 *Command 函数，用来把命令拼成
// 一条 shell 串交给 osascript 的 `do script`。第一轮代理审查在这一节找到的 bug 最多
// （install 少传参数、Web UI URL 缺 token、tunnel 占位符被当成重定向算符），因为它们
// **全是纯字符串运算**，而每一层引号都得自己转义对。
//
// 现在整节没了：桌面端改用 argv + 内嵌任务窗口（TaskStep / TaskWindowController），
// 参数边界由系统保证，两层转义一起消失。留下这段注释是因为那批 bug 的教训仍然有效 ——
// **需要转义的地方，先问能不能不转义**。

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

/// 日志窗口的一个可选源。title 给下拉框（server / tunnel / logrotate…），path 给 tail。
struct LogSource: Equatable {
    let title: String
    let path: String
}

/// 日志窗口的源列表：LOG_FILE 配置的路径优先置顶，再列 ~/Library/Logs/ 下的全部 ccm-*.log
/// （tunnel / logrotate / menubar / tunnel-watch……有文件就有源，server 排最前）。
/// fileNames 由调用方枚举日志目录后喂进来 —— 本函数零 IO，断言可全覆盖。
/// .gz 轮转历史靠 hasSuffix(".log") 天然排除；与 LOG_FILE 同路径的条目去重。
func logSources(configured: String?, home: String, fileNames: [String]) -> [LogSource] {
    var sources: [LogSource] = []
    if let c = configured, !c.isEmpty {
        sources.append(LogSource(title: "server（LOG_FILE）", path: c))
    }
    let logsDir = (home as NSString).appendingPathComponent("Library/Logs")
    let scanned = fileNames
        .filter { $0.hasPrefix("ccm-") && $0.hasSuffix(".log") }
        .map { name in
            LogSource(
                title: String(name.dropFirst("ccm-".count).dropLast(".log".count)),
                path: (logsDir as NSString).appendingPathComponent(name))
        }
        .filter { candidate in !sources.contains { $0.path == candidate.path } }
        .sorted { a, b in
            if (a.title == "server") != (b.title == "server") { return a.title == "server" }
            return a.title < b.title
        }
    sources.append(contentsOf: scanned)
    return sources
}

/// 「重启应用」的 argv：分离的 sh 先 sleep 等旧实例退出，再 open 同一 bundle
/// （open 对仍在跑的实例只会激活它，所以必须先退再开，顺序靠 sleep 保证）。
/// 路径做 POSIX 单引号转义 —— 纯字符串拼装是历史上出 bug 最多的地方，放这层测。
func relaunchArgv(bundlePath: String) -> [String] {
    let quoted = "'" + bundlePath.replacingOccurrences(of: "'", with: "'\\''") + "'"
    return ["/bin/sh", "-c", "sleep 0.4; /usr/bin/open \(quoted)"]
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

// MARK: - 运维动作（argv 形式，桌面端自包含）
//
// ## 为什么与上面那批 *Command 字符串并存了一段时间，现在取代它们
//
// 旧实现把命令拼成 shell 字符串交给 osascript 的 `do script`，理由写在 setupCommand 上：
// 「每一步都看得见输出 —— 失败时报错就在眼前」。这个理由是对的，但结论下错了：
// 用户要的是**看得见输出**，不是**切换到终端**。桌面端自己开一个任务窗口显示输出，
// 两个目标同时满足，而且不再需要 shellQuote / AppleScript 转义那两层易错的引号处理
// （第一轮代理审查里出 bug 最多的就是纯字符串拼装）。
//
// argv 直接交给 Process，参数边界由系统保证：路径含空格、引号、`$(...)` 全部无所谓。

/// 一步任务。title 显示在窗口里，让用户知道卡在哪一步。
struct TaskStep {
    let title: String
    let argv: [String]
}

func doctorSteps(repo: String) -> [TaskStep] {
    [TaskStep(title: "运行体检", argv: [(repo as NSString).appendingPathComponent("scripts/doctor.js")])]
}

func installSteps(unit: String, repo: String, appPath: String?) -> [TaskStep] {
    let script = serviceScriptPath(in: repo)
    var argv = [script, "install", unit]
    // menubar 必须带 --app：L1 的 precheck 没有它必然拒绝（第一轮审查发现子菜单里的
    // 「安装」对 menubar 是个恒失败的入口）。
    if unit == "menubar", let app = appPath { argv.append("--app=\(app)") }
    return [TaskStep(title: "安装 \(unit)", argv: argv)]
}

func uninstallSteps(unit: String, repo: String) -> [TaskStep] {
    [TaskStep(title: "卸载 \(unit)", argv: [serviceScriptPath(in: repo), "uninstall", unit, "--yes"])]
}

/// 「更新桌面端」一键项：用当前仓库源码重新编译并装进 /Applications（app-build --install
/// 内含编译+测试+安装三步）。成功后由 GUI 层的 onSuccess 自动重启本 app 换上新版。
func updateAppSteps(repo: String) -> [TaskStep] {
    [TaskStep(title: "编译并安装到 /Applications",
              argv: [(repo as NSString).appendingPathComponent("scripts/app-build.js"), "--install"])]
}

/// unit 子菜单「查看日志」预选源的下标：精确 title == unit 优先；LOG_FILE 自定义路径时
/// server 源的 title 是「server（LOG_FILE）」，按前缀兜底。找不到返回 nil（窗口保持默认选中）。
/// （此前这里是 unitLogSteps——任务窗口跑 `service.js logs` 打一段一次性文本，2026-08-17
/// 按机主反馈退役：点「查看日志」应直接看到持续刷新的日志视图，而不是被指去某个文件。）
func logSourceIndex(forUnit unit: String, in sources: [LogSource]) -> Int? {
    if let exact = sources.firstIndex(where: { $0.title == unit }) { return exact }
    return sources.firstIndex(where: { $0.title.hasPrefix(unit + "（") })
}

/// 首次装机：四步串行，任一失败即停。
///
/// 与旧的 setupCommand 逐字对应，只是从 `a && b && c` 的 shell 串拆成了显式步骤 ——
/// 这样用户能看到「卡在第几步」，而不是一坨输出里自己找。
func setupSteps(repo: String, workDir: String, hooks: Bool) -> [TaskStep] {
    let setup = (repo as NSString).appendingPathComponent("scripts/setup.js")
    let service = serviceScriptPath(in: repo)
    return [
        TaskStep(title: "生成配置", argv: [setup, "--yes", "--work-dir=\(workDir)", "--hooks=\(hooks ? "on" : "off")"]),
        TaskStep(title: "安装常驻服务", argv: [service, "install", "server"]),
        // `restart --wait` 而不是 `start`：后者只 kickstart 就返回，不等 server 真的起来。
        TaskStep(title: "启动并等待就绪", argv: [service, "restart", "server", "--wait"]),
        // ★ 末步必须是 **health** 而不是 status。
        //
        // status 是只读查询，无论服务 crashed 还是 running 都退出 0（那是对的 CLI 语义，
        // doctor D16 也靠它不抛）—— 拿它收尾，端口冲突时装机会一路绿灯报「全部完成」，
        // 而 server 正在崩溃循环。
        //
        // health 带 token 打 /health：端口被别的进程占着时它拿不到预期响应，退出码非零。
        // 这也是唯一能区分「我们的服务在监听」与「某个进程占着这个端口」的判据 ——
        // 纯 TCP 探测对占位进程一样探得通。
        TaskStep(title: "确认服务可用", argv: [service, "health"]),
    ]
}

// MARK: - 主窗口（控制台）
//
// ## 为什么需要它
//
// LSUIElement app 没有 Dock 图标、也不进 Cmd+Tab，**菜单栏图标是唯一入口**。
// 而 MacBook Pro 的刘海会挤掉靠右的菜单栏图标 —— 一旦被挤掉，用户没有任何办法把它找回来
// （再次 open CCM.app 只是激活已有实例，不显示任何窗口）。那不是体验问题，是入口消失。
//
// 主窗口 + 可选的 Dock 图标给出第二条路。顺带补上一个一直缺的东西：三个子窗口
// （配置/日志/任务）此前是散的，菜单栏那个下拉菜单在充当「主页」—— 而它正是刘海吃掉的东西。

enum ConsoleActionKind: String {
    case openWebUI, copyToken, config, logs, doctor, relocateRepo, relocateNode, setupWizard
}

struct ConsoleAction: Equatable {
    let kind: ConsoleActionKind
    let title: String
    let enabled: Bool
}

/// 主窗口上该出现哪些动作、哪些能点。
///
/// 判定集中在这里而不是散在按钮的 isEnabled 赋值里：环境不完整时几乎所有动作都没意义，
/// 而「按钮亮着但点了没反应」比「按钮是灰的」难排查得多。
/// 「打开 Web UI」能不能点。
///
/// **菜单与控制台必须共用这一份判据。**此前这层门禁只有控制台实现了（`consoleActions`
/// 里那两行），菜单里那两项恒可点 —— 同一个产品判断只落实一半，比两边都不做更难发现。
/// server 没跑时点它：copyToken 失败被刻意静默，然后 NSWorkspace 打开一个必然连不上的
/// 地址；`latest` 还是 nil 时 `webUIURL` 更会回落到硬编码的 127.0.0.1:3000，端口配成
/// 别的就是打开一个完全无关的页面，而 app 侧零反馈。
func canOpenWebUI(status: ServiceStatus?) -> Bool {
    status?.server?.stateName == "running"
}

/// 「复制访问令牌」能不能点。没配过就没有 token，也没有可打开的地址 ——
/// 该走装机向导，而不是点开一个必然 401 的页面。
func canCopyToken(status: ServiceStatus?) -> Bool {
    status?.setup?.envExists ?? false
}

func consoleActions(status: ServiceStatus?, problem: EnvProblem) -> [ConsoleAction] {
    // 环境坏掉时只留修复入口。此时 repo/node 都拿不到，其余动作全部会失败。
    switch problem {
    case .noRepo:
        return [ConsoleAction(kind: .relocateRepo, title: "重新定位仓库…", enabled: true)]
    case .noNode:
        return [ConsoleAction(kind: .relocateNode, title: "定位 node…", enabled: true)]
    case .none:
        break
    }

    let configured = canCopyToken(status: status)

    var out: [ConsoleAction] = []
    if !configured {
        out.append(ConsoleAction(kind: .setupWizard, title: "首次安装向导…", enabled: true))
    }
    out.append(ConsoleAction(kind: .openWebUI, title: "打开 Web UI", enabled: canOpenWebUI(status: status)))
    out.append(ConsoleAction(kind: .copyToken, title: "复制访问令牌", enabled: configured))
    // 配置与日志**不依赖 server 在跑** —— 那正是最需要它们的时刻（配置窗口走 CLI 读磁盘）。
    out.append(ConsoleAction(kind: .config, title: "配置…", enabled: true))
    out.append(ConsoleAction(kind: .logs, title: "查看日志", enabled: true))
    out.append(ConsoleAction(kind: .doctor, title: "运行体检", enabled: true))
    return out
}

/// Dock 图标偏好的存储键。默认**关**：这仍是个常驻后台工具，
/// 只有被刘海挤掉入口的人才需要它，不该让所有人的 Dock 多一个图标。
let DOCK_ICON_DEFAULTS_KEY = "CCMShowDockIcon"

/// 心跳的存储键。菜单栏在**每轮探测完成时**写这两个值，`scripts/doctor.js` 的 D19 用
/// `defaults read com.ccm.menubar <key>` 读出来判断「进程还在但主线程是不是卡死了」。
/// 那是 2026-08-23 之前系统里完全没有的信号：menubar unit 因为 `open` + KeepAlive=false
/// 恒显示「待机」，与 app 活着、崩了还是冻住毫无关系，于是它被一个看不见的确认框
/// 冻死 63 小时都没人发现。
/// 键名散落在 Swift 与 Node 两侧，由 tests/unit/desktop-schema-contract.test.mjs 钉住。
let HEARTBEAT_AT_KEY = "CCMLastProbeAt"   // Date().timeIntervalSince1970，**秒**
let HEARTBEAT_OK_KEY = "CCMLastProbeOk"   // 上一轮探测是否成功

// MARK: - 设备审批（对应 scripts/device.js 的 `list --json`，schemaVersion = 1）
//
// 桌面端此前完全没有设备审批入口。后果是装了 GUI 反而比 headless 少两条路：终端里的
// 「回车批准 / deny 拒绝」只在 `process.stdin.isTTY` 下注册（src/server/app.js），而
// launchd 拉起的 server 没有 TTY，那两条自动失效——机主只剩下开终端敲 device.js 一条路。
//
// 数据取自 CLI 而不是 server 的 HTTP 面：审批恰恰是「server 在跑但你还连不上」时要用的东西，
// 依赖 server 在线就本末倒置了。device.js 直接读写那两个 JSON，server 靠 fs.watch 感知。

struct PendingDevice: Decodable {
    let deviceId: String?
    let ip: String?
    let userAgent: String?
    let ts: Double?

    var id: String { deviceId ?? "" }
}

struct DeviceSnapshot: Decodable {
    let schemaVersion: Int?
    let pending: [PendingDevice]?
    let trusted: [String]?

    var pendingList: [PendingDevice] { pending ?? [] }
    var trustedList: [String] { trusted ?? [] }
}

/// 32 位 hex 的设备指纹在菜单里既放不下也没法读。截成 前8…后4：手机上那串是全量显示的，
/// 两端各留一截足够机主一眼对上，而 8 位十六进制的碰撞空间在单用户场景下绰绰有余。
func shortDeviceId(_ id: String) -> String {
    if id.isEmpty { return "（无 ID）" }
    guard id.count > 16 else { return id }
    return "\(id.prefix(8))…\(id.suffix(4))"
}

/// User-Agent → 一个人能认出来的设备类型。核对「在敲门的是不是我那台手机」时，
/// 「iPhone」比一整串 Mozilla/5.0 有用得多。
/// 顺序有讲究：iOS 的 UA 里含 "like Mac OS X"，先判 Mac 会把 iPhone/iPad 全认成 Mac。
func deviceKindLabel(_ ua: String?) -> String {
    guard let ua = ua, !ua.isEmpty else { return "未知设备" }
    if ua.contains("iPhone") { return "iPhone" }
    if ua.contains("iPad") { return "iPad" }
    if ua.contains("Android") { return "Android" }
    if ua.contains("Macintosh") || ua.contains("Mac OS") { return "Mac" }
    if ua.contains("Windows") { return "Windows" }
    return "其他设备"
}

/// 勾「开机自启」前的风险判据：当前 app 是不是跑在仓库目录里（那就是 desktop/build 的构建产物）。
///
/// 自启用的是 Bundle.main.bundlePath，而 getting-started.md 恰好教了一条「只想先看一眼」的路：
/// `npm run app:build && open desktop/build/CCM.app`。看完顺手勾自启，LaunchAgent 就钉死在一个
/// gitignore 的产物上，git clean / 换分支之后静默失效（2026-08-18 真机实证）。
///
/// **必须比到分隔符**：本仓的平级 worktree 检出位就是 `<repo>-<分支名>`（见 CLAUDE.md），
/// 裸 hasPrefix(repo) 会把 claude-chat-mobile-promo 误判成 claude-chat-mobile 的内部路径。
/// 与 scripts/service.js 里那条 status 警告用同一判据，两侧不该给出不同结论。
func isRunningFromRepoBuild(bundlePath: String, repo: String) -> Bool {
    bundlePath.hasPrefix(repo + "/")
}

/// 「我现在跑的是哪一份」——一行自证身份，给菜单与控制台共用。
///
/// 【为什么不是「显示版本号」那么简单】2026-08-24 实测：`/Applications/CCM.app` 与
/// `<repo>/desktop/build/CCM.app` 的 `CFBundleShortVersionString` **完全相同**（都是
/// package.json 的 semver），LaunchServices 里记的 version 字段也一样。所以版本号对
/// 「Spotlight 里那两个 CCM 哪个是哪个」「我跑的这份含不含某个修复」这两个真实问题
/// 零判别力 —— 那次排障只能去 stat 二进制的 mtime。有判别力的是下面这三段。
///
/// 缺失一律省略而不是显示 "unknown"：旧 bundle 没有这两个键，硬填占位只会让人
/// 以为构建坏了。少一段信息 ≠ 出了问题。
func appIdentityLine(version: String?, buildTime: String?, commit: String?,
                     bundlePath: String, repo: String?) -> String {
    var parts: [String] = ["CCM" + (version.map { " \($0)" } ?? "")]

    if let t = buildTime, !t.isEmpty { parts.append("\(t) 编译") }
    // "unknown" 是 app-build.js 在非 git 检出下写进去的占位，等同于「没有这条信息」
    if let c = commit, !c.isEmpty, c != "unknown" { parts.append(c) }

    parts.append(bundleLocationLabel(bundlePath: bundlePath, repo: repo))
    return parts.joined(separator: " · ")
}

/// bundle 所在位置的短标签。判据复用 `isRunningFromRepoBuild` —— 那个函数此前只在
/// 勾「开机自启」时用来弹一次警告，"我正跑着仓库构建产物"这个事实算得出来却从不显示。
private func bundleLocationLabel(bundlePath: String, repo: String?) -> String {
    if let repo, isRunningFromRepoBuild(bundlePath: bundlePath, repo: repo) {
        return "⚠ 仓库构建产物"
    }
    // 显示所在目录而不是硬说成 /Applications：用户可能把它拖去了 ~/Applications
    return (bundlePath as NSString).deletingLastPathComponent
}

/// 待审设备在菜单里的一行：类型 · 短 ID · 来源 IP。三样都是核对用的——
/// 类型答「是什么设备」，短 ID 答「是不是我屏幕上那台」，IP 答「从哪来的」。
/// 缺 IP 时如实写「未知来源」而不是省略：留一个悬空的 `·` 看起来像渲染坏了。
func pendingDeviceTitle(_ d: PendingDevice) -> String {
    let ip = (d.ip?.isEmpty == false) ? d.ip! : "未知来源"
    return "\(deviceKindLabel(d.userAgent)) · \(shortDeviceId(d.id)) · \(ip)"
}
