import Capacitor
import Foundation
import Security
import WebKit

/// Lets the WebView show the user's own Arclight servers with a limited native shell.
///
/// Arclight servers live at addresses the user types at runtime, so they cannot be listed in
/// `server.allowNavigation` at build time. This plugin:
///  1. keeps the saved servers' origins (handed over by the app's own screens via
///     `setServerOrigins`; only origins that passed the cleartext policy are listed);
///  2. lets those origins load inside the WebView (`shouldOverrideLoad`); every other site still
///     opens in the system browser through Capacitor's default handling;
///  3. adds `public/arclight-shell.js` as a document-start user script. Capacitor's own bridge
///     scripts already run in every main-frame document on iOS; the shell script returns early
///     on the app's own origin and defines `window.Capacitor.Plugins.ArclightShell` elsewhere;
///  4. puts a gate in front of Capacitor's "bridge" message handler (CLI-01): the app's own
///     origin gets the full bridge; a saved server's page (main frame only) gets only the calls
///     in `BridgeGate.allowServerPage`; anything else is refused. ArclightNative calls remember
///     the calling origin, so a server page only ever reaches its own secure-store scope.
@objc(ArclightNativePlugin)
public class ArclightNativePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ArclightNativePlugin"
    public let jsName = "ArclightNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setServerOrigins", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getInfo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "shellState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secureGet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secureSet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secureRemove", returnType: CAPPluginReturnPromise)
    ]

    private static let defaultsKey = "ArclightNative.serverOrigins"
    private static let shellKey = "ArclightNative.shellState"
    private static let relayKey = "ArclightNative.relayOrigin"
    private let queue = DispatchQueue(label: "com.moviemethat.arclight.admin.origins")
    private var origins = Set<String>()
    private var shells: [String: Any] = [:]
    private var relayOrigin: String?
    private var gate: BridgeGate?

    override public func load() {
        let saved = UserDefaults.standard.stringArray(forKey: Self.defaultsKey) ?? []
        let savedShells = UserDefaults.standard.data(forKey: Self.shellKey)
            .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        let savedRelay = UserDefaults.standard.string(forKey: Self.relayKey)
        queue.sync {
            origins = Set(saved)
            shells = savedShells
            relayOrigin = savedRelay
        }
        // Before the first page can post a message (load() runs on the main thread while the
        // bridge view controller sets up, before the WebView loads anything).
        installGate()
        // load() runs before Capacitor adds this plugin's own JS header. Add the shell script on
        // the next main-loop turn so it runs after every plugin header in each document.
        DispatchQueue.main.async { [weak self] in self?.installShellScript() }
    }

    private func installGate() {
        guard let bridge = bridge as? CapacitorBridge else {
            CAPLog.print("⚡️  ArclightNative: no Capacitor bridge; server pages get no native shell")
            return
        }
        let handler = bridge.webViewDelegationHandler
        let localOrigin = Self.normalizedOrigin(bridge.config.localURL) ?? "capacitor://localhost"
        let gate = BridgeGate(
            handler: handler,
            localOrigin: localOrigin,
            isServer: { [weak self] origin in
                guard let self = self else { return false }
                return self.queue.sync { self.origins.contains(origin) }
            },
            relayOrigin: { [weak self] in
                guard let self = self else { return nil }
                return self.queue.sync { self.relayOrigin }
            },
            webView: { [weak bridge] in bridge?.webView }
        )
        let controller = handler.contentController
        controller.removeScriptMessageHandler(forName: "bridge")
        controller.add(gate, name: "bridge")
        self.gate = gate
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

    /// "" for the app's own screens, the server page's origin, or nil when unknown (refuse).
    private func caller(_ call: CAPPluginCall) -> String? {
        return gate?.takeCaller(call.callbackId)
    }

    @objc func setServerOrigins(_ call: CAPPluginCall) {
        guard caller(call) == "" else { return call.reject("Not available to server pages") }
        let list = call.getArray("origins", String.self) ?? []
        let next = Set(list.compactMap { Self.normalizedOrigin(URL(string: $0)) }.filter { !$0.hasPrefix("capacitor:") })
        var nextShells: [String: Any] = [:]
        for (key, value) in call.getObject("shell") ?? [:] {
            if let origin = Self.normalizedOrigin(URL(string: key)), next.contains(origin), let snap = value as? [String: Any],
               JSONSerialization.isValidJSONObject(snap) {
                nextShells[origin] = snap
            }
        }
        var relay = call.getString("relayUrl").flatMap { Self.normalizedOrigin(URL(string: $0)) }
        if let r = relay, !r.hasPrefix("https://") { relay = nil }
        queue.sync {
            origins = next
            shells = nextShells
            if let relay = relay { relayOrigin = relay }
        }
        UserDefaults.standard.set(Array(next), forKey: Self.defaultsKey)
        // As JSON: snapshots can hold nulls, which UserDefaults cannot store.
        UserDefaults.standard.set(try? JSONSerialization.data(withJSONObject: nextShells), forKey: Self.shellKey)
        if let relay = relay { UserDefaults.standard.set(relay, forKey: Self.relayKey) }
        call.resolve()
    }

    @objc func shellState(_ call: CAPPluginCall) {
        guard let origin = caller(call) else { return call.reject("Unknown caller") }
        let snap: Any? = origin.isEmpty ? nil : queue.sync { shells[origin] }
        call.resolve(["state": snap ?? NSNull()])
    }

    /// A server page always gets its own origin's scope, whatever it asks for.
    private func scope(_ call: CAPPluginCall) -> String? {
        guard let origin = caller(call) else { return nil }
        return origin.isEmpty ? (call.getString("scope") ?? "") : origin
    }

    @objc func secureGet(_ call: CAPPluginCall) {
        guard let scope = scope(call) else { return call.reject("Unknown caller") }
        guard let key = call.getString("key") else { return call.reject("key is required") }
        call.resolve(["value": Keychain.get(scope: scope, key: key) ?? NSNull()])
    }

    @objc func secureSet(_ call: CAPPluginCall) {
        guard let scope = scope(call) else { return call.reject("Unknown caller") }
        guard let key = call.getString("key"), let value = call.getString("value") else { return call.reject("key and value are required") }
        if Keychain.set(scope: scope, key: key, value: value) { call.resolve() } else { call.reject("Could not store the value securely") }
    }

    @objc func secureRemove(_ call: CAPPluginCall) {
        guard let scope = scope(call) else { return call.reject("Unknown caller") }
        guard let key = call.getString("key") else { return call.reject("key is required") }
        Keychain.remove(scope: scope, key: key)
        call.resolve()
    }

    @objc func getInfo(_ call: CAPPluginCall) {
        _ = caller(call) // drop the record
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

    /// scheme://host[:port], lower case, default ports dropped; nil for anything but http(s)
    /// (and the app's own capacitor:// origin).
    static func normalizedOrigin(_ url: URL?) -> String? {
        guard let url = url, let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" || scheme == "capacitor",
              var host = url.host?.lowercased(), url.user == nil else { return nil }
        if host.contains(":") && !host.hasPrefix("[") { host = "[\(host)]" }
        var origin = "\(scheme)://\(host)"
        if let port = url.port, !(scheme == "http" && port == 80), !(scheme == "https" && port == 443) {
            origin += ":\(port)"
        }
        return origin
    }

    static func jsString(_ value: String) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: [value])) ?? Data("[\"\"]".utf8)
        let array = String(data: data, encoding: .utf8) ?? "[\"\"]"
        return String(array.dropFirst().dropLast())
    }
}

/// Sits in front of Capacitor's "bridge" script message handler (CLI-01). Same list as
/// android/.../BridgePolicy.java: keep the two in step.
final class BridgeGate: NSObject, WKScriptMessageHandler {
    private weak var handler: WebViewDelegationHandler?
    private let localOrigin: String
    private let isServer: (String) -> Bool
    private let relayOrigin: () -> String?
    private let webView: () -> WKWebView?
    private let lock = NSLock()
    private var callers: [String: String] = [:]

    private static let allowed: [String: [String: Set<String>?]] = [
        "ArclightNative": ["getInfo": nil, "shellState": nil, "secureGet": nil, "secureSet": nil, "secureRemove": nil],
        "App": ["getInfo": nil, "getLaunchUrl": nil, "removeListener": nil, "removeAllListeners": nil, "addListener": ["appUrlOpen", "appStateChange"]],
        // Not pushNotificationReceived: a foreground server page has no use for other servers' payloads.
        "PushNotifications": ["checkPermissions": nil, "requestPermissions": nil, "register": nil, "removeListener": nil, "removeAllListeners": nil,
                              "addListener": ["registration", "registrationError", "pushNotificationActionPerformed"]],
        "Device": ["getInfo": nil],
        "Browser": ["open": nil],
        "NativeBiometric": ["isAvailable": nil, "verifyIdentity": nil],
        "CapacitorShareTarget": ["removeListener": nil, "removeAllListeners": nil, "addListener": ["shareReceived"]],
        "CapacitorHttp": ["request": nil],
        "Console": ["log": nil]
    ]

    init(handler: WebViewDelegationHandler, localOrigin: String, isServer: @escaping (String) -> Bool, relayOrigin: @escaping () -> String?, webView: @escaping () -> WKWebView?) {
        self.handler = handler
        self.localOrigin = localOrigin
        self.isServer = isServer
        self.relayOrigin = relayOrigin
        self.webView = webView
    }

    /// The origin recorded for an ArclightNative call ("" = the app's own screens), once.
    func takeCaller(_ callbackId: String) -> String? {
        lock.lock()
        defer { lock.unlock() }
        return callers.removeValue(forKey: callbackId)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let handler = handler else { return }
        let so = message.frameInfo.securityOrigin
        var components = URLComponents()
        components.scheme = so.protocol
        components.host = so.host
        if so.port != 0 { components.port = so.port }
        guard let source = ArclightNativePlugin.normalizedOrigin(components.url) else { return }
        let dict = message.body as? [String: Any] ?? [:]
        let type = dict["type"] as? String ?? ""
        let pluginId = dict["pluginId"] as? String ?? ""
        let method = dict["methodName"] as? String ?? ""
        let callbackId = dict["callbackId"] as? String ?? ""

        let caller: String
        if source == localOrigin {
            caller = ""
        } else if isServer(source) {
            caller = source
            let options = dict["options"] as? [String: Any] ?? [:]
            if !(type == "js.error" || (type == "message" && allowServerPage(pluginId: pluginId, method: method, options: options))) {
                CAPLog.print("⚡️  ArclightNative: refused \(pluginId).\(method) from a server page")
                if type == "message" && !callbackId.isEmpty { reject(callbackId: callbackId, pluginId: pluginId, method: method) }
                return
            }
        } else {
            return
        }
        if type == "message" && pluginId == "ArclightNative" {
            lock.lock()
            callers[callbackId] = caller
            lock.unlock()
        }
        handler.userContentController(userContentController, didReceive: message)
    }

    private func allowServerPage(pluginId: String, method: String, options: [String: Any]) -> Bool {
        guard let methods = Self.allowed[pluginId], let entry = methods[method] else { return false }
        if method == "addListener" {
            guard let events = entry, let event = options["eventName"] as? String else { return false }
            return events.contains(event)
        }
        if pluginId == "Browser" {
            return ArclightNativePlugin.normalizedOrigin(URL(string: options["url"] as? String ?? "")).map { !$0.hasPrefix("capacitor:") } ?? false
        }
        if pluginId == "CapacitorHttp" {
            return Self.isRelayDeviceCall(url: options["url"] as? String, method: options["method"] as? String, relayOrigin: relayOrigin())
        }
        return true
    }

    /// POST/PUT/DELETE {relay}/v1/devices[/id] over https.
    static func isRelayDeviceCall(url: String?, method: String?, relayOrigin: String?) -> Bool {
        guard let relayOrigin = relayOrigin, let raw = url, let m = method?.uppercased(), ["POST", "PUT", "DELETE"].contains(m),
              let comps = URLComponents(string: raw), comps.query == nil, comps.fragment == nil,
              let origin = ArclightNativePlugin.normalizedOrigin(comps.url), origin.hasPrefix("https://"), origin == relayOrigin else { return false }
        let path = comps.percentEncodedPath
        if path == "/v1/devices" { return true }
        guard path.hasPrefix("/v1/devices/") else { return false }
        let id = path.dropFirst("/v1/devices/".count)
        let ok = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._~-")
        return !id.isEmpty && id != "." && id != ".." && id.unicodeScalars.allSatisfy { ok.contains($0) }
    }

    private func reject(callbackId: String, pluginId: String, method: String) {
        let payload: [String: Any] = [
            "callbackId": callbackId, "pluginId": pluginId, "methodName": method, "success": false,
            "error": ["message": "Not available to server pages", "code": "UNAVAILABLE"]
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload), let json = String(data: data, encoding: .utf8) else { return }
        DispatchQueue.main.async { [weak self] in
            self?.webView()?.evaluateJavaScript("window.Capacitor && window.Capacitor.fromNative(\(json))", completionHandler: nil)
        }
    }
}

/// Keychain items scoped by server origin. Device-only, readable after the first unlock (push
/// token refreshes can arrive in the background), never synced or restored to another device.
enum Keychain {
    private static let service = "com.moviemethat.arclight.admin.secure"

    private static func base(_ scope: String, _ key: String) -> [String: Any] {
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "\(scope)\n\(key)"
        ]
    }

    static func get(scope: String, key: String) -> String? {
        var query = base(scope, key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    static func set(scope: String, key: String, value: String) -> Bool {
        let data = Data(value.utf8)
        let attrs: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        let status = SecItemUpdate(base(scope, key) as CFDictionary, attrs as CFDictionary)
        if status == errSecSuccess { return true }
        guard status == errSecItemNotFound else { return false }
        var add = base(scope, key)
        add.merge(attrs) { $1 }
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    static func remove(scope: String, key: String) {
        SecItemDelete(base(scope, key) as CFDictionary)
    }
}
