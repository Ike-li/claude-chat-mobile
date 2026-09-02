// CCMProcess.swift —— 子进程调用层：spawn 一个命令、带真实超时地收集它的输出。
//
// 进不了 CCMCore（那层零 Process），也没法留在 ccm-menubar.swift（@main 与测试冲突）。
// 回归：testRunSyncResourceHygiene / testRunSyncTimeoutDoesNotLeakWorkers /
// testRunSyncDoesNotWaitUntilExitOffCaller。
//
// 收尸必须在调用方线程 waitpid + poll：waitUntilExit 丢到 GCD 会在进程已死后仍永远等。
// 两个 pipe 必须并发排空，超时不能建立在 readDataToEndOfFile 上。

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
    setNonblocking(fd)
    var out = Data()
    while true {
        if readAvailable(fd, into: &out) { break }
        let remainMs = deadline.timeIntervalSinceNow * 1000
        if remainMs <= 0 { break }
        var p = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
        _ = poll(&p, 1, Int32(min(remainMs, 250)))
    }
    return out
}

private func setNonblocking(_ fd: Int32) {
    let flags = fcntl(fd, F_GETFL, 0)
    if flags >= 0 { _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK) }
}

/// true = EOF 或不可恢复错误，这个 fd 不用再 poll；false = 暂时没数据。
private func readAvailable(_ fd: Int32, into out: inout Data) -> Bool {
    let cap = 65536
    var buf = [UInt8](repeating: 0, count: cap)
    while true {
        let n = buf.withUnsafeMutableBytes { read(fd, $0.baseAddress, cap) }
        if n > 0 { out.append(contentsOf: buf[0..<n]); continue }
        if n == 0 { return true }
        if errno == EINTR { continue }
        if errno == EAGAIN || errno == EWOULDBLOCK { return false }
        return true
    }
}

private func closePipeEnds(_ pipe: Pipe) {
    try? pipe.fileHandleForReading.close()
    try? pipe.fileHandleForWriting.close()
}

/// waitpid 的 status → 退出码。与 `Process.terminationStatus` 对齐：正常退出取低 8 位，
/// 被信号打死取信号编号（超时路径根本不返回 RunResult，用不到后一种）。
private func exitCode(fromWaitStatus status: Int32) -> Int32 {
    (status & 0x7f) == 0 ? (status >> 8) & 0xff : status & 0x7f
}

/// 同步跑一个命令，带**真实**超时。只在后台队列里调用。
///
/// 超时必须独立于「子进程关 stdout」：readDataToEndOfFile 在退出前不会返回。
/// 两个 pipe 必须并发排空，否则 stderr 写满 64KB 会与 stdout 互锁。
/// 收尸在调用方线程 waitpid + poll，不把 waitUntilExit 丢到 GCD（AppKit 退出通知走主线程）。
/// env 缺省用 childProcessEnvironment()；LoginShellPath 自解析时显式传自身环境打破递归。
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

    do {
        try task.run()
    } catch {
        // run() 失败没有子进程继承写端。父进程侧四端都还开着，不关就会把这两个
        // pipe 的 fd 留到 Process/Pipe 释放——而 Foundation 并不保证释放时归还读端。
        closePipeEnds(outPipe)
        closePipeEnds(errPipe)
        return nil
    }

    // 父进程不写 stdout/stderr。把写端关掉，子进程退出后读端才能 EOF。
    // 必须在 run() 成功之后：再早关，子进程继承到的就是已关闭的 fd。
    try? outPipe.fileHandleForWriting.close()
    try? errPipe.fileHandleForWriting.close()

    let outFd = outPipe.fileHandleForReading.fileDescriptor
    let errFd = errPipe.fileHandleForReading.fileDescriptor
    setNonblocking(outFd)
    setNonblocking(errFd)

    let pid = task.processIdentifier
    let timeoutAt = Date().addingTimeInterval(timeout)
    var sentTerm = false
    var sentKill = false
    var termAt: Date?
    var exitedAt: Date?
    var reaped: Int32?
    var outData = Data(), errData = Data()
    var outEOF = false, errEOF = false

    func tryReap() {
        guard reaped == nil, pid > 0 else { return }
        var st: Int32 = 0
        let r = waitpid(pid, &st, WNOHANG)
        if r == pid {
            reaped = st
            exitedAt = Date()
            return
        }
        if r < 0 && errno == ECHILD && !task.isRunning {
            // Foundation 抢先收了。terminationStatus 已经是退出码，不是 wait 的 raw status。
            reaped = task.terminationStatus << 8
            exitedAt = Date()
        }
    }

    while true {
        tryReap()
        if !outEOF { outEOF = readAvailable(outFd, into: &outData) }
        if !errEOF { errEOF = readAvailable(errFd, into: &errData) }

        if reaped != nil && outEOF && errEOF { break }

        let now = Date()
        if reaped == nil && pid > 0 && now >= timeoutAt {
            if !sentTerm {
                kill(pid, SIGTERM)
                sentTerm = true
                termAt = now.addingTimeInterval(2)
            } else if !sentKill, let termAt, now >= termAt {
                kill(pid, SIGKILL)
                sentKill = true
            }
        }

        // 孙进程继承写端时 EOF 永远不来：子进程已退后最多再排 drainGrace。
        if let exitedAt, now >= exitedAt.addingTimeInterval(drainGrace) { break }
        // SIGKILL 之后还收不到尸，停止空转（宁可漏一个僵尸，也不堵探测）。
        if sentKill, let termAt, now >= termAt.addingTimeInterval(2) { break }

        var fds = [
            pollfd(fd: outEOF ? -1 : outFd, events: Int16(POLLIN), revents: 0),
            pollfd(fd: errEOF ? -1 : errFd, events: Int16(POLLIN), revents: 0),
        ]
        _ = poll(&fds, nfds_t(fds.count), 50)
    }

    tryReap()
    try? outPipe.fileHandleForReading.close()
    try? errPipe.fileHandleForReading.close()

    if sentTerm { return nil }
    guard let reaped else { return nil }
    return RunResult(
        status: exitCode(fromWaitStatus: reaped),
        stdout: String(data: outData, encoding: .utf8) ?? "",
        stderr: String(data: errData, encoding: .utf8) ?? "")
}

func firstLine(_ s: String) -> String {
    s.split(separator: "\n").first.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
}
