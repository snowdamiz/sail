import AppKit
import ApplicationServices
import Carbon.HIToolbox
import ImageIO

let windowTitle = "Sail GPUI preview"
let projectName = "Release checklist"
let input = "sail"
let clock = ContinuousClock()

struct DriverError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

final class Evidence {
    let start = clock.now
    var pid: pid_t?
    var steps: [[String: Any]] = []
    var gaps: [String] = []

    func record(_ step: String, _ details: [String: Any] = [:]) {
        let elapsed = start.duration(to: clock.now).components
        var row = details
        row["step"] = step
        row["elapsed_ms"] = elapsed.seconds * 1_000 + elapsed.attoseconds / 1_000_000_000_000_000
        steps.append(row)
    }
}

func waitFor<T>(_ description: String, _ check: () throws -> T?) async throws -> T {
    let deadline = clock.now + .seconds(6)
    repeat {
        if let value = try check() { return value }
        try await clock.sleep(for: .milliseconds(50))
    } while clock.now < deadline
    throw DriverError("Timed out waiting for \(description)")
}

func axRead(_ node: AXUIElement, _ attribute: String) -> (AXError, CFTypeRef?) {
    var value: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(node, attribute as CFString, &value)
    return (status, value)
}

func ax<T>(_ node: AXUIElement, _ attribute: String) -> T? {
    let (status, value) = axRead(node, attribute)
    return status == .success ? value as? T : nil
}

func requireAX(_ status: AXError, _ action: String) throws {
    guard status == .success else { throw DriverError("\(action) failed (AX error \(status.rawValue))") }
}

func descendants(_ root: AXUIElement) -> [AXUIElement] {
    var nodes = [root]
    var index = 0
    while index < nodes.count && nodes.count < 1_000 {
        let children: [AXUIElement] = ax(nodes[index], kAXChildrenAttribute) ?? []
        nodes.append(contentsOf: children.prefix(1_000 - nodes.count))
        index += 1
    }
    return nodes
}

func name(_ element: AXUIElement) -> String {
    let title: String = ax(element, kAXTitleAttribute) ?? ""
    return title.isEmpty ? ax(element, kAXDescriptionAttribute) ?? "" : title
}

func focused(_ element: AXUIElement) -> Bool {
    ax(element, kAXFocusedAttribute) ?? false
}

func validateExecutable(_ path: String) throws -> URL {
    let executable = URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL
    guard executable.lastPathComponent == "sail-client",
          (try? executable.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true,
          FileManager.default.isExecutableFile(atPath: executable.path) else {
        throw DriverError("Expected an executable sail-client file, got \(path)")
    }
    return executable
}

func reserveOutput(_ out: URL) throws {
    let files = FileManager.default
    try files.createDirectory(at: out.deletingLastPathComponent(), withIntermediateDirectories: true)
    do {
        try files.createDirectory(at: out, withIntermediateDirectories: false)
    } catch CocoaError.fileWriteFileExists {
        throw DriverError("Output directory must be new: \(out.path)")
    }
}

func launchFixture(_ executable: URL) throws -> Process {
    let process = Process()
    process.executableURL = executable
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    return process
}

func stopFixture(_ process: Process) {
    if process.isRunning {
        process.terminate()
        process.waitUntilExit()
    }
}

func requireCleanExit(_ process: Process, _ evidence: Evidence) async throws {
    let _: Bool = try await waitFor("the original sail-client process to exit") {
        process.isRunning ? nil : true
    }
    process.waitUntilExit()
    let pid = process.processIdentifier
    let code = process.terminationStatus
    guard process.terminationReason == .exit else {
        evidence.record("process_exited", ["pid": pid, "signal": code])
        throw DriverError("Original sail-client terminated by signal \(code)")
    }
    evidence.record("process_exited", ["pid": pid, "exit_code": code])
    guard code == 0 else {
        throw DriverError("Original sail-client exited with status \(code)")
    }
}

func application(_ process: Process, _ executable: URL) async throws -> NSRunningApplication {
    let pid = process.processIdentifier
    return try await waitFor("sail-client application for PID \(pid)") {
        guard process.isRunning else {
            throw DriverError("sail-client PID \(pid) exited (status \(process.terminationStatus))")
        }
        guard let running = NSRunningApplication(processIdentifier: pid),
              !running.isTerminated, let url = running.executableURL else { return nil }
        let actual = url.resolvingSymlinksInPath().standardizedFileURL
        guard actual.path == executable.path else {
            throw DriverError("PID \(pid) is running \(actual.path), expected \(executable.path)")
        }
        return running
    }
}

func fixtureWindow(_ running: NSRunningApplication) async throws -> AXUIElement {
    let app = AXUIElementCreateApplication(running.processIdentifier)
    try requireAX(AXUIElementSetMessagingTimeout(app, 0.5), "Set AX timeout")
    return try await waitFor("one AX window named \(windowTitle)") {
        guard !running.isTerminated else { throw DriverError("sail-client exited before its AX window appeared") }
        let windows: [AXUIElement] = ax(app, kAXWindowsAttribute) ?? []
        let matches = windows.filter { name($0) == windowTitle }
        guard matches.count <= 1 else { throw DriverError("Multiple fixture AX windows") }
        return matches.first
    }
}

func fixtureControls(_ window: AXUIElement) async throws -> (AXUIElement, AXUIElement) {
    try await waitFor("a focused project button and Message text field") {
        let nodes = descendants(window)
        let composers = nodes.filter {
            ax($0, kAXRoleAttribute) == (kAXTextFieldRole as String) && name($0) == "Message"
        }
        guard composers.count <= 1 else { throw DriverError("Multiple AX text fields named Message") }
        guard let composer = composers.first,
              let project = nodes.first(where: {
                  ax($0, kAXRoleAttribute) == (kAXButtonRole as String) && name($0) == projectName && focused($0)
              }) else { return nil }
        return (project, composer)
    }
}

func sendKey(
    _ code: Int, to running: NSRunningApplication, flags: CGEventFlags = [], character: UInt16? = nil
) throws {
    guard !running.isTerminated, running.isActive else {
        throw DriverError("The verified sail-client PID must own keyboard focus")
    }
    for down in [true, false] {
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(code), keyDown: down) else {
            throw DriverError("Could not create keyboard event")
        }
        event.flags = flags
        if var unit = character {
            event.keyboardSetUnicodeString(stringLength: 1, unicodeString: &unit)
        }
        event.postToPid(running.processIdentifier)
    }
}

func capture(_ file: String, _ running: NSRunningApplication, _ out: URL, _ evidence: Evidence) throws {
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]] ?? []
    let matches = windows.filter {
        ($0[kCGWindowOwnerPID as String] as? pid_t) == running.processIdentifier &&
        ($0[kCGWindowLayer as String] as? Int) == 0
    }
    guard matches.count == 1, let id = matches.first?[kCGWindowNumber as String] as? UInt32,
          !running.isTerminated else {
        throw DriverError("Expected one on-screen fixture window, found \(matches.count)")
    }
    let path = out.appendingPathComponent(file)
    let capture = Process()
    capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    capture.arguments = ["-l", String(id), "-o", "-x", path.path]
    try capture.run()
    capture.waitUntilExit()
    guard capture.terminationStatus == 0,
          let source = CGImageSourceCreateWithURL(path as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw DriverError("Could not capture the fixture window at \(file)")
    }
    evidence.record("screenshot", [
        "file": file, "window_id": id, "width": image.width, "height": image.height,
    ])
}

func selection(_ composer: AXUIElement) -> String? {
    if let text: String = ax(composer, kAXSelectedTextAttribute) { return text }
    guard let range: AXValue = ax(composer, kAXSelectedTextRangeAttribute),
          let text: String = ax(composer, kAXValueAttribute) else { return nil }
    var bounds = CFRange()
    guard AXValueGetValue(range, .cfRange, &bounds),
          let substring = Range(NSRange(location: bounds.location, length: bounds.length), in: text) else { return nil }
    return String(text[substring])
}

func verifyText(
    _ description: String, _ expected: String, _ read: () -> String?, _ evidence: Evidence
) async throws -> Bool {
    var lastValue: String?
    do {
        let observed: String = try await waitFor(description) {
            guard let actual = read() else { return nil }
            lastValue = actual
            return actual == expected ? actual : nil
        }
        evidence.record(description, ["expected": expected, "observed": observed])
        return true
    } catch {
        if let lastValue {
            evidence.record(description, ["expected": expected, "observed": lastValue])
            throw DriverError("Expected \(description) \(expected.debugDescription), got \(lastValue.debugDescription)")
        }
        evidence.record(description, ["expected": expected, "observed": NSNull()])
        return false
    }
}

func verify(_ executable: URL, _ out: URL, _ reopen: Bool, _ evidence: Evidence) async throws {
    guard AXIsProcessTrusted() else {
        throw DriverError("The invoking process needs macOS Accessibility access")
    }
    guard CGPreflightScreenCaptureAccess() else {
        throw DriverError("The invoking process needs macOS Screen Recording access")
    }

    let process = try launchFixture(executable)
    defer { stopFixture(process) }
    let pid = process.processIdentifier
    evidence.pid = pid
    evidence.record("process_launched", ["pid": pid])
    let running = try await application(process, executable)
    let window = try await fixtureWindow(running)
    try await verifyWindow(window, running, out, evidence)

    guard process.isRunning, let close: AXUIElement = ax(window, kAXCloseButtonAttribute) else {
        throw DriverError("Could not find the fixture AX close button")
    }
    try requireAX(AXUIElementPerformAction(close, kAXPressAction as CFString), "Press fixture close button")
    evidence.record("window_close", ["pid": pid, "action": kAXPressAction])
    try await requireCleanExit(process, evidence)

    if reopen {
        let relaunched = try launchFixture(executable)
        defer { stopFixture(relaunched) }
        let newPid = relaunched.processIdentifier
        evidence.record("process_relaunched", ["pid": newPid])
        let restarted = try await application(relaunched, executable)
        let reopenedWindow = try await fixtureWindow(restarted)
        let (_, reopenedComposer) = try await fixtureControls(reopenedWindow)
        evidence.record("window_reopened", ["pid": newPid, "title": windowTitle, "composer": name(reopenedComposer)])
        try capture("gpui-reopen.png", restarted, out, evidence)
    }
}

func verifyWindow(
    _ window: AXUIElement, _ running: NSRunningApplication, _ out: URL, _ evidence: Evidence
) async throws {
    if !running.isActive {
        let app = AXUIElementCreateApplication(running.processIdentifier)
        try requireAX(AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue), "Activate fixture application")
        try requireAX(AXUIElementPerformAction(window, kAXRaiseAction as CFString), "Raise fixture window")
        let _: Bool = try await waitFor("fixture application to become active") { running.isActive ? true : nil }
    }
    let (project, composer) = try await fixtureControls(window)
    evidence.record("initial_focus", ["role": kAXButtonRole, "name": name(project)])
    evidence.record("composer", ["role": kAXTextFieldRole, "name": name(composer)])
    let initialValue: String = ax(composer, kAXValueAttribute) ?? ""
    guard initialValue.isEmpty else { throw DriverError("Expected a fresh composer with an empty value") }
    try capture("gpui-native.png", running, out, evidence)

    try sendKey(kVK_Tab, to: running)
    evidence.record("keyboard", ["key": "Tab"])
    let _: Bool = try await waitFor("Tab to focus Message") { focused(composer) ? true : nil }
    evidence.record("tab_focus", ["name": name(composer)])
    for (code, character) in zip([kVK_ANSI_S, kVK_ANSI_A, kVK_ANSI_I, kVK_ANSI_L], input.utf16) {
        try sendKey(code, to: running, character: character)
    }
    evidence.record("keyboard", ["text": input])
    let verifiedValue = try await verifyText("value", input, { ax(composer, kAXValueAttribute) }, evidence)
    if !verifiedValue { evidence.gaps.append("AX did not expose the composer value") }
    for _ in input {
        try sendKey(kVK_LeftArrow, to: running, flags: .maskShift)
    }
    evidence.record("keyboard", ["key": "Shift+Left", "repeat": input.count])
    var textAttributes: CFArray?
    try requireAX(AXUIElementCopyAttributeNames(composer, &textAttributes), "Read composer AX attributes")
    let attributes = textAttributes as? [String] ?? []
    let exposesSelection = attributes.contains(kAXSelectedTextAttribute) || attributes.contains(kAXSelectedTextRangeAttribute)
    let verifiedSelection = exposesSelection
        ? try await verifyText("selection", input, { selection(composer) }, evidence)
        : false
    try capture("gpui-input.png", running, out, evidence)
    if !verifiedSelection && verifiedValue {
        // A replacement of the entire draft confirms the keyboard selected all four characters.
        try sendKey(kVK_ANSI_X, to: running, character: 120)
        evidence.record("keyboard", ["text": "x"])
        let replaced = try await verifyText("selection_replacement", "x", { ax(composer, kAXValueAttribute) }, evidence)
        if !replaced { evidence.gaps.append("AX did not expose the value after replacing the selection") }
    } else if !verifiedSelection {
        evidence.gaps.append("AX did not expose the composer selection")
    }

    try sendKey(kVK_Tab, to: running, flags: .maskShift)
    evidence.record("keyboard", ["key": "Shift+Tab"])
    let _: Bool = try await waitFor("Shift+Tab to restore project focus") { focused(project) ? true : nil }
    try requireAX(AXUIElementSetAttributeValue(composer, kAXFocusedAttribute as CFString, kCFBooleanTrue), "Focus Message through AX")
    let _: Bool = try await waitFor("AX focus on Message") { focused(composer) ? true : nil }
    evidence.record("accessibility_focus", ["action": kAXFocusedAttribute, "name": name(composer)])
    try capture("gpui-a11y.png", running, out, evidence)
}

let usage = "Usage: swift native-macos.swift EXECUTABLE OUTPUT_DIR [--close-reopen]"
let arguments = Array(CommandLine.arguments.dropFirst())
if arguments == ["--help"] {
    print(usage)
    exit(0)
}
guard arguments.count == 2 || (arguments.count == 3 && arguments[2] == "--close-reopen") else {
    fputs("\(usage)\n", stderr)
    exit(2)
}
let out = URL(fileURLWithPath: arguments[1], isDirectory: true)
let executable: URL
do {
    executable = try validateExecutable(arguments[0])
    try reserveOutput(out)
} catch {
    fputs("\(error.localizedDescription)\n", stderr)
    exit(1)
}
let evidence = Evidence()
var result: [String: Any] = [
    "schema_version": 1, "platform": "macos", "accessibility": "AX",
    "executable": executable.path, "title": windowTitle, "status": "pass",
]
var exitCode: Int32 = 0
do {
    try await verify(executable, out, arguments.count == 3, evidence)
    if !evidence.gaps.isEmpty {
        result["status"] = "partial"
        exitCode = 2
    }
} catch {
    result["status"] = "fail"
    result["error"] = error.localizedDescription
    fputs("\(error.localizedDescription)\n", stderr)
    exitCode = 1
}
result["pid"] = evidence.pid as Any? ?? NSNull()
result["steps"] = evidence.steps
result["gaps"] = evidence.gaps
do {
    let json = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
    try json.write(to: out.appendingPathComponent("native-evidence.json"), options: .atomic)
} catch {
    fputs("Could not write evidence: \(error.localizedDescription)\n", stderr)
    exitCode = 1
}
exit(exitCode)
