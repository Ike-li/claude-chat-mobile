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
        testConfigSchemaDecoding()
        testConfigItemPresentation()
        testConfigCommands()
        testLogHelpers()
        testConfigSnapshot()
        testTaskSteps()
        testConsoleActions()
        testPortConflictPresentation()
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

        // ── UI 可理解性（2026-08-17 机主反馈「不知道谁是干嘛的」）────────────────
        // stopped 的状态词按**调度形态**定制：定时器与打火即退任务的「停止」是健康待机，
        // 照写「已停止」会被读成故障（用户真的来问过）。server/tunnel 的 stopped 才是真没跑。
        //
        // ★ 2026-08-18：判据从 unit 名字表换成 status --json 里的 schedule 字段。
        // 名字表只硬编码了 logrotate/menubar 两个自家模板，机主自建的 com.ccm.tunnel-watch
        // （每 30s 救一次隧道）落进 default 仍被标「已停止」—— 机主本人因此来问「这个要启用吗」。
        // 用户随时可能再加一个 watch，名字表永远追不上；plist 里的调度形态是现成的事实。
        eq(unitTitle(unit(#"{"unit":"logrotate","state":"stopped","schedule":{"kind":"periodic","calendar":{"Hour":3,"Minute":47}}}"#)!).contains("待机 · 每天 03:47"),
           true, "时刻由 plist 算出，模板改了文案跟着变")
        eq(unitTitle(unit(#"{"unit":"menubar","state":"stopped","schedule":{"kind":"on-demand"}}"#)!).contains("随登录自启"),
           true, "打火即退的常态语义")
        eq(unitTitle(unit(#"{"unit":"tunnel-watch","state":"stopped","schedule":{"kind":"periodic","everySeconds":30}}"#)!).contains("待机 · 每 30 秒触发"),
           true, "模板里没有的自建 unit 同样认得出待机——名字表做不到这条")
        eq(unitTitle(unit(#"{"unit":"server","state":"stopped","schedule":{"kind":"resident"}}"#)!).contains("已停止"),
           true, "KeepAlive 的 unit 停了就是真停了，绝不粉饰")
        eq(unitTitle(unit(#"{"unit":"x","state":"stopped"}"#)!).contains("已停止"),
           true, "没有 schedule 字段（旧版 CLI）时保守回落「已停止」")
        // 灯也要跟着分：待机用 ◌，与 scripts/service.js 的 STATE_ICON 同一套符号。
        eq(unit(#"{"unit":"x","state":"stopped","schedule":{"kind":"periodic","everySeconds":30}}"#)?.lamp, "◌",
           "待机的灯不能和真停止一样")
        eq(unit(#"{"unit":"x","state":"stopped","schedule":{"kind":"resident"}}"#)?.lamp, "○",
           "常驻服务停了仍是 ○")

        // 分组：server/tunnel 是日常主服务，其余收进「其他服务」子菜单
        let all = ["server", "tunnel", "logrotate", "menubar", "tunnel-watch"].map {
            unit("{\"unit\":\"\($0)\",\"state\":\"stopped\"}")!
        }
        let g = splitUnits(all)
        eq(g.primary.map(\.unitName), ["server", "tunnel"], "主服务两项且顺序保持")
        eq(g.secondary.map(\.unitName), ["logrotate", "menubar", "tunnel-watch"], "其余进次组")

        // 连点：unit 正在 kickstart 时子菜单的启动/停止/重启必须灭掉，否则关菜单再开再点会叠两次
        eq(isControlEnabled(unit: "server", busyUnits: ["server"]), false, "进行中不可再点重启")
        eq(isControlEnabled(unit: "server", busyUnits: ["logrotate"]), true, "别的 unit 忙不影响 server")
        eq(isControlEnabled(unit: "logrotate", busyUnits: ["logrotate"]), false, "短命 unit 进行中同样灭掉")
        eq(isControlEnabled(unit: "logrotate", busyUnits: []), true, "空闲可点")
        eq(serviceControlTimeout > 25, true, "必须长过 service.js 的 kickstart 窗口（25s），否则 GUI 会先杀掉还在节流的合法调用")

        // tooltip：实现词汇的人话解释；归属标注要展开说明
        check(unitTooltip(unit(#"{"unit":"server","state":"running"}"#)!).contains("重启"),
              "server tooltip 提到改配置后要重启")
        check(unitTooltip(foreign).contains("手工配置"), "foreign tooltip 解释「手工配置」")
        check(unitTooltip(unknown).contains("非本仓"), "unknown tooltip 解释「非本仓」")
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

    // MARK: 命令拼装（第一轮审查里出错最多的地方）

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

// MARK: - 配置 schema（P3）

func decodeSchema(_ json: String) -> ConfigSchema? {
    guard let d = json.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(ConfigSchema.self, from: d)
}

func testConfigSchemaDecoding() {
    // ★ 与 ServiceStatus 同一条纪律：Node 侧多给字段不能让整份解码失败。
    // 配置窗口整个空掉，比少显示一行糟得多。
    let withExtras = #"""
    {"schemaVersion":1,"groups":[{"id":"auth","label":{"zh":"鉴权","en":"Auth"},
     "items":[{"key":"AUTH_TOKEN","kind":"readonly","label":{"zh":"访问令牌"},
               "secret":true,"masked":{"set":true,"length":64},"brandNewField":123}]}],
     "somethingAddedLater":{"a":1}}
    """#
    let s = decodeSchema(withExtras)
    check(s != nil, "多出来的字段不该让解码失败")
    eq(s?.schemaVersion, 1, "schemaVersion 解出来")
    eq(s?.groupList.count, 1, "一个分组")
    eq(s?.groupList.first?.label?.text, "鉴权", "中文优先")

    // 缺字段同样不能炸：整份 items 缺失时给空数组而不是 nil 崩溃点
    let sparse = decodeSchema(#"{"schemaVersion":1,"groups":[{"id":"x"}]}"#)
    eq(sparse?.groupList.first?.visibleItems.count, 0, "缺 items 时是空数组")

    // 没有 key 的条目直接滤掉：它渲染不出任何有意义的控件，留着只会是一行空白
    let noKey = decodeSchema(#"{"schemaVersion":1,"groups":[{"id":"x","items":[{"kind":"text"}]}]}"#)
    eq(noKey?.groupList.first?.visibleItems.count, 0, "无 key 的条目被滤掉")

    // 版本判据：对不上就该显示提示，而不是拿旧字段猜新格式
    check(decodeSchema(#"{"schemaVersion":1}"#)?.isCompatible(with: 1) == true, "版本一致")
    check(decodeSchema(#"{"schemaVersion":2}"#)?.isCompatible(with: 1) == false, "版本不一致要能判出来")
    check(decodeSchema(#"{"groups":[]}"#)?.isCompatible(with: 1) == false, "缺版本号视为不兼容")
}

func testConfigItemPresentation() {
    func item(_ json: String) -> ConfigItem? {
        guard let d = json.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(ConfigItem.self, from: d)
    }

    // ★ 可编辑判据必须看 kind，不能看 readonly 字段。
    // readonly 是服务端给**手机面板**的渲染提示：list 项被标只读只因前端没有数组编辑器。
    // 照搬它会让 WORKDIRS 在桌面上也不能改 —— 而桌面端正是该负责编辑它的地方。
    let list = item(#"{"key":"WORKDIRS","kind":"list","readonly":true}"#)
    check(list?.isEditable == true, "list 在桌面端可编辑（readonly 是给手机面板的）")
    let ro = item(#"{"key":"AUTH_TOKEN","kind":"readonly","readonly":true}"#)
    check(ro?.isEditable == false, "真 readonly 不可编辑")

    // secret 永远不预填明文 —— 服务端根本没下发（只给 {set,length}）
    let secretSet = item(#"{"key":"NTFY_TOKEN","kind":"secret","secret":true,"masked":{"set":true,"length":20}}"#)
    eq(secretSet?.displayValue, "••••••••", "已设置的 secret 显示掩码")
    let secretUnset = item(#"{"key":"NTFY_TOKEN","kind":"secret","secret":true,"masked":{"set":false,"length":0}}"#)
    eq(secretUnset?.displayValue, "", "未设置的 secret 显示空")
    let plain = item(#"{"key":"PORT","kind":"number","value":"4100"}"#)
    eq(plain?.displayValue, "4100", "非 secret 预填实际值")

    // ★★ toggle 的取值域：`config get --json` 下发的是 JSON 真值的字符串化
    // （"true"/"false"），**不是** .env 字面量（''/'off'/'1'/'on'）。
    //
    // 上一版这里的 fixture 写的是 "value":"off" —— production 从不产生那个形态，于是断言与
    // 实现互相印证、125 条全绿，而真机上每一个设置过的开关都显示反且改不动。
    // 这组断言直接喂 `config get` 真正会给的值。
    let onOff = #"{"key":"WEB_STATUSLINE","kind":"toggle","values":{"on":"","off":"off"}}"#
    let oneEmpty = #"{"key":"DEV_MODE","kind":"toggle","values":{"on":"1","off":""}}"#

    check(ConfigItem.decodedToggle(item(onOff)!, current: "false") == false, "默认开的项：get 给 false ⇒ 关")
    check(ConfigItem.decodedToggle(item(onOff)!, current: "true") == true, "默认开的项：get 给 true ⇒ 开")
    check(ConfigItem.decodedToggle(item(oneEmpty)!, current: "true") == true, "默认关的项：get 给 true ⇒ 开")
    check(ConfigItem.decodedToggle(item(oneEmpty)!, current: "false") == false, "默认关的项：get 给 false ⇒ 关")

    // 未设置的项不在 get 的输出里 ⇒ current 为空 ⇒ 回落 schema 默认方向
    check(ConfigItem.decodedToggle(item(onOff)!, current: "") == true, "未设置 + 默认开 ⇒ 开")
    check(ConfigItem.decodedToggle(item(oneEmpty)!, current: "") == false, "未设置 + 默认关 ⇒ 关")

    // secret 的「已设置」判据来自 get 而不是 schema（cmdSchema 传空 values，masked 恒为 set:false）
    eq(ConfigItem.secretDisplay(current: "<已设置，64 字符>"), "••••••••", "已设置的 secret 显示掩码")
    eq(ConfigItem.secretDisplay(current: ""), "", "未设置的 secret 显示空")
}

func testConfigCommands() {
    let repo = "/Users/you/my repo"   // 刻意带空格：argv 形式下它不需要任何转义

    eq(configSchemaArgs(repo: repo),
       ["/Users/you/my repo/scripts/config.js", "schema", "--json"], "schema argv")
    eq(configGetArgs(repo: repo),
       ["/Users/you/my repo/scripts/config.js", "get", "--json"], "get argv")

    // ★ 这些 argv 直接交给 Process，**不经 shell**，所以刻意不做引号处理。
    // 加了 shellQuote 反而会把引号当成值的一部分写进配置文件。
    eq(configSetArgs(repo: repo, changes: [("PORT", "4100"), ("WORK_DIR", "/a b/c")]),
       ["/Users/you/my repo/scripts/config.js", "set", "PORT=4100", "WORK_DIR=/a b/c"],
       "set argv：含空格的路径原样传")
    check(configSetArgs(repo: repo, changes: []) == nil, "空改动不该起进程")
    eq(configUnsetArgs(repo: repo, keys: ["PORT"]),
       ["/Users/you/my repo/scripts/config.js", "unset", "PORT"], "unset argv")
    check(configUnsetArgs(repo: repo, keys: []) == nil, "空 keys 不该起进程")

    // ★ CLI 侧收的是 true/false，**不是** .env 字面量 'off'/'1'。
    // scripts/config.js 的 parseCliValue 专门为此写了一套解析：送 'off' 过去，
    // 对默认开的项会被读成「开」（因为 'off' 不等于 CLI 认的 false 词表…）——
    // 实际上 parseCliValue 认识 'off'，但送 '1'/'' 这类就会出事。统一用 true/false 最安全。
    eq(toggleArgValue(true), "true", "开 → true")
    eq(toggleArgValue(false), "false", "关 → false")
}

func testLogHelpers() {
    let text = (1...50).map { "line \($0)" }.joined(separator: "\n")
    eq(lastLines(text, 3), ["line 48", "line 49", "line 50"], "取最后三行")
    eq(lastLines("a\nb", 10).count, 2, "行数不足时全给")
    eq(lastLines("", 5), [""], "空文本给一个空行而不是崩")

    // 日志源列表：LOG_FILE 配置的路径优先置顶；~/Library/Logs 下的 ccm-*.log 全部列出
    // （tunnel / logrotate / menubar / tunnel-watch……有文件就有源），server 排最前；
    // .gz 轮转历史与非 ccm 前缀文件不进列表。
    eq(logSources(configured: nil, home: "/h", fileNames: []), [], "无配置无文件 → 空列表")
    let names = ["ccm-tunnel.log", "ccm-server.log", "ccm-server.log.1.gz", "other.log", "ccm-tunnel-watch.log"]
    let plain = logSources(configured: nil, home: "/h", fileNames: names)
    eq(plain.map(\.title), ["server", "tunnel", "tunnel-watch"], "server 置顶其余字母序；gz 与非 ccm 文件排除")
    eq(plain[0].path, "/h/Library/Logs/ccm-server.log", "路径 = 日志目录 + 文件名")
    let custom = logSources(configured: "/tmp/x.log", home: "/h", fileNames: ["ccm-server.log"])
    eq(custom.map(\.title), ["server（LOG_FILE）", "server"], "LOG_FILE 自定义路径置顶，默认位置仍单独可选")
    let dup = logSources(configured: "/h/Library/Logs/ccm-server.log", home: "/h", fileNames: ["ccm-server.log"])
    eq(dup.count, 1, "LOG_FILE 恰为默认路径时去重，不出现两个相同源")
    eq(logSources(configured: "", home: "/h", fileNames: []), [], "空字符串配置视同未配置")

    // 「重启应用」argv：经 sh 先 sleep 等旧实例退出再 open；路径必须 POSIX 单引号转义 ——
    // 含空格不能拆词、含单引号不能注入（8/13 教训：包裹方式错误＝命令注入）。
    let relaunch = relaunchArgv(bundlePath: "/Applications/CCM.app")
    eq(Array(relaunch.prefix(2)), ["/bin/sh", "-c"], "经 sh 以便 sleep 等旧实例先退出")
    check(relaunch[2].contains("/usr/bin/open '/Applications/CCM.app'"), "路径单引号包裹")
    let tricky = relaunchArgv(bundlePath: "/Users/o'brien/My Apps/CCM.app")[2]
    check(tricky.contains("open '/Users/o'\\''brien/My Apps/CCM.app'"), "单引号 POSIX 转义且空格不拆词")
}

func testConfigSnapshot() {
    // 迁移引导的判据：桌面端要区分「已迁移」「仍在 .env」「还没配过」三态。
    // 混成一个的话，老用户会看到一张能填的表单、点保存却收到「去命令行跑 migrate」。
    let legacy = ConfigSnapshot(values: ["PORT": "4001"], source: "env")
    check(legacy.isLegacyEnv, "source=env ⇒ 需要引导迁移")
    check(!legacy.isUnconfigured, "有 .env 不算未配置")

    let migrated = ConfigSnapshot(values: ["PORT": "4001"], source: "config")
    check(!migrated.isLegacyEnv, "source=config ⇒ 可直接编辑")

    let fresh = ConfigSnapshot(values: [:], source: "none")
    check(fresh.isUnconfigured, "source=none ⇒ 还没配过")
    check(!fresh.isLegacyEnv, "未配置不是旧格式")

    eq(configMigrateArgs(repo: "/r"), ["/r/scripts/config.js", "migrate", "--json"], "migrate argv")
}

func testTaskSteps() {
    let repo = "/Users/you/my repo"   // 带空格：argv 形式下不需要任何转义

    eq(doctorSteps(repo: repo).first?.argv, ["/Users/you/my repo/scripts/doctor.js"], "doctor argv")

    // menubar 必须带 --app，否则 L1 precheck 恒拒（旧实现里这是个恒失败的入口）
    let mb = installSteps(unit: "menubar", repo: repo, appPath: "/Applications/CCM.app")
    eq(mb.first?.argv.last, "--app=/Applications/CCM.app", "menubar 带 app 路径")
    eq(installSteps(unit: "server", repo: repo, appPath: nil).first?.argv,
       ["/Users/you/my repo/scripts/service.js", "install", "server"], "server 安装 argv")
    // 没拿到 app 路径时不拼半截参数
    eq(installSteps(unit: "menubar", repo: repo, appPath: nil).first?.argv.count, 3, "缺 app 路径就不加")

    eq(uninstallSteps(unit: "tunnel", repo: repo).first?.argv.last, "--yes", "卸载须显式确认")

    // unit 子菜单「查看日志」直接打开内嵌日志窗口并预选该 unit 的源。此前的 unitLogSteps
    // （任务窗口里跑 service.js logs 打一段文本）已于 2026-08-17 退役——机主反馈「都是让去
    // 某某文件看」：一次性文本输出不是日志视图。source title 恰好 = unit 名；LOG_FILE
    // 自定义路径时 server 源的 title 是「server（LOG_FILE）」，按前缀也要能选中。
    let srcs = [LogSource(title: "server（LOG_FILE）", path: "/x"),
                LogSource(title: "server", path: "/y"),
                LogSource(title: "tunnel", path: "/z")]
    eq(logSourceIndex(forUnit: "server", in: srcs), 1, "精确匹配优先于 LOG_FILE 形态")
    eq(logSourceIndex(forUnit: "tunnel", in: srcs), 2, "普通 unit 精确匹配")
    eq(logSourceIndex(forUnit: "server", in: [LogSource(title: "server（LOG_FILE）", path: "/x")]),
       0, "只有 LOG_FILE 形态时按前缀选中")
    eq(logSourceIndex(forUnit: "logrotate", in: srcs), nil, "无此源返回 nil（窗口保持默认选中）")

    // 「更新桌面端」一键项（2026-08-17 机主反馈「没有一个总的重启按钮」）：
    // 重新编译并装进 /Applications；成功后自动 relaunch 属 GUI 层（onSuccess 回调）。
    let upd = updateAppSteps(repo: repo)
    eq(upd.count, 1, "更新一步到位（app-build --install 内含编译+安装）")
    check(upd.first?.argv.first?.hasSuffix("scripts/app-build.js") ?? false, "跑 app-build")
    check(upd.first?.argv.contains("--install") ?? false, "带 --install 装进 /Applications")

    // 装机四步，顺序与旧的 shell && 串逐字对应
    let steps = setupSteps(repo: repo, workDir: "/a b/c", hooks: true)
    eq(steps.count, 4, "装机四步")
    eq(steps[0].argv[2], "--work-dir=/a b/c", "含空格的路径原样传，不转义")
    eq(steps[0].argv[3], "--hooks=on", "hooks 开")
    eq(setupSteps(repo: repo, workDir: "/x", hooks: false)[0].argv[3], "--hooks=off", "hooks 关")
    eq(steps[1].argv, ["/Users/you/my repo/scripts/service.js", "install", "server"], "第二步安装")
    // 【变更记录】此前断言末步是 status。status 恒退出 0（只读查询的正确语义），
    // 拿它收尾会让端口冲突场景一路绿灯报「全部完成」—— 详见 testPortConflictPresentation。
    eq(steps[3].argv.last, "health", "末步确认服务真的可用")
}

func testConsoleActions() {
    func status(_ json: String) -> ServiceStatus? { decode(json) }
    let running = #"{"schemaVersion":1,"supported":true,"setup":{"envExists":true},"units":[{"unit":"server","state":"running"}]}"#
    let stopped = #"{"schemaVersion":1,"supported":true,"setup":{"envExists":true},"units":[{"unit":"server","state":"stopped"}]}"#
    let fresh = #"{"schemaVersion":1,"supported":true,"setup":{"envExists":false},"units":[{"unit":"server","state":"not-installed"}]}"#

    // 环境坏掉时只留修复入口：其余动作此刻全都会失败，亮着按钮只会让人以为点了没反应
    let noRepo = consoleActions(status: nil, problem: .noRepo)
    eq(noRepo.count, 1, "没有仓库时只给一个动作")
    eq(noRepo.first?.kind, .relocateRepo, "且是重新定位")
    eq(consoleActions(status: nil, problem: .noNode).first?.kind, .relocateNode, "没有 node 同理")

    let ok = consoleActions(status: status(running), problem: .none)
    check(ok.first(where: { $0.kind == .openWebUI })?.enabled == true, "server 在跑 ⇒ 可打开 Web UI")
    check(!ok.contains(where: { $0.kind == .setupWizard }), "已配置 ⇒ 不显示装机向导")

    // server 没跑时打不开 Web UI，但配置和日志照常 —— 那正是最需要它们的时刻
    let down = consoleActions(status: status(stopped), problem: .none)
    check(down.first(where: { $0.kind == .openWebUI })?.enabled == false, "server 停了 ⇒ Web UI 禁用")
    check(down.first(where: { $0.kind == .config })?.enabled == true, "配置不依赖 server")
    check(down.first(where: { $0.kind == .logs })?.enabled == true, "日志不依赖 server")

    // 全新机器：给装机向导，且没有 token 可复制
    let new = consoleActions(status: status(fresh), problem: .none)
    check(new.first?.kind == .setupWizard, "未配置 ⇒ 首项是装机向导")
    check(new.first(where: { $0.kind == .copyToken })?.enabled == false, "没配过 ⇒ 复制令牌禁用")
}

func testPortConflictPresentation() {
    // ★ 装机末步必须能判定成败。status 恒退出 0（只读查询的正确语义），拿它收尾会让
    // 端口冲突场景一路绿灯报「全部完成」，而 server 正在崩溃循环。
    let steps = setupSteps(repo: "/r", workDir: "/w", hooks: false)
    check(!(steps.last?.argv.contains("status") ?? true), "末步不能是 status —— 它恒退出 0")
    eq(steps.last?.argv.last, "health", "末步用 health：带 token 打 /health，能区分是不是我们的服务")
    check(steps[2].argv.contains("--wait"), "启动要等就绪，不能 kickstart 完就返回")

    // ★ 服务没在跑、端口却通 ⇒ 被别的进程占着。这正是端口冲突的 signature，
    // 而此前显示成 "已崩溃 · :4567"，端口号旁边没有任何异常标记、反而像是正常的。
    func line(_ state: String, reachable: Bool) -> String {
        let json = """
        {"schemaVersion":1,"supported":true,"units":[{"unit":"server","state":"\(state)",
         "listen":{"port":4567,"reachable":\(reachable)}}]}
        """
        return summaryLine(status: decode(json), problem: .none, lastError: nil, staleSeconds: nil)
    }
    check(line("crashed", reachable: true).contains("被其它进程占用"), "崩溃 + 端口通 ⇒ 指出被占用")
    check(line("stopped", reachable: true).contains("被其它进程占用"), "停止 + 端口通 ⇒ 同理")
    check(line("running", reachable: true).contains(":4567"), "正常运行时照常显示端口")
    check(!line("running", reachable: true).contains("被其它进程占用"), "运行中不该报占用")
    check(line("crashed", reachable: false).contains("连不上"), "崩溃 + 端口不通 ⇒ 仍是连不上")
}
