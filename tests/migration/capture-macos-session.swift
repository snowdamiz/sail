import AppKit
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

struct CaptureRequest: Decodable {
    let processID: pid_t
    let output: String
}

struct CaptureResponse: Encodable {
    let width: Double
    let height: Double
    let pixelWidth: Int
    let pixelHeight: Int
    let frameMilliseconds: Double
    let pngMilliseconds: Double
}

struct CaptureFailure: LocalizedError {
    let errorDescription: String?
    init(_ reason: String) { errorDescription = reason }
}

@main
@MainActor
struct CaptureProbe {
    static func main() async throws {
        // ScreenCaptureKit needs a WindowServer connection even in a command-line process.
        _ = NSApplication.shared.setActivationPolicy(.prohibited)
        _ = NSScreen.screens
        guard CGPreflightScreenCaptureAccess() else {
            throw CaptureFailure("The host did not grant screen capture access to the probe")
        }
        fputs("ready\n", stdout)
        fflush(stdout)
        while let line = readLine() {
            let request = try JSONDecoder().decode(CaptureRequest.self, from: Data(line.utf8))
            let output = URL(fileURLWithPath: request.output)
            guard request.processID > 0, !FileManager.default.fileExists(atPath: output.path) else {
                throw CaptureFailure("Expected an owned process and a new capture path")
            }
            let sharing = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
            let windows = sharing.windows.filter {
                $0.windowLayer == 0 && $0.owningApplication?.processID == request.processID && $0.isOnScreen
            }
            guard windows.count == 1, let window = windows.first else {
                throw CaptureFailure("Expected one onscreen application window, found \(windows.count)")
            }
            let filter = SCContentFilter(desktopIndependentWindow: window)
            let geometry = filter.contentRect
            let scale = Double(filter.pointPixelScale)
            let config = SCStreamConfiguration()
            config.width = Int((geometry.width * scale).rounded())
            config.height = Int((geometry.height * scale).rounded())
            config.showsCursor = false
            config.ignoreShadowsSingleWindow = true
            config.includeChildWindows = false
            let started = ProcessInfo.processInfo.systemUptime
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            let captured = ProcessInfo.processInfo.systemUptime
            guard image.width == config.width, image.height == config.height,
                  let imageFile = CGImageDestinationCreateWithURL(output as CFURL, UTType.png.identifier as CFString, 1, nil) else {
                throw CaptureFailure("The captured image dimensions disagree with the selected window")
            }
            CGImageDestinationAddImage(imageFile, image, nil)
            guard CGImageDestinationFinalize(imageFile) else { throw CaptureFailure("Failed to encode PNG") }
            let response = CaptureResponse(
                width: geometry.width, height: geometry.height, pixelWidth: image.width, pixelHeight: image.height,
                frameMilliseconds: (captured - started) * 1000,
                pngMilliseconds: (ProcessInfo.processInfo.systemUptime - captured) * 1000
            )
            let bytes = try JSONEncoder().encode(response)
            print(String(decoding: bytes, as: UTF8.self))
            fflush(stdout)
        }
    }
}
