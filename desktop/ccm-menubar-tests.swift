// ccm-menubar-tests.swift —— CCMCore.swift 的断言集，由 `npm run app:test` 编译执行。
//
// 刻意不引 XCTest：那要么拉一个 Xcode 工程，要么依赖 swift-testing 的包管理，两者都会往这个
// 「零 GUI 依赖」的仓库里塞进一整套构建体系。一个自己数失败数的 main() 已经够用 ——
// 它跑得动 CCMCore 里的每一个判定与每一处字符串拼装，而那正是第一轮代理审查里出 bug 最多的地方
// （install 参数拼错、Web UI URL 缺 token 都是纯字符串运算）。
//
// GUI 那半（NSMenu / NSAlert / Process）仍然没有自动化覆盖，那是明示接受的代价。

import Foundation

var failed = 0
var passed = 0

func check(_ cond: Bool, _ what: String) {
    if cond { passed += 1 } else { failed += 1; FileHandle.standardError.write("✗ \(what)\n".data(using: .utf8)!) }
}

func eq<T: Equatable>(_ got: T, _ want: T, _ what: String) {
    if got == want { passed += 1 } else {
        failed += 1
        FileHandle.standardError.write("✗ \(what)\n    got:  \(got)\n    want: \(want)\n".data(using: .utf8)!)
    }
}

func decode(_ json: String) -> ServiceStatus? {
    guard let d = json.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(ServiceStatus.self, from: d)
}

@main
struct CCMCoreTests {
    static func main() {
        testDecoding()
        testSymbol()
        testUnitPresentation()
        testSummaryLine()
        testServiceScriptPath()
        testShellQuote()
        testAppleScriptEscape()
        testCommands()
        testWebUIURL()
        testProbeInterval()

        let msg = "\nCCMCore: \(passed) passed, \(failed) failed\n"
        FileHandle.standardOutput.write(msg.data(using: .utf8)!)
        exit(failed == 0 ? 0 : 1)
    }

    // MARK: 解码韧性
    //
    // 全字段可选是有意的：Node 侧加字段是常事，而「一个字段变 null 就让整份解码失败、
    // 菜单整个空掉」是最糟的失败模式。这一组锁住那个承诺。

    static func testDecoding() {
        let full = """
        {"schemaVersion":1,"platform":"darwin","supported":true,"repo":"/r",
         "setup":{"envExists":true,"port":3000,"lanUrl":"http://192.168.1.9:3000"},
         "units":[{"unit":"server","label":"com.ccm.server","known":true,"ownership":"managed",
                   "state":"running","pid":123,"lastExitStatus":0,"flapping":false,"drift":[],
                   "plistPath":"/p","listen":{"port":3000,"reachable":true},"detail":""}],
         "warnings":[]}
        """
        let s = decode(full)
        check(s != nil, "完整 JSON 应解码成功")
        eq(s?.server?.pid, 123, "pid 解码")
        eq(s?.setup?.lanUrl, "http://192.168.1.9:3000", "lanUrl 解码")
        eq(s?.server?.listen?.reachable, true, "listen 解码")

        // Node 多出的字段（lastExitStatus / plistPath / labelPrefix）不该让解码失败
        check(decode(full) != nil, "多余字段应被忽略")

        // --fast 时 listen 为 null
        eq(decode("""
        {"schemaVersion":1,"supported":true,"units":[{"unit":"server","state":"running","listen":null}]}
        """)?.server?.listen == nil, true, "listen:null 应被吃下")

        // 非 darwin 的降级输出：units 空、port/lanUrl 为 null
        let unsup = decode("""
        {"schemaVersion":1,"platform":"linux","supported":false,"repo":"/r",
         "setup":{"envExists":true,"port":null,"lanUrl":null},"units":[],"warnings":["仅支持 macOS"]}
        """)
        eq(unsup?.isSupported, false, "supported:false 解码")
        eq(unsup?.unitList.count, 0, "units 为空")
        eq(unsup?.warnings?.count, 1, "warnings 解码")

        // ★ 将来某个字段被删掉或变 null，也不能让整份解码垮掉
        check(decode(#"{"schemaVersion":1}"#) != nil, "只有 schemaVersion 也应解码成功")
        check(decode(#"{"schemaVersion":1,"units":[{}]}"#) != nil, "空 unit 对象也应解码成功")
        eq(decode(#"{"schemaVersion":1,"units":[{}]}"#)?.unitList.first?.unitName, "?", "缺字段的 unit 有兜底名")
        eq(decode(#"{"schemaVersion":1,"units":[{}]}"#)?.unitList.first?.stateName, "unknown", "缺 state 时的兜底")

        check(decode("not json") == nil, "坏 JSON 应解码失败")
    }

    // MARK: 图标判定

    static func testSymbol() {
        func statusWith(_ unitsJSON: String, supported: Bool = true) -> ServiceStatus? {
            decode("""
            {"schemaVersion":1,"supported":\(supported),"units":[\(unitsJSON)]}
            """)
        }
        let running = #"{"unit":"server","state":"running","flapping":false,"drift":[]}"#

        eq(statusWith(running)?.symbol, "checkmark.circle", "全绿 → 对勾")
        eq(statusWith(#"{"unit":"server","state":"crashed"}"#)?.symbol, "xmark.octagon", "crashed → 叉")
        eq(statusWith(#"{"unit":"server","state":"not-installed"}"#)?.symbol, "exclamationmark.triangle", "未安装 → 三角")
        eq(statusWith(#"{"unit":"server","state":"stopped"}"#)?.symbol, "exclamationmark.triangle", "停止 → 三角")
        eq(statusWith("\(running),\(#"{"unit":"tunnel","state":"running","flapping":true}"#)")?.symbol,
           "exclamationmark.triangle", "任一 unit flapping → 三角")

        // ★ shape 漂移不算问题：用户换了启动方式（机主的隧道用自写包装脚本）是有意配置。
        eq(statusWith("\(running),\(#"{"unit":"tunnel","state":"running","drift":["shape"]}"#)")?.symbol,
           "checkmark.circle", "只有 shape 漂移 → 仍是对勾")
        eq(statusWith("\(running),\(#"{"unit":"tunnel","state":"running","drift":["repo-path"]}"#)")?.symbol,
           "exclamationmark.triangle", "真漂移 → 三角")

        eq(statusWith(running, supported: false)?.symbol, "questionmark.circle", "不支持的平台 → 问号")
        eq(statusWith(#"{"unit":"tunnel","state":"running"}"#)?.symbol, "questionmark.circle", "没有 server unit → 问号")
    }

    // MARK: unit 行展示

    static func testUnitPresentation() {
        func unit(_ json: String) -> UnitStatus? {
            decode("{\"schemaVersion\":1,\"units\":[\(json)]}")?.unitList.first
        }
        eq(unit(#"{"unit":"server","state":"running","flapping":false}"#)?.lamp, "●", "running → ●")
        eq(unit(#"{"unit":"server","state":"running","flapping":true}"#)?.lamp, "◐", "flapping 压过 running")
        eq(unit(#"{"unit":"x","state":"stopped"}"#)?.lamp, "○", "stopped → ○")
        eq(unit(#"{"unit":"x","state":"crashed"}"#)?.lamp, "✗", "crashed → ✗")
        eq(unit(#"{"unit":"x","state":"not-installed"}"#)?.lamp, "·", "未安装 → ·")

        // 归属决定能不能写。判据来自 L1，本文件不重算。
        eq(unit(#"{"unit":"x","ownership":"managed"}"#)?.isWritable, true, "managed 可写")
        eq(unit(#"{"unit":"x","ownership":"adoptable"}"#)?.isWritable, true, "adoptable 可写")
        eq(unit(#"{"unit":"x","ownership":"foreign"}"#)?.isWritable, false, "foreign 只读")
        eq(unit(#"{"unit":"x","ownership":"unknown"}"#)?.isWritable, false, "unknown 只读")

        let u = unit(#"{"unit":"server","state":"running","pid":42,"ownership":"managed"}"#)!
        eq(unitTitle(u).contains("(42)"), true, "标题带 PID")
        let foreign = unit(#"{"unit":"tunnel","state":"running","ownership":"foreign"}"#)!
        eq(unitTitle(foreign).contains("手工配置"), true, "foreign 标注归属")
        let unknown = unit(#"{"unit":"tunnel-watch","state":"stopped","ownership":"unknown"}"#)!
        eq(unitTitle(unknown).contains("非本仓"), true, "unknown 标注归属")

        // 三个非 running 的臂此前只有 lamp 被断言过，标题文案本身没有 —— 把它们都改成同一句话
        // 也照样绿，而这几行正是用户在菜单里唯一读到的东西。
        eq(unitTitle(unit(#"{"unit":"x","state":"stopped"}"#)!).contains("已停止"), true, "stopped 标题")
        eq(unitTitle(unit(#"{"unit":"x","state":"crashed"}"#)!).contains("已崩溃"), true, "crashed 标题")
        eq(unitTitle(unit(#"{"unit":"x","state":"not-installed"}"#)!).contains("未安装"), true, "未安装标题")
        // 没有 pid 时不该拼出「运行中 ()」这种空括号
        eq(unitTitle(unit(#"{"unit":"x","state":"running"}"#)!).contains("("), false, "无 pid 时不留空括号")
    }

    // MARK: 摘要行

    static func testSummaryLine() {
        eq(summaryLine(status: nil, problem: .noRepo, lastError: nil, staleSeconds: nil).contains("找不到仓库"),
           true, "环境问题优先于一切")
        eq(summaryLine(status: nil, problem: .noNode, lastError: nil, staleSeconds: nil).contains("找不到 node"),
           true, "node 缺失")
        eq(summaryLine(status: nil, problem: .none, lastError: nil, staleSeconds: nil), "读取中…", "首次加载")
        eq(summaryLine(status: nil, problem: .none, lastError: "boom", staleSeconds: nil).contains("boom"),
           true, "没有任何状态时把错误显出来")

        let s = decode("""
        {"schemaVersion":1,"supported":true,
         "units":[{"unit":"server","state":"running","flapping":false,
                   "listen":{"port":3000,"reachable":true}}]}
        """)
        eq(summaryLine(status: s, problem: .none, lastError: nil, staleSeconds: nil),
           "ccm · 运行中 · :3000", "正常态")

        // ★ 探测失败时**保留旧状态**并标注它有多旧，而不是清空 —— 清空会让用户以为服务没了。
        let stale = summaryLine(status: s, problem: .none, lastError: "service.js 无响应", staleSeconds: 42)
        eq(stale.contains("运行中"), true, "旧状态仍显示")
        eq(stale.contains("42s"), true, "标注过期秒数")

        let unreachable = decode("""
        {"schemaVersion":1,"supported":true,
         "units":[{"unit":"server","state":"running","listen":{"port":3000,"reachable":false}}]}
        """)
        eq(summaryLine(status: unreachable, problem: .none, lastError: nil, staleSeconds: nil).contains("连不上"),
           true, "进程在但端口不通要说出来")

        // 三个早退分支此前一条都没断言（unsupported 只经 symbol 那个不同的函数验过）
        let unsupported = decode(#"{"schemaVersion":1,"supported":false,"units":[]}"#)
        eq(summaryLine(status: unsupported, problem: .none, lastError: nil, staleSeconds: nil),
           "本机不支持 LaunchAgent 管理", "非 macOS 明说，不是伪装成正常")

        let noServer = decode(#"{"schemaVersion":1,"supported":true,"units":[{"unit":"tunnel","state":"running"}]}"#)
        eq(summaryLine(status: noServer, problem: .none, lastError: nil, staleSeconds: nil),
           "未发现 server unit", "只有隧道没有 server 时要说清")

        // ★ flapping 的语义是「1 小时内 ≥3 次重启」，不是「曾崩溃」——文案不能再说退出码那套
        let flapping = decode(#"{"schemaVersion":1,"supported":true,"units":[{"unit":"server","state":"running","flapping":true}]}"#)
        let flapLine = summaryLine(status: flapping, problem: .none, lastError: nil, staleSeconds: nil)
        eq(flapLine.contains("频繁重启"), true, "说频率")
        eq(flapLine.contains("曾崩溃"), false, "不再说退出码语义")

        let stopped = decode(#"{"schemaVersion":1,"supported":true,"units":[{"unit":"server","state":"stopped"}]}"#)
        eq(summaryLine(status: stopped, problem: .none, lastError: nil, staleSeconds: nil).contains("已停止"),
           true, "stopped 摘要")
    }

    // MARK: 仓库定位
    //
    // 判据是 scripts/service.js 存在而不是目录存在：仓库被删后父目录往往还在，
    // 只判目录会给一个假绿。此前这个函数零断言。

    static func testServiceScriptPath() {
        eq(serviceScriptPath(in: "/Users/you/code/ccm"), "/Users/you/code/ccm/scripts/service.js", "拼到 scripts/service.js")
        eq(serviceScriptPath(in: "/Users/you/code/ccm/"), "/Users/you/code/ccm/scripts/service.js", "末尾斜杠不产生双斜杠")
        eq(serviceScriptPath(in: "/a b/repo"), "/a b/repo/scripts/service.js", "路径含空格照样拼对")
    }

    // MARK: 转义

    static func testShellQuote() {
        eq(shellQuote("/plain/path"), "'/plain/path'", "普通路径")
        eq(shellQuote("/a b/c"), "'/a b/c'", "含空格")
        eq(shellQuote("/a$HOME/c"), "'/a$HOME/c'", "$ 被单引号中和")
        eq(shellQuote("/a`id`/c"), "'/a`id`/c'", "反引号被单引号中和")
        // 单引号用 '"'"' 闭合再拼接的经典写法
        eq(shellQuote("it's"), "'it'\"'\"'s'", "含单引号")
    }

    static func testAppleScriptEscape() {
        eq(appleScriptEscape("plain"), "plain", "无需转义")
        eq(appleScriptEscape("a\"b"), "a\\\"b", "双引号")
        // ★ 顺序要紧：先反斜杠后双引号。反过来会把刚插入的转义反斜杠再转义一遍。
        eq(appleScriptEscape("a\\b"), "a\\\\b", "反斜杠")
        eq(appleScriptEscape("a\\\"b"), "a\\\\\\\"b", "反斜杠 + 双引号的组合顺序")
        eq(appleScriptEscape("it's"), "it's", "单引号在 AppleScript 里无需转义")

        let script = terminalScript(command: "cd '/a b' && node x.js")
        eq(script.contains("do script \"cd '/a b' && node x.js\""), true, "命令被包进 do script")
        eq(script.hasPrefix("tell application \"Terminal\""), true, "AppleScript 头")
    }

    // MARK: 命令拼装（第一轮审查里出错最多的地方）

    static func testCommands() {
        let repo = "/Users/you/code/repo"

        // ★ menubar 必须带 --app，否则 L1 的 precheck 必然拒绝 —— 早前子菜单里的「安装」
        // 对 menubar / tunnel 就是个点了必然报错的入口。
        let menubar = installCommand(unit: "menubar", repo: repo, appPath: "/Applications/CCM.app")
        eq(menubar.contains("--app="), true, "menubar 安装必须带 --app")
        eq(menubar.contains("'/Applications/CCM.app'"), true, "app 路径被 shellQuote")

        // tunnel 的隧道名本工具无从得知 → 给一条待补全的模板。
        // ★ 但 do script 是**立刻执行**的（同 src/ops/log-terminal.js 的用法），所以占位符必须是
        // shell 安全的：裸写 `<隧道名>` 时 `<` `>` 是重定向算符，实测 zsh 直接
        // `no such file or directory: 隧道名` 退出码 1 —— node 一次都没跑，用户拿到的错误比
        // precheck 那句「装 tunnel 需要 --tunnel=…」还没信息量。加引号后命令能跑到 precheck。
        let tunnel = installCommand(unit: "tunnel", repo: repo, appPath: nil)
        eq(tunnel.contains("--tunnel="), true, "tunnel 安装给出 --tunnel 占位")
        eq(tunnel.contains("--cloudflared="), true, "tunnel 安装给出 --cloudflared")
        eq(tunnel.contains("<"), false, "占位符不能裸带 < （shell 会当成输入重定向）")
        eq(tunnel.contains(">"), false, "占位符不能裸带 > （shell 会当成输出重定向）")

        // ★ unit 也必须 shellQuote：它不是常量，来自 ~/Library/LaunchAgents 的文件名
        // （scripts/service.js 对未知 unit 走 `label.slice(prefix.length + 1)`），
        // 而这串最终经 osascript 的 do script 交给 shell 执行。
        eq(logsCommand(unit: "a;touch /tmp/pwned", repo: repo).contains("service.js logs 'a;touch /tmp/pwned'"),
           true, "logs 的 unit 要被 shellQuote")
        eq(uninstallCommand(unit: "a;id", repo: repo).contains("uninstall 'a;id'"),
           true, "uninstall 的 unit 要被 shellQuote")
        eq(installCommand(unit: "a;id", repo: repo, appPath: nil).contains("install 'a;id'"),
           true, "install 的 unit 要被 shellQuote")

        // unit 现在也过 shellQuote（见 CCMCore.swift 的理由），'server' 与 server 在 shell 里等价
        eq(installCommand(unit: "server", repo: repo, appPath: nil),
           "cd '/Users/you/code/repo' && node scripts/service.js install 'server'",
           "server 安装无需额外参数")

        // 卸载必须带 --yes：manager 层默认拒绝（那是 2026-08-13 事故后加的护栏）
        eq(uninstallCommand(unit: "server", repo: repo).contains("--yes"), true, "卸载必须带 --yes")

        eq(logsCommand(unit: "server", repo: repo).contains("logs 'server' --follow"), true, "日志命令")
        eq(doctorCommand(repo: repo).contains("scripts/doctor.js"), true, "doctor 命令")

        // 装机向导：四步串起来，且 work-dir 必须显式传（setup.js 非交互模式绝不回落 $HOME）
        let setup = setupCommand(repo: repo, workDir: "/Users/you/work", hooks: true)
        eq(setup.contains("--work-dir='/Users/you/work'"), true, "work-dir 显式且被引用")
        eq(setup.contains("--hooks=on"), true, "hooks=on")
        eq(setupCommand(repo: repo, workDir: "/w", hooks: false).contains("--hooks=off"), true, "hooks=off")
        eq(setup.contains("install server"), true, "向导包含安装")
        eq(setup.contains("start server"), true, "向导包含启动")

        // 路径含空格 / 单引号时整条命令仍然是安全的
        let odd = installCommand(unit: "server", repo: "/Users/o'brien/my repo", appPath: nil)
        eq(odd.contains("'/Users/o'\"'\"'brien/my repo'"), true, "怪路径被正确引用")
    }

    // MARK: Web UI 地址

    static func testWebUIURL() {
        let withLan = decode(#"{"schemaVersion":1,"setup":{"port":3000,"lanUrl":"http://192.168.1.9:3000"}}"#)
        eq(webUIURL(status: withLan), "http://192.168.1.9:3000", "优先用 L1 给的 lanUrl")

        let noLan = decode(#"{"schemaVersion":1,"setup":{"port":8080,"lanUrl":null}}"#)
        eq(webUIURL(status: noLan), "http://127.0.0.1:8080", "拿不到 lanUrl 时回落 localhost + 真实端口")

        eq(webUIURL(status: nil), "http://127.0.0.1:3000", "什么都没有时回落默认端口")

        // ★ 刻意**不**拼 #token=：那需要把 AUTH_TOKEN 读进本进程内存，
        // 而 L1 有 copy-token（经 pbcopy 直送剪贴板）。菜单的做法是先复制再打开。
        eq(webUIURL(status: withLan).contains("token"), false, "URL 里绝不含令牌")
    }

    static func testProbeInterval() {
        eq(probeInterval(menuOpen: false), 10, "菜单关着低频")
        eq(probeInterval(menuOpen: true), 2, "菜单打开高频")
    }
}
