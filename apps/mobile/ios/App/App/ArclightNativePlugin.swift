import Capacitor
import Foundation
import WebKit

/// Lets the WebView show the user's own Arclight servers with the native shell available.
///
/// Arclight servers live at addresses the user types at runtime, so they cannot be listed in
/// `server.allowNavigation` at build time. This plugin:
///  1. keeps the saved servers' origins (handed over by the TS layer via `setServerOrigins`);
///  2. lets those origins load inside the WebView (`shouldOverrideLoad`); every other site still
///     opens in the system browser through Capacitor's default handling;
///  3. adds `public/arclight-shell.js` as a document-start user script. Capacitor's own bridge
///     scripts already run in every main-frame document on iOS; the shell script returns early
///     on the app's own origin and defines `window.Capacitor.Plugins.ArclightShell` elsewhere.
@objc(ArclightNativePlugin)
public class ArclightNativePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ArclightNativePlugin"
    public let jsName = "ArclightNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setServerOrigins", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getInfo", returnType: CAPPluginReturnPromise)
    ]

    private static let defaultsKey = "ArclightNative.serverOrigins"
    private let queue = DispatchQueue(label: "com.moviemethat.arclight.admin.origins")
    private var origins = Set<String>()

    override public func load() {
        let saved = UserDefaults.standard.stringArray(forKey: Self.defaultsKey) ?? []
        queue.sync { origins = Set(saved) }
        // load() runs before Capacitor adds this plugin's own JS header. Add the shell script on
        // the next main-loop turn so it runs after every plugin header in each document.
        DispatchQueue.main.async { [weak self] in self?.installShellScript() }
    }

    private func installShellScript() {
        guard let webView = bridge?.webView,
              let url = Bundle.main.url(forResource: "arclight-shell", withExtension: "js", subdirectory: "public"),
              let shell = try? String(contentsOf: url, encoding: .utf8) else {
            CAPLog.print("⚡️  ArclightNative: arclight-shell.js not found; server pages run without the shell")
            return
        }
        let localUrl = bridge?.config.localURL.absoluteString ?? "capacitor://localhost"
        let prefix = "window.__ARCLIGHT_NATIVE__ = { localUrl: \(Self.jsString(localUrl)) };\n"
        let script = WKUserScript(source: prefix + shell, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        webView.configuration.userContentController.addUserScript(script)
    }

    @objc func setServerOrigins(_ call: CAPPluginCall) {
        let list = call.getArray("origins", String.self) ?? []
        let next = Set(list.compactMap { Self.normalizedOrigin(URL(string: $0)) })
        queue.sync { origins = next }
        UserDefaults.standard.set(Array(next), forKey: Self.defaultsKey)
        call.resolve()
    }

    @objc func getInfo(_ call: CAPPluginCall) {
        #if DEBUG
        let environment = "sandbox"
        #else
        let environment = "production"
        #endif
        call.resolve([
            "pushAvailable": true,
            "localUrl": bridge?.config.localURL.absoluteString ?? "capacitor://localhost",
            "pushEnvironment": environment
        ])
    }

    override public func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        guard navigationAction.targetFrame?.isMainFrame == true,
              let origin = Self.normalizedOrigin(navigationAction.request.url) else { return nil }
        let allowed = queue.sync { origins.contains(origin) }
        // false = load in the WebView; nil = Capacitor decides (other sites open in Safari).
        return allowed ? NSNumber(value: false) : nil
    }

    /// scheme://host[:port], lower case, default ports dropped; nil for anything but http(s).
    static func normalizedOrigin(_ url: URL?) -> String? {
        guard let url = url, let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              var host = url.host?.lowercased() else { return nil }
        if host.contains(":") && !host.hasPrefix("[") { host = "[\(host)]" }
        var origin = "\(scheme)://\(host)"
        if let port = url.port, !(scheme == "http" && port == 80), !(scheme == "https" && port == 443) {
            origin += ":\(port)"
        }
        return origin
    }

    private static func jsString(_ value: String) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: [value])) ?? Data("[\"\"]".utf8)
        let array = String(data: data, encoding: .utf8) ?? "[\"\"]"
        return String(array.dropFirst().dropLast())
    }
}
