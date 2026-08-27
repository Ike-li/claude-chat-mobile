// CCMProcess.swift —— 子进程调用层：spawn 一个命令、带真实超时地收集它的输出。
//
// **为什么从 ccm-menubar.swift 抽出来单独一个文件**：2026-08-22 现场抓到一次 FD 泄漏
// —— 菜单栏进程持有 2550 个 pipe fd 撞上限自锁，`service.js` 的每一次调用（状态刷新、
// 启动、停止、复制令牌、设备审批）全部返回 nil，界面上只显示「service.js 无响应」，
// 而 server 照常在跑。停止按钮点了没反应就是这么来的。
//
// 根因是**两个独立缺陷叠加**（缺陷 ③，各自的修法见下面两处 ★）：
//
//   (a) Foundation 不归还父进程侧的 pipe 读端 fd。这是主因，**每一次调用都漏 2 个**，
//       与成功/超时/有没有孙进程全都无关。实测判据：把 reader 线程整个去掉、只 spawn 一个
//       `sh -c "exit 0"` 并 waitUntilExit，函数返回后 fd 照样净增 2 —— 没有任何自定义代码
//       持有它。所以别再从「谁强持了 Pipe」的方向找，那条路是错的（本文件初稿就错在这）。
//   (b) `readDataToEndOfFile()` 没有 deadline。孙进程继承了写端时它永久阻塞，于是连
//       (a) 的修法「读完自己关」都执行不到。实测：只修 (a) 不修 (b)，孙进程场景 4 次调用
//       净增 8 个 fd。两个都得修。
//
// 这段代码「有副作用但必须可测」：它进不了 CCMCore.swift（那层的存在理由就是零 Process、
// 零副作用），也没法留在 ccm-menubar.swift 里测（那个文件有 @main，与测试的 @main 冲突）。
// 所以单开一层，同时进 APP_SOURCES 与 TEST_SOURCES —— 见 scripts/app-build.js。
// 回归断言在 ccm-menubar-tests.swift 的 testRunSyncResourceHygiene（真 spawn，非纯函数）。
//
// 与 CCMCore 的分工：CCMCore 决定「拼什么命令、显示什么话」（纯函数），本文件只管
// 「把命令跑起来并且不泄漏资源」。两边都有断言集。

import Foundation

// MARK: - 子进程环境（登录 shell 的 PATH）

/// 登录 shell 的 PATH，**进程内解析一次**。
///
/// 为什么需要它：见 CCMCore.swift 的 `childEnvironment` 注释——GUI 血统的 PATH 只有四个系统
/// 目录，装在 ~/.local/bin 的 claude、装在 /opt/homebrew/bin 的 node 全都找不到。
///
/// 为什么成功失败都只解析一次：`zsh -lc` 要跑完整套 rc 文件，实测几十到几百毫秒，而 runSync
/// 是每 2~10 秒一次的探测路径——不缓存等于给每次探测加一份固定开销。失败也缓存，是因为
/// 失败只可能来自「/bin/zsh 不在」或「shell 配置本身炸了」，两者都要用户干预，重试没有意义，
/// 反而会让每次探测都白等一个 5 秒超时（失败路径拖垮日常路径是最糟的取舍）。修好后重开 app 即可。
private final class LoginShellPath: @unchecked Sendable {
    static let shared = LoginShellPath()
    private let lock = NSLock()
    private var resolved = false
    private var path: String?

    func value() -> String? {
        lock.lock()
        if resolved { defer { lock.unlock() }; return path }
        lock.unlock()

        // ★ 显式传自身环境，打破递归：runSync 默认要问 childProcessEnvironment()，
        //   而后者正要问本函数。这是整条链上唯一一处不注入的调用，故意如此。
        let out = runSync("/bin/zsh", ["-lc", "printf %s \"$PATH\""], timeout: 5,
                          env: ProcessInfo.processInfo.environment)?.stdout
        let trimmed = out?.trimmingCharacters(in: .whitespacesAndNewlines)
        let got = (trimmed?.isEmpty == false) ? trimmed : nil

        lock.lock()
        resolved = true
        path = got
        lock.unlock()
        return got
    }
}

/// 所有子进程共用的环境。**唯一的构造入口**——每个 spawn 点都必须用它，
/// 由 ccm-menubar-tests.swift 的 `testEverySpawnInjectsEnvironment` 源码闸守着。
func childProcessEnvironment() -> [String: String] {
    childEnvironment(base: ProcessInfo.processInfo.environment, loginPath: LoginShellPath.shared.value())
}

// MARK: - 进程调用

/// 简易结果类型。Swift 的 Result 要求错误类型遵循 Error，而这里的「错误」只是一句给用户看的话。
enum Probe<T> {
    case ok(T)
    case failed(String)
}

struct RunResult {
    let status: Int32
    let stdout: String
    let stderr: String
}

/// 把 fd 读到 EOF 或 deadline 为止，**绝不永久阻塞**（缺陷 ③ 的 (b) 半 —— 另一半是调用点的
/// 「读完自己关」，两者缺一都仍会泄漏）。
///
/// 不用 `FileHandle.readDataToEndOfFile()`：它的返回条件是「写端全部关闭」，而写端可能被一个
/// 我们根本不认识的**孙进程**持有 —— service.js 内部 spawn 的 launchctl / nc 一旦变成孤儿就是
/// 如此。那时读线程永久阻塞，`close()` 那一行就永远执行不到。
///
/// 也不用「到点了 close 读端把它踹醒」：在 BSD 上 close() 一个正被另一线程 read() 阻塞的 fd
/// 是未定义行为，read 未必返回；而 FileHandle 撞上 EBADF 会抛 ObjC 异常，Swift 的 try? 接不住
/// —— 那是拿崩溃换泄漏。改成非阻塞读 + poll 轮询：线程自己到点收工，全程可控。
func drainToDeadline(_ fd: Int32, deadline: Date) -> Data {
    let flags = fcntl(fd, F_GETFL, 0)
    if flags >= 0 { _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK) }

    var out = Data()
    let cap = 65536
    var buf = [UInt8](repeating: 0, count: cap)

    while true {
        let n = buf.withUnsafeMutableBytes { read(fd, $0.baseAddress, cap) }
        if n > 0 { out.append(contentsOf: buf[0..<n]); continue }
        if n == 0 { break }                                   // EOF：写端（含孙进程那份）全关了
        if errno == EINTR { continue }
        if errno != EAGAIN && errno != EWOULDBLOCK { break }   // 真错误，没有重试价值

        let remainMs = deadline.timeIntervalSinceNow * 1000
        if remainMs <= 0 { break }                             // 到点收工：数据可以不全，fd 必须归还
        var p = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
        _ = poll(&p, 1, Int32(min(remainMs, 250)))             // 上限 250ms 一轮，及时响应 deadline
    }
    return out
}

/// 同步跑一个命令，带**真实**超时。只在后台队列里调用。
///
/// 早前的实现有两个致命缺陷，第一轮代理审查实测出来的：
///
///   ① **超时形同虚设**：`readDataToEndOfFile()` 写在计时循环之前，而它的返回条件就是
///      「子进程关闭了 stdout」≈「子进程已退出」。实测 `timeout:1` 跑 `sleep 4` → 4.08s 才返回，
///      且返回成功。所以要先起一个等退出的 watchdog，再谈读数据。
///
///   ② **顺序读两个 pipe 会死锁**：先读干 stdout 再读 stderr，子进程若往 stderr 写满 64KB
///      而 stdout 一直不关，双方互等。实测 200KB stderr 的子进程 20s 未返回。两个 pipe
///      必须**并发**排空。
///
/// 叠加起来的后果比单独任一个都严重：那时全部后台工作跑在同一条串行队列上，一次阻塞
/// 就等于整个 app 永久瘫痪（`inFlight` 停在 true、后续任务永不执行、点什么都没反应）。
///
/// env 缺省 nil ⇒ 用 `childProcessEnvironment()`（登录 shell 的 PATH）。显式传值只有一个用途：
/// `LoginShellPath` 自己解析 PATH 时得传自身环境打破递归。
func runSync(_ launchPath: String, _ args: [String], cwd: String? = nil,
             timeout: TimeInterval = 10, drainGrace: TimeInterval = 3,
             env: [String: String]? = nil) -> RunResult? {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: launchPath)
    task.arguments = args
    task.environment = env ?? childProcessEnvironment()
    if let cwd { task.currentDirectoryURL = URL(fileURLWithPath: cwd) }

    let outPipe = Pipe(), errPipe = Pipe()
    task.standardOutput = outPipe
    task.standardError = errPipe

    // 两个 pipe 并发排空（缺陷 ②），且每个读线程都带 deadline（缺陷 ③b）。
    // deadline 取「runSync 自己可能存活的最长时间」：超出就收工，数据可以不全，fd 必须归还。
    // 注意**不能**指望「闭包结束 → Pipe 释放 → fd 归还」：Foundation 根本不这么做（见文件头
    // (a) 的实测），fd 只在下面那句显式 close 时才回来。
    let hardDeadline = Date().addingTimeInterval(timeout + drainGrace)
    let lock = NSLock()
    var outData = Data(), errData = Data()
    let readers = DispatchGroup()
    for (pipe, isOut) in [(outPipe, true), (errPipe, false)] {
        readers.enter()
        DispatchQueue.global(qos: .utility).async {
            let fh = pipe.fileHandleForReading
            let d = drainToDeadline(fh.fileDescriptor, deadline: hardDeadline)
            // ★ 读完自己关（缺陷 ③ 的正解）。Foundation **不会**在子进程退出后归还父进程侧的
            //   读端 fd —— 实测把 reader 线程整个去掉、函数也早已返回，每次调用照样净增 2 个 fd。
            //   「谁读完谁关」让时序天然正确：drainToDeadline 一返回就说明没人在读这个 fd 了，
            //   close 不会撞上另一线程正阻塞在 read() 上的未定义行为。
            try? fh.close()
            lock.lock()
            if isOut { outData = d } else { errData = d }
            lock.unlock()
            readers.leave()
        }
    }

    do {
        try task.run()
    } catch {
        // ★ 两个 reader 已经在上面起来了，且它们各自强持着自己的 Pipe。run() 抛错时没有子进程
        // 继承写端，父进程这一侧的 fileHandleForWriting 又随 Pipe 一直活着 —— 于是那两个
        // readDataToEndOfFile 永远等不到 EOF，两个线程就此永久阻塞，readers.leave() 也永不调用。
        // 触发路径很日常：env.node 指向 nvm 路径，版本目录在 refresh() 校验之后、这里 spawn
        // 之前被移除（nvm uninstall / 切版本）→ ENOENT。而 probe() 每 2~10s 重试一次，
        // 每次失败泄漏两个 .utility 线程，界面上只显示「找不到 node」。
        // 显式关掉写端即可让读端收到 EOF、线程正常退出。
        try? outPipe.fileHandleForWriting.close()
        try? errPipe.fileHandleForWriting.close()
        readers.wait()
        return nil
    }

    // 独立的退出 watchdog（缺陷 ①）：超时以「进程有没有退出」为准，与读数据解耦。
    let exited = DispatchSemaphore(value: 0)
    DispatchQueue.global(qos: .utility).async {
        task.waitUntilExit()
        exited.signal()
    }

    if exited.wait(timeout: .now() + timeout) == .timedOut {
        task.terminate()
        if exited.wait(timeout: .now() + 2) == .timedOut {
            kill(task.processIdentifier, SIGKILL)
            _ = exited.wait(timeout: .now() + 2) // 收尸，别留僵尸
        }
        _ = readers.wait(timeout: .now() + drainGrace)
        return nil
    }

    // 进程已退出 ⇒ 两个 pipe 都会很快 EOF；给个上限防极端情况（子进程把 fd 传给了孙进程）
    _ = readers.wait(timeout: .now() + drainGrace)
    lock.lock()
    let o = String(data: outData, encoding: .utf8) ?? ""
    let e = String(data: errData, encoding: .utf8) ?? ""
    lock.unlock()
    return RunResult(status: task.terminationStatus, stdout: o, stderr: e)
}

func firstLine(_ s: String) -> String {
    s.split(separator: "\n").first.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
}
