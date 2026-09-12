import AppKit

/// 连接二维码窗口：显示一张已渲染好的 PNG，手机扫一下就能带着 token 进 Web UI。
///
/// 【为什么需要它】终端里的 `node scripts/qr.js` 走全块字符渲染，要 90 列 × 45 行的窗口
/// （半块只要 23 行，但 2026-09-09 真机实测两版都扫不出来——终端行距会在模块之间留横缝）。
/// 原生窗口没有列宽和行距这两个约束，是这个尺寸问题唯一有意义的解法。
///
/// 【token 明文不进本进程】PNG 由 `qr.js --png-stdout` 在它自己的进程里渲染完再经管道送来，
/// 这里拿到的已经是像素、不是凭据字符串。这条与 `ServiceClient.copyToken` 的「明文直送
/// pbcopy」同源——见 ccm-menubar.swift 里那条注释。**别为了省事改成在 Swift 侧
/// CIQRCodeGenerator**：那只要十行，但会让 AUTH_TOKEN 明文进菜单栏进程内存，而那条红线
/// 只写在注释里、没有门禁守着。
///
/// 【非模态】用 `makeKeyAndOrderFront` 而不是 `runModal`：2026-08-23 菜单栏冻死 63 小时的
/// 根因就是模态框占死主线程。
@MainActor
final class QrWindowController: NSWindowController, NSWindowDelegate {
    private let imageView = NSImageView()
    private let notes: String
    private let isPublic: Bool

    /// - Parameters:
    ///   - notes: qr.js 打在 stderr 上的说明，**原样显示不做解读**。受 CF Access 保护的公网码
    ///     里根本不含令牌，那句「扫码后完成 2FA」只有 Node 侧算得出来（见 shared/public-target.js）；
    ///     在这里照着判一遍，两处迟早分叉，而分叉的表现是屏幕上的说明与码里的内容对不上。
    ///   - isPublic: 只影响标题与警告的措辞。公网码泄露的后果与局域网码差一个量级——
    ///     后者还要求对方在同一个 WiFi 里，前者是全世界。
    init(png: Data, notes: String, isPublic: Bool) {
        self.notes = notes
        self.isPublic = isPublic
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 470, height: 610),
            styleMask: [.titled, .closable],
            backing: .buffered, defer: false)
        window.title = isPublic ? "公网连接二维码" : "连接二维码"
        window.center()
        super.init(window: window)
        window.delegate = self
        build(png: png)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    private func build(png: Data) {
        guard let window else { return }
        let root = NSStackView()
        root.orientation = .vertical
        root.alignment = .centerX
        root.spacing = 14
        root.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
        root.translatesAutoresizingMaskIntoConstraints = false

        imageView.image = NSImage(data: png)
        imageView.imageScaling = .scaleProportionallyUpOrDown
        // 二维码必须是正方形且不被插值糊掉边界，固定边长而不是随窗口拉伸
        imageView.translatesAutoresizingMaskIntoConstraints = false
        imageView.widthAnchor.constraint(equalToConstant: 400).isActive = true
        imageView.heightAnchor.constraint(equalToConstant: 400).isActive = true
        root.addArrangedSubview(imageView)

        let hint = NSTextField(labelWithString: "用手机相机扫一下，直接进 Web UI")
        hint.font = .systemFont(ofSize: NSFont.systemFontSize)
        root.addArrangedSubview(hint)

        if !notes.isEmpty {
            let noteLabel = NSTextField(wrappingLabelWithString: notes)
            noteLabel.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
            noteLabel.alignment = .center
            noteLabel.preferredMaxLayoutWidth = 410
            root.addArrangedSubview(noteLabel)
        }

        let warn = NSTextField(wrappingLabelWithString: isPublic
            ? "⚠️ 这是一把公网可用的钥匙。局域网码泄露还要求对方在你的 WiFi 里，公网码泄露则是全世界任何人都能接入这台机器——投屏、录屏或旁边有人时请立刻关掉本窗口。"
            : "⚠️ 二维码里含完整访问令牌。投屏、录屏或旁边有人时请关掉本窗口——明文令牌人会本能地遮，一个「看起来无害」的二维码不会，拍一张就是完整凭据。")
        warn.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        warn.textColor = isPublic ? .systemRed : .secondaryLabelColor
        warn.alignment = .center
        warn.preferredMaxLayoutWidth = 410
        root.addArrangedSubview(warn)

        window.contentView = root
    }

    /// 与 ConsoleWindowController / ConfigWindowController 同款：菜单栏 app 是 LSUIElement，
    /// 不 activate 的话窗口会出现在别的 app 后面，看起来像「点了没反应」。
    func present() {
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// 关窗即丢图：凭据没有理由在窗口关掉之后还留在进程内存里。
    func windowWillClose(_ notification: Notification) {
        imageView.image = nil
    }
}
