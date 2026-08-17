// ccm-config-window.swift —— 配置窗口与日志窗口（AppKit）。
//
// ## 为什么单独一个文件
//
// ccm-menubar.swift 已经 700 行，而这两个窗口与菜单栏是两件事：菜单栏是「一盏灯 + 几个动作」，
// 窗口是「一张表单 + 一个滚动文本」。放一起只会让那个文件继续长。
//
// ## 判定不在这里
//
// schema 解码、可编辑判据、toggle 方向、命令拼装、日志尾部截取 —— 全部在 CCMCore.swift 里
// 且有断言覆盖。本文件只剩「创建控件、摆位置、把值读出来」这些没法自动测的部分，
// 与 ccm-menubar.swift 的分工完全一致（那边的复盘：出 bug 最多的是纯字符串运算，
// 而那些现在都在 Core 里）。
//
// ## 为什么走 CLI 而不是 HTTP
//
// 配置窗口最该能用的时刻，恰恰是 server 起不来的时刻 —— 那时任何走 socket 的方案都是白屏。
// scripts/config.js 不依赖 server 进程，读的就是磁盘上那份文件。

import AppKit
import Foundation

// MARK: - 配置读写客户端（范式同 ServiceClient）

final class ConfigClient {
    private let env: RuntimeEnv
    init(env: RuntimeEnv) { self.env = env }

    func schema() -> Probe<ConfigSchema> {
        guard let node = env.node, let repo = env.repo else { return .failed("环境不完整") }
        guard let r = runSync(node, configSchemaArgs(repo: repo), cwd: repo, timeout: 8) else {
            return .failed("config.js 无响应")
        }
        guard r.status == 0 else {
            let msg = firstLine(r.stderr)
            return .failed(msg.isEmpty ? "config.js 退出码 \(r.status)" : msg)
        }
        guard let data = r.stdout.data(using: .utf8),
              let parsed = try? JSONDecoder().decode(ConfigSchema.self, from: data) else {
            return .failed("config.js 输出无法解析")
        }
        return .ok(parsed)
    }

    /// 当前值。**与 schema 分两次取**：schema 是表单描述（不含任何值），
    /// get 才是配置快照且 secret 已脱敏。合成一次请求会让 secret 明文有机会混进表单描述。
    func currentValues() -> Probe<ConfigSnapshot> {
        guard let node = env.node, let repo = env.repo else { return .failed("环境不完整") }
        guard let r = runSync(node, configGetArgs(repo: repo), cwd: repo, timeout: 8) else {
            return .failed("config.js 无响应")
        }
        guard r.status == 0 else {
            // 原样转发 L1 的话（坏 JSON 在这里就是「ccm.config.json 解析失败：…」）——
            // 它比这里能编的任何一句都准确，而且直接告诉用户该去修哪个文件。
            let msg = [r.stdout, r.stderr].map(firstLine).first { !$0.isEmpty } ?? ""
            return .failed(msg.isEmpty ? "读取配置失败（退出码 \(r.status)）" : msg)
        }
        guard let data = r.stdout.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let rows = obj["rows"] as? [[String: Any]] else {
            return .failed("config.js 输出无法解析")
        }
        var out: [String: String] = [:]
        for row in rows {
            if let k = row["key"] as? String, let v = row["value"] as? String { out[k] = v }
        }
        return .ok(ConfigSnapshot(values: out, source: (obj["source"] as? String) ?? "config"))
    }

    /// 旧版 .env → ccm.config.json。**桌面端也要能做**：否则老用户在窗口里看到一张能填的
    /// 表单、点保存却收到一句「去命令行跑 migrate」—— 图形界面把人赶回终端是最差的收尾。
    func migrate() -> Probe<Void> {
        guard let node = env.node, let repo = env.repo else { return .failed("环境不完整") }
        guard let r = runSync(node, configMigrateArgs(repo: repo), cwd: repo, timeout: 15) else {
            return .failed("config.js 无响应")
        }
        if r.status == 0 { return .ok(()) }
        let msg = [r.stdout, r.stderr].map(firstLine).first { !$0.isEmpty } ?? ""
        return .failed(msg.isEmpty ? "迁移失败（退出码 \(r.status)）" : msg)
    }

    /// 保存一批改动。错误文案原样取自 L1 —— 那边的校验信息比这里能编的任何一句都准确。
    func save(_ changes: [(key: String, value: String)]) -> Probe<Void> {
        guard let node = env.node, let repo = env.repo else { return .failed("环境不完整") }
        guard let args = configSetArgs(repo: repo, changes: changes) else { return .ok(()) }
        guard let r = runSync(node, args, cwd: repo, timeout: 15) else { return .failed("config.js 无响应") }
        if r.status == 0 { return .ok(()) }
        let msg = [r.stderr, r.stdout].map(firstLine).first { !$0.isEmpty } ?? ""
        return .failed(msg.isEmpty ? "保存失败（退出码 \(r.status)）" : msg)
    }
}

// MARK: - 配置窗口

final class ConfigWindowController: NSWindowController {
    private let client: ConfigClient
    private let env: RuntimeEnv
    private let stack = NSStackView()
    private let statusLabel = NSTextField(labelWithString: "")
    private var controls: [String: (item: ConfigItem, view: NSView)] = [:]
    private var loadedValues: [String: String] = [:]
    private var legacyEnv = false

    init(env: RuntimeEnv) {
        self.env = env
        self.client = ConfigClient(env: env)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 640, height: 560),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "CCM 配置"
        window.center()
        super.init(window: window)
        buildChrome()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    private func buildChrome() {
        guard let window else { return }
        let root = NSView()

        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 16, left: 20, bottom: 16, right: 20)
        stack.translatesAutoresizingMaskIntoConstraints = false

        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.documentView = stack
        scroll.translatesAutoresizingMaskIntoConstraints = false

        let save = NSButton(title: "保存", target: self, action: #selector(onSave))
        save.keyEquivalent = "\r"
        let reload = NSButton(title: "重新读取", target: self, action: #selector(onReload))
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.lineBreakMode = .byTruncatingTail

        let bar = NSStackView(views: [statusLabel, NSView(), reload, save])
        bar.orientation = .horizontal
        bar.spacing = 8
        bar.edgeInsets = NSEdgeInsets(top: 8, left: 20, bottom: 12, right: 20)
        bar.translatesAutoresizingMaskIntoConstraints = false
        statusLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        root.addSubview(scroll)
        root.addSubview(bar)
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: root.topAnchor),
            scroll.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            bar.topAnchor.constraint(equalTo: scroll.bottomAnchor),
            bar.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            bar.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            bar.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            stack.widthAnchor.constraint(equalTo: scroll.widthAnchor),
        ])
        window.contentView = root
    }

    func present() {
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        onReload(nil)
    }

    // MARK: 加载与渲染

    @objc private func onReload(_ sender: Any?) {
        statusLabel.stringValue = "读取中…"
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            let schema = self.client.schema()
            let values = self.client.currentValues()
            DispatchQueue.main.async { self.render(schema, values) }
        }
    }

    private func render(_ probe: Probe<ConfigSchema>, _ valuesProbe: Probe<ConfigSnapshot>) {
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        controls.removeAll()

        // 值读不出来时**不能**渲染一张空表单：那看起来像「所有项都没配过」，
        // 用户一保存就会把真实配置覆盖成一批空值。
        var values: [String: String] = [:]
        switch valuesProbe {
        case .failed(let why):
            let msg = "读不到当前配置：\(why)"
            statusLabel.stringValue = msg
            stack.addArrangedSubview(NSTextField(labelWithString: msg))
            return
        case .ok(let snap):
            values = snap.values
            legacyEnv = snap.isLegacyEnv
        }
        loadedValues = values

        switch probe {
        case .failed(let why):
            statusLabel.stringValue = "读不到配置：\(why)"
            stack.addArrangedSubview(NSTextField(labelWithString: "读不到配置：\(why)"))
            return
        case .ok(let schema):
            // 版本对不上时**不猜**：拿旧字段渲染新格式，用户看到的是一张似是而非的表单。
            guard schema.isCompatible(with: SUPPORTED_CONFIG_SCHEMA_VERSION) else {
                let msg = "配置格式版本 \(schema.schemaVersion ?? 0) 与本 app 支持的 "
                    + "\(SUPPORTED_CONFIG_SCHEMA_VERSION) 不一致 —— 请更新 CCM.app（npm run app:build）"
                statusLabel.stringValue = msg
                stack.addArrangedSubview(NSTextField(labelWithString: msg))
                return
            }
            // 旧格式：先给一条横幅 + 一键迁移。此时保存必然被 L1 拒绝（写入会遮蔽整份 .env），
            // 与其让用户填完表单才撞墙，不如一进来就说清楚下一步是什么。
            if legacyEnv { stack.addArrangedSubview(legacyBanner()) }
            for group in schema.groupList {
                let items = group.visibleItems
                if items.isEmpty { continue }
                stack.addArrangedSubview(sectionHeader(group.label?.text ?? group.id ?? ""))
                for item in items { stack.addArrangedSubview(row(for: item, values: values)) }
            }
            statusLabel.stringValue = "共 \(controls.count) 项可编辑"
        }
    }

    private func legacyBanner() -> NSView {
        let text = NSTextField(labelWithString:
            "这台机器还在用旧版 .env 配置。迁移成 ccm.config.json 后才能在这里保存修改 —— "
            + "迁移是 1:1 转换，原 .env 会保留供回滚。")
        text.lineBreakMode = .byWordWrapping
        text.maximumNumberOfLines = 3
        text.preferredMaxLayoutWidth = 420

        let button = NSButton(title: "迁移配置", target: self, action: #selector(onMigrate))
        button.bezelStyle = .rounded

        let box = NSStackView(views: [text, button])
        box.orientation = .horizontal
        box.spacing = 12
        box.edgeInsets = NSEdgeInsets(top: 8, left: 8, bottom: 8, right: 8)
        return box
    }

    @objc private func onMigrate(_ sender: Any?) {
        statusLabel.stringValue = "迁移中…"
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            let result = self.client.migrate()
            DispatchQueue.main.async {
                switch result {
                case .ok:
                    self.statusLabel.stringValue = "已迁移到 ccm.config.json（原 .env 已保留，重启 server 后生效）"
                    self.onReload(nil)
                case .failed(let why):
                    self.statusLabel.stringValue = "迁移失败：\(why)"
                }
            }
        }
    }

    private func sectionHeader(_ text: String) -> NSView {
        let label = NSTextField(labelWithString: text)
        label.font = .boldSystemFont(ofSize: NSFont.systemFontSize + 1)
        return label
    }

    private func row(for item: ConfigItem, values: [String: String]) -> NSView {
        let name = NSTextField(labelWithString: item.label?.text ?? item.name)
        name.toolTip = item.help?.text
        name.widthAnchor.constraint(equalToConstant: 190).isActive = true

        // 服务端下发的 value 是 schema 附带的快照，而 get 拿到的是**当前**值 —— 后者优先。
        // secret 两边都不给明文，displayValue 负责显示掩码。
        let current = values[item.name] ?? item.value ?? ""
        let control = makeControl(for: item, current: current)
        controls[item.name] = (item, control)

        let hint = NSTextField(labelWithString: item.help?.text ?? "")
        hint.textColor = .tertiaryLabelColor
        hint.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        hint.lineBreakMode = .byTruncatingTail
        hint.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let line = NSStackView(views: [name, control])
        line.orientation = .horizontal
        line.spacing = 10

        let cell = NSStackView(views: item.help?.text.isEmpty == false ? [line, hint] : [line])
        cell.orientation = .vertical
        cell.alignment = .leading
        cell.spacing = 2
        return cell
    }

    private func makeControl(for item: ConfigItem, current: String) -> NSView {
        if item.kindName == "toggle" {
            let sw = NSSwitch()
            // 判定走 CCMCore 而不是就地写：方向由「哪一侧字面量是空串」决定，
            // 写反的话开关显示与实际相反，用户改一下反而关不掉。那条判定有断言覆盖。
            sw.state = ConfigItem.decodedToggle(item, current: current) ? .on : .off
            sw.isEnabled = item.isEditable
            return sw
        }

        let field: NSTextField = item.isSecret ? NSSecureTextField() : NSTextField()
        field.stringValue = item.isSecret ? ConfigItem.secretDisplay(current: current) : current
        field.isEditable = item.isEditable
        field.isSelectable = true
        field.placeholderString = item.`default`.map { "默认 \($0)\(item.unit ?? "")" }
        field.widthAnchor.constraint(equalToConstant: 320).isActive = true
        if !item.isEditable { field.textColor = .secondaryLabelColor }
        return field
    }

    // MARK: 保存

    @objc private func onSave(_ sender: Any?) {
        var changes: [(key: String, value: String)] = []
        for (key, entry) in controls {
            guard entry.item.isEditable else { continue }
            if let sw = entry.view as? NSSwitch {
                let now = sw.state == .on
                // CLI 收 true/false，不是 .env 字面量（parseCliValue 有专门的一套解析）
                if now != ConfigItem.decodedToggle(entry.item, current: loadedValues[key] ?? entry.item.value ?? "") {
                    changes.append((key, toggleArgValue(now)))
                }
                continue
            }
            guard let field = entry.view as? NSTextField else { continue }
            // secret 的输入框预填的是掩码。**没动过就绝不提交** —— 否则会把 "••••••••"
            // 当成新密钥写进配置文件，把用户真正的 token 冲掉。
            let old = loadedValues[key] ?? entry.item.value ?? ""
            // secret 输入框预填的是掩码，没动过就绝不提交 —— 否则会把 "••••••••" 当成新密钥
            // 写进配置，把用户真正的 token 冲掉。判据必须与预填时用的是同一个函数。
            if entry.item.isSecret && field.stringValue == ConfigItem.secretDisplay(current: old) { continue }
            if field.stringValue != old { changes.append((key, field.stringValue)) }
        }

        guard !changes.isEmpty else { statusLabel.stringValue = "没有改动"; return }
        statusLabel.stringValue = "保存中…"
        let snapshot = changes
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            let result = self.client.save(snapshot)
            DispatchQueue.main.async {
                switch result {
                case .ok:
                    self.statusLabel.stringValue = "已保存 \(snapshot.count) 项（多数改动需重启 server 生效）"
                    self.onReload(nil)
                case .failed(let why):
                    // 原样显示 L1 的校验信息：它知道为什么被拒，这里不二次加工
                    self.statusLabel.stringValue = "保存失败：\(why)"
                }
            }
        }
    }
}

// MARK: - 日志窗口

final class LogWindowController: NSWindowController, NSWindowDelegate {
    private let env: RuntimeEnv
    private let textView = NSTextView()
    private let pathLabel = NSTextField(labelWithString: "")
    private let sourcePopup = NSPopUpButton()
    private var timer: Timer?
    private var sources: [LogSource] = []

    /// 当前选中的日志文件；源列表为空时 nil（pathLabel 显示提示，refresh 不读盘）。
    private var logPath: String? {
        let idx = sourcePopup.indexOfSelectedItem
        guard idx >= 0, idx < sources.count else { return nil }
        return sources[idx].path
    }

    init(env: RuntimeEnv) {
        self.env = env
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 820, height: 520),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "CCM 日志"
        window.center()
        super.init(window: window)
        // ★ 必须当 delegate。程序化创建的 NSWindow delegate 为 nil，红色关闭按钮走
        // NSWindow.close() 而**不经过** NSWindowController.close() —— 只 override 后者的话，
        // 用户关掉窗口后那个 2s 轮询会一直读盘到 app 退出（AppDelegate 强引用着 controller）。
        window.delegate = self
        buildChrome()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    private func buildChrome() {
        guard let window else { return }
        textView.isEditable = false
        textView.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        textView.autoresizingMask = [.width]

        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.documentView = textView
        scroll.translatesAutoresizingMaskIntoConstraints = false

        sourcePopup.target = self
        sourcePopup.action = #selector(sourceChanged)
        pathLabel.textColor = .secondaryLabelColor
        pathLabel.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        pathLabel.lineBreakMode = .byTruncatingHead
        let bar = NSStackView(views: [sourcePopup, pathLabel])
        bar.edgeInsets = NSEdgeInsets(top: 6, left: 12, bottom: 6, right: 12)
        bar.translatesAutoresizingMaskIntoConstraints = false

        let root = NSView()
        root.addSubview(scroll)
        root.addSubview(bar)
        NSLayoutConstraint.activate([
            bar.topAnchor.constraint(equalTo: root.topAnchor),
            bar.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            bar.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: bar.bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: root.bottomAnchor),
        ])
        window.contentView = root
    }

    /// preferUnit 非 nil 时预选该 unit 的日志源（unit 子菜单「查看日志」带着来意打开窗口）。
    func present(preferUnit: String? = nil) {
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        resolveSources()
        if let unit = preferUnit, let idx = logSourceIndex(forUnit: unit, in: sources) {
            sourcePopup.selectItem(at: idx)
            pathLabel.stringValue = logPath ?? ""
            textView.string = "" // 换源先清屏，同 sourceChanged
        }
        refresh()
        // 2s 一次：日志是给人看的，再快也读不过来，而每次都要读盘。
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.refresh() }
    }

    /// 窗口关掉就停轮询 —— 否则一个后台定时器会一直读盘到 app 退出。
    /// 两条路径都要接：红按钮 → windowWillClose；代码调用 → close()。
    func windowWillClose(_ notification: Notification) { stopPolling() }

    override func close() {
        stopPolling()
        super.close()
    }

    private func stopPolling() {
        timer?.invalidate()
        timer = nil
    }

    /// 源列表 = LOG_FILE 配置 + ~/Library/Logs 的 ccm-*.log 扫描。判定在 CCMCore.logSources
    /// （有断言），本方法只做它测不了的部分：读配置、枚举目录、重建下拉框，并尽量保持当前选中。
    private func resolveSources() {
        var configured: String?
        if case .ok(let snap) = ConfigClient(env: env).currentValues() { configured = snap.values["LOG_FILE"] }
        let home = NSHomeDirectory()
        let logsDir = (home as NSString).appendingPathComponent("Library/Logs")
        let names = (try? FileManager.default.contentsOfDirectory(atPath: logsDir)) ?? []
        let previous = logPath
        sources = logSources(configured: configured, home: home, fileNames: names)
        // 逐条 addItem 而不是 addItems(withTitles:)：后者对重复标题会静默吞项。
        sourcePopup.removeAllItems()
        for s in sources { sourcePopup.menu?.addItem(NSMenuItem(title: s.title, action: nil, keyEquivalent: "")) }
        if let previous, let idx = sources.firstIndex(where: { $0.path == previous }) {
            sourcePopup.selectItem(at: idx)
        }
        pathLabel.stringValue = logPath ?? "未发现日志文件（~/Library/Logs/ccm-*.log，或配置里设 LOG_FILE）"
    }

    @objc private func sourceChanged() {
        pathLabel.stringValue = logPath ?? ""
        textView.string = "" // 换源先清屏，免得旧源的尾巴看起来像新源的内容
        refresh()
    }

    private func refresh() {
        guard let path = logPath else { return }
        DispatchQueue.global(qos: .utility).async { [weak self] in
            // ★ 只读尾部。一个几百 MB 的日志（DEBUG_SDK_MESSAGES 长开曾刷到 149MB）
            // 整份读进内存会直接卡死 UI —— 而那恰恰是最需要看日志的时候。
            guard let handle = FileHandle(forReadingAtPath: path) else { return }
            defer { try? handle.close() }
            let size = (try? handle.seekToEnd()) ?? 0
            let from = size > UInt64(LOG_TAIL_BYTES) ? size - UInt64(LOG_TAIL_BYTES) : 0
            try? handle.seek(toOffset: from)
            let data = (try? handle.readToEnd()) ?? Data()
            let text = String(data: data, encoding: .utf8) ?? ""
            let body = lastLines(text, 500).joined(separator: "\n")
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                guard self.textView.string != body else { return } // 没变就不重绘，免得把滚动位置弹走
                self.textView.string = body
                self.textView.scrollToEndOfDocument(nil)
            }
        }
    }
}

// MARK: - 任务窗口
//
// 桌面端自己跑命令并**流式**显示输出，取代此前「拼一条 shell 串丢给 Terminal」的做法。
//
// 那个做法的理由（写在旧 setupCommand 上）是「每一步都看得见输出，失败时报错就在眼前」——
// 理由对，结论错：用户要的是看得见输出，不是切换到终端。自己开窗口两个目标都满足，
// 而且不再需要 shellQuote + AppleScript 转义那两层易错的引号处理。
//
// **不能复用 runSync**：那个是同步阻塞的，跑 doctor（几十秒）会让整个 UI 卡死，
// 而且它要等进程退出才返回，拿不到流式输出。这里用异步 readabilityHandler。

final class TaskWindowController: NSWindowController, NSWindowDelegate {
    private let textView = NSTextView()
    private let statusLabel = NSTextField(labelWithString: "")
    private var running: Process?

    init() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 720, height: 460),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.center()
        super.init(window: window)
        window.delegate = self
        buildChrome()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    private func buildChrome() {
        guard let window else { return }
        textView.isEditable = false
        textView.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        textView.autoresizingMask = [.width]

        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.documentView = textView
        scroll.translatesAutoresizingMaskIntoConstraints = false

        statusLabel.textColor = .secondaryLabelColor
        let bar = NSStackView(views: [statusLabel])
        bar.edgeInsets = NSEdgeInsets(top: 8, left: 12, bottom: 8, right: 12)
        bar.translatesAutoresizingMaskIntoConstraints = false

        let root = NSView()
        root.addSubview(scroll)
        root.addSubview(bar)
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: root.topAnchor),
            scroll.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            bar.topAnchor.constraint(equalTo: scroll.bottomAnchor),
            bar.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            bar.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            bar.bottomAnchor.constraint(equalTo: root.bottomAnchor),
        ])
        window.contentView = root
    }

    /// 关窗即终止在跑的进程。留着它在后台跑完是最糟的：用户以为取消了，
    /// 而 install 那类命令正在改 ~/Library/LaunchAgents。
    func windowWillClose(_ notification: Notification) {
        running?.terminate()
        running = nil
    }

    func run(title: String, steps: [TaskStep], node: String, cwd: String) {
        window?.title = title
        textView.string = ""
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        runStep(steps, index: 0, node: node, cwd: cwd)
    }

    private func append(_ text: String) {
        guard !text.isEmpty else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.textView.string += text
            self.textView.scrollToEndOfDocument(nil)
        }
    }

    /// 逐步执行，任一步非零退出即停 —— 与旧实现的 `a && b && c` 语义一致。
    private func runStep(_ steps: [TaskStep], index: Int, node: String, cwd: String) {
        guard index < steps.count else {
            DispatchQueue.main.async { [weak self] in self?.statusLabel.stringValue = "全部完成" }
            return
        }
        let step = steps[index]
        DispatchQueue.main.async { [weak self] in
            self?.statusLabel.stringValue = "第 \(index + 1)/\(steps.count) 步：\(step.title)…"
        }
        append("\n$ \(step.argv.joined(separator: " "))\n")

        let task = Process()
        task.executableURL = URL(fileURLWithPath: node)
        task.arguments = step.argv
        task.currentDirectoryURL = URL(fileURLWithPath: cwd)

        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = pipe          // 合流：用户看的是一条时间线，不是两个流
        pipe.fileHandleForReading.readabilityHandler = { [weak self] h in
            let data = h.availableData
            guard !data.isEmpty else { return }
            self?.append(String(data: data, encoding: .utf8) ?? "")
        }

        task.terminationHandler = { [weak self] proc in
            pipe.fileHandleForReading.readabilityHandler = nil
            // 排空退出前最后一批还没被 handler 读走的数据，否则末尾几行（常常正是错误原因）会丢
            if let rest = try? pipe.fileHandleForReading.readToEnd(), !rest.isEmpty {
                self?.append(String(data: rest, encoding: .utf8) ?? "")
            }
            guard let self else { return }
            if proc.terminationStatus == 0 {
                self.runStep(steps, index: index + 1, node: node, cwd: cwd)
            } else {
                self.running = nil
                DispatchQueue.main.async {
                    self.statusLabel.stringValue = "「\(step.title)」失败（退出码 \(proc.terminationStatus)），已停止后续步骤"
                }
            }
        }

        do {
            try task.run()
            running = task
        } catch {
            append("无法启动：\(error.localizedDescription)\n")
            DispatchQueue.main.async { [weak self] in self?.statusLabel.stringValue = "启动失败" }
        }
    }
}
