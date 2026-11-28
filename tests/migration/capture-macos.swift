import ApplicationServices
import Foundation

func capture(processID: pid_t, output: URL) throws {
    let windows = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID
    ) as? [[String: Any]] ?? []
    let matches = windows.filter {
        ($0[kCGWindowOwnerPID as String] as? pid_t) == processID &&
        ($0[kCGWindowLayer as String] as? Int) == 0
    }
    guard matches.count == 1, let window = matches.first,
          let id = window[kCGWindowNumber as String] as? UInt32,
          let bounds = window[kCGWindowBounds as String] as? [String: Double],
          let width = bounds["Width"], let height = bounds["Height"] else {
        throw CaptureError("Expected one onscreen window for PID \(processID), found \(matches.count)")
    }
    guard !FileManager.default.fileExists(atPath: output.path) else {
        throw CaptureError("Capture already exists at \(output.path)")
    }

    let screenshot = Process()
    screenshot.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    screenshot.arguments = ["-l", String(id), "-o", "-x", output.path]
    try screenshot.run()
    screenshot.waitUntilExit()
    guard screenshot.terminationStatus == 0,
          let source = CGImageSourceCreateWithURL(output as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw CaptureError("Could not capture window \(id). Check Screen Recording permission.")
    }
    let profile = ["width": width, "height": height,
                   "pixelWidth": Double(image.width), "pixelHeight": Double(image.height)]
    print(String(decoding: try JSONSerialization.data(withJSONObject: profile), as: UTF8.self))
}

struct CaptureError: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}

do {
    let args = CommandLine.arguments
    guard args.count == 3, let pid = pid_t(args[1]), pid > 0 else {
        throw CaptureError("Usage: swift capture-macos.swift <Sail PID> <new PNG path>")
    }
    try capture(processID: pid, output: URL(fileURLWithPath: args[2]))
} catch {
    FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
    exit(1)
}
