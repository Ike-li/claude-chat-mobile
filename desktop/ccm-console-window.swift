// ccm-console-window.swift —— 主窗口（控制台）与 Dock 图标切换。
//
// ## 为什么有这个窗口
//
// LSUIElement app 没有 Dock 图标、也不进 Cmd+Tab，菜单栏图标是**唯一**入口。而 MacBook Pro
// 的刘海会挤掉靠右的菜单栏图标 —— 被挤掉之后用户没有任何办法把它找回来（再次 open CCM.app
// 只是激活已有实例，不显示窗口）。那是入口消失，不是体验瑕疵。
//
// 这个窗口 + 可选的 Dock 图标给出第二条路，顺带补上一直缺的「主页」：配置/日志/任务三个
// 子窗口此前是散的，菜单栏那个下拉菜单在充当汇总视图 —— 而它正是刘海吃掉的东西。
//
// ## 判定不在这里
//
// 哪些动作可用（consoleActions）、状态怎么描述（summaryLine / unitTitle）全部在 CCMCore
// 且有断言。本文件只剩摆控件与接线。

import AppKit
import Foundation

final class ConsoleWindowController: NSWindowController, NSWindowDelegate {
    private let summary = NSTextField(labelWithString: "读取中…")
    private let unitsStack = NSStackView()
    private let actionsStack = NSStackView()
    private let repoLabel = NSTextField(labelWithString: "")
    private let dockToggle = NSButton(checkboxWithTitle: "在 Dock 中显示图标", target: nil, action: nil)
    private weak var delegateApp: AppDelegate?

    init(app: AppDelegate) {
        self.delegateApp = app
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 520, height: 460),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered, defer: false)
        window.title = "CCM 控制台"
        window.center()
        super.init(window: window)
        window.delegate = self
        buildChrome()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    private func buildChrome() {
        guard let window else { return }

        summary.font = .systemFont(ofSize: NSFont.systemFontSize + 2, weight: .medium)
        summary.lineBreakMode = .byTruncatingTail

        for s in [unitsStack, actionsStack] {
            s.orientation = .vertical
            s.alignment = .leading
            s.spacing = 6
        }

        repoLabel.textColor = .tertiaryLabelColor
        repoLabel.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        repoLabel.lineBreakMode = .byTruncatingHead

        dockToggle.target = self
        dockToggle.action = #selector(onToggleDock)
        dockToggle.state = ConsoleWindowController.dockIconEnabled ? .on : .off
        dockToggle.toolTip = "菜单栏图标被刘海挤掉时，用 Dock 图标进来"

        let root = NSStackView(views: [
            summary,
            separator(), unitsStack,
            separator(), actionsStack,
            separator(), dockToggle, repoLabel,
        ])
        root.orientation = .vertical
        root.alignment = .leading
        root.spacing = 12
        root.edgeInsets = NSEdgeInsets(top: 20, left: 22, bottom: 18, right: 22)
        root.translatesAutoresizingMaskIntoConstraints = false

        let container = NSView()
        container.addSubview(root)
        NSLayoutConstraint.activate([
            root.topAnchor.constraint(equalTo: container.topAnchor),
            root.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            root.trailingAnchor.constraint(lessThanOrEqualTo: container.trailingAnchor),
            root.bottomAnchor.constraint(lessThanOrEqualTo: container.bottomAnchor),
        ])
        window.contentView = container
    }

    private func separator() -> NSView {
        let v = NSBox()
        v.boxType = .separator
        v.widthAnchor.constraint(equalToConstant: 460).isActive = true
        return v
    }

    func present() {
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// 状态变了就刷新（由 AppDelegate 的轮询驱动，与菜单栏那盏灯同一份数据）。
    func refresh(status: ServiceStatus?, problem: EnvProblem, lastError: String?, staleSeconds: Int?, repo: String?) {
        summary.stringValue = summaryLine(status: status, problem: problem, lastError: lastError, staleSeconds: staleSeconds)
        repoLabel.stringValue = repo ?? "未定位仓库"

        unitsStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for u in status?.unitList ?? [] {
            unitsStack.addArrangedSubview(NSTextField(labelWithString: unitTitle(u)))
        }

        actionsStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for action in consoleActions(status: status, problem: problem) {
            let b = NSButton(title: action.title, target: self, action: #selector(onAction))
            b.bezelStyle = .rounded
            b.isEnabled = action.enabled
            b.identifier = NSUserInterfaceItemIdentifier(action.kind.rawValue)
            actionsStack.addArrangedSubview(b)
        }
    }

    @objc private func onAction(_ sender: NSButton) {
        guard let raw = sender.identifier?.rawValue,
              let kind = ConsoleActionKind(rawValue: raw) else { return }
        delegateApp?.performConsoleAction(kind)
    }

    // MARK: Dock 图标
    //
    // LSUIElement app 可以在运行时切成 .regular 拿到 Dock 图标。默认关：这仍是个常驻后台
    // 工具，只有被刘海挤掉入口的人才需要它。

    static var dockIconEnabled: Bool {
        UserDefaults.standard.bool(forKey: DOCK_ICON_DEFAULTS_KEY)
    }

    static func applyDockIconPolicy() {
        NSApp.setActivationPolicy(dockIconEnabled ? .regular : .accessory)
    }

    @objc private func onToggleDock(_ sender: NSButton) {
        UserDefaults.standard.set(sender.state == .on, forKey: DOCK_ICON_DEFAULTS_KEY)
        ConsoleWindowController.applyDockIconPolicy()
        // 切成 .regular 后要重新激活一次，否则窗口会退到别的 app 后面 ——
        // 而这个 app 此刻可能根本没有别的入口（正是刘海那个场景）。
        NSApp.activate(ignoringOtherApps: true)
        present()
    }
}
