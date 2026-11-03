import Foundation
import Capacitor

/// Native side of the "ArclightPlayer" Capacitor plugin.
///
/// The contract (methods, options, results and events) is apps/player/src/native/definitions.ts;
/// method names here must stay in sync with it. This class only translates calls and events:
///  - audio:      AudioEngine (AVQueuePlayer, AVAudioSession, NowPlayingController)
///  - downloads:  DownloadManager (background URLSession)
///  - car:        CarPlayController (CarPlay templates; needs the CarPlay entitlement)
///  - cast:       CastController (AirPlay; Google Cast is not offered on iOS)
/// Those are app-wide singletons, so playback, downloads and CarPlay outlive a WebView reload.
@objc(ArclightPlayerPlugin)
public class ArclightPlayerPlugin: CAPPlugin, CAPBridgedPlugin, PlayerEventSink {
    public let identifier = "ArclightPlayerPlugin"
    public let jsName = "ArclightPlayer"
    public let pluginMethods: [CAPPluginMethod] = [
        // Info
        CAPPluginMethod(name: "getInfo", returnType: CAPPluginReturnPromise),
        // Audio
        CAPPluginMethod(name: "load", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setUpcoming", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seek", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "skipTo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setRate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setVolume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setRepeat", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setShuffle", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "configureRemote", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setNowPlayingExtra", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setSleepTimer", returnType: CAPPluginReturnPromise),
        // Downloads
        CAPPluginMethod(name: "enqueueDownload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pauseDownload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resumeDownload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelDownload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listDownloads", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteDownload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getStorageInfo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setDownloadPolicy", returnType: CAPPluginReturnPromise),
        // Car (CarPlay)
        CAPPluginMethod(name: "setBrowseTree", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "answerBrowse", returnType: CAPPluginReturnPromise),
        // Cast (AirPlay)
        CAPPluginMethod(name: "getCastState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "showRoutePicker", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "endCastSession", returnType: CAPPluginReturnPromise),
    ]

    override public func load() {
        PlayerEventHub.shared.attach(self)
        DownloadManager.shared.start()
        DispatchQueue.main.async {
            _ = AudioEngine.shared
            CastController.shared.start()
        }
    }

    // MARK: - PlayerEventSink

    func send(event: String, data: [String: Any], retain: Bool) {
        notifyListeners(event, data: data, retainUntilConsumed: retain)
    }

    func hasJSListeners(_ event: String) -> Bool {
        hasListeners(event)
    }

    // MARK: - Helpers

    /// Runs `body` on the main thread and resolves with its result (or rejects with its error).
    private func onMainThread(_ call: CAPPluginCall, _ body: @escaping () throws -> [String: Any]?) {
        DispatchQueue.main.async {
            self.run(call, body)
        }
    }

    /// Runs `body` on the calling (bridge) thread.
    private func run(_ call: CAPPluginCall, _ body: () throws -> [String: Any]?) {
        do {
            if let result = try body() {
                call.resolve(result)
            } else {
                call.resolve()
            }
        } catch let error as PlayerError {
            call.reject(error.message, error.code.rawValue)
        } catch {
            call.reject(error.localizedDescription, PlayerErrorCode.unknown.rawValue)
        }
    }

    private func options(_ call: CAPPluginCall) -> [AnyHashable: Any] {
        call.options ?? [:]
    }

    private func requireDouble(_ call: CAPPluginCall, _ key: String) throws -> Double {
        guard let v = call.getDouble(key), v.isFinite else {
            throw PlayerError(.invalid, "\(call.methodName): '\(key)' is required")
        }
        return v
    }

    private func requireString(_ call: CAPPluginCall, _ key: String) throws -> String {
        guard let v = call.getString(key), !v.isEmpty else {
            throw PlayerError(.invalid, "\(call.methodName): '\(key)' is required")
        }
        return v
    }

    // MARK: - Info

    @objc func getInfo(_ call: CAPPluginCall) {
        let version = (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "0"
        call.resolve([
            "platform": "ios",
            "version": "\(version) (AVFoundation)",
            "features": [
                "audio": true,
                "downloads": true,
                "car": CarPlayController.enabledInBuild,
                "cast": true,
                "sleepTimer": true,
            ],
        ])
    }

    // MARK: - Audio

    @objc func load(_ call: CAPPluginCall) {
        let opts = options(call)
        onMainThread(call) {
            let parsed = try JSONBridge.decode(LoadOptions.self, from: opts)
            try AudioEngine.shared.load(parsed)
            return nil
        }
    }

    @objc func setUpcoming(_ call: CAPPluginCall) {
        let opts = options(call)
        onMainThread(call) {
            let parsed = try JSONBridge.decode(UpcomingOptions.self, from: opts)
            AudioEngine.shared.setUpcoming(parsed.tracks)
            return nil
        }
    }

    @objc func play(_ call: CAPPluginCall) {
        onMainThread(call) {
            try AudioEngine.shared.play()
            return nil
        }
    }

    @objc func pause(_ call: CAPPluginCall) {
        onMainThread(call) {
            AudioEngine.shared.pause()
            return nil
        }
    }

    @objc func seek(_ call: CAPPluginCall) {
        onMainThread(call) {
            let ms = try self.requireDouble(call, "positionMs")
            AudioEngine.shared.seek(toMs: ms)
            return nil
        }
    }

    @objc func skipTo(_ call: CAPPluginCall) {
        onMainThread(call) {
            let index = Int(try self.requireDouble(call, "index"))
            let ms = call.getDouble("positionMs") ?? 0
            try AudioEngine.shared.skipTo(index: index, positionMs: ms)
            return nil
        }
    }

    @objc func setRate(_ call: CAPPluginCall) {
        onMainThread(call) {
            AudioEngine.shared.setRate(try self.requireDouble(call, "rate"))
            return nil
        }
    }

    @objc func setVolume(_ call: CAPPluginCall) {
        onMainThread(call) {
            AudioEngine.shared.setVolume(try self.requireDouble(call, "volume"))
            return nil
        }
    }

    @objc func setRepeat(_ call: CAPPluginCall) {
        onMainThread(call) {
            guard let mode = RepeatMode(rawValue: try self.requireString(call, "mode")) else {
                throw PlayerError(.invalid, "setRepeat: mode must be off, one or all")
            }
            AudioEngine.shared.setRepeat(mode)
            return nil
        }
    }

    /// JS owns the shuffle order and sends tracks already shuffled.
    @objc func setShuffle(_ call: CAPPluginCall) {
        call.resolve()
    }

    @objc func stop(_ call: CAPPluginCall) {
        onMainThread(call) {
            AudioEngine.shared.stop()
            return nil
        }
    }

    @objc func getState(_ call: CAPPluginCall) {
        onMainThread(call) {
            AudioEngine.shared.snapshot()
        }
    }

    @objc func configureRemote(_ call: CAPPluginCall) {
        onMainThread(call) {
            let mode = call.getString("mode") ?? "music"
            let config = RemoteConfig(
                audiobookMode: mode == "audiobook",
                skipBackMs: max(1000, call.getDouble("skipBackMs") ?? 30_000),
                skipForwardMs: max(1000, call.getDouble("skipForwardMs") ?? 30_000)
            )
            AudioEngine.shared.configureRemote(config)
            return nil
        }
    }

    @objc func setNowPlayingExtra(_ call: CAPPluginCall) {
        onMainThread(call) {
            AudioEngine.shared.setChapterTitle(call.getString("chapterTitle"))
            return nil
        }
    }

    @objc func setSleepTimer(_ call: CAPPluginCall) {
        onMainThread(call) {
            guard let timer = call.getObject("timer") else {
                AudioEngine.shared.setSleepTimer(nil)
                return nil
            }
            let kind = timer["kind"] as? String
            switch kind {
            case "minutes":
                guard let endsAt = (timer["endsAt"] as? NSNumber)?.doubleValue else {
                    throw PlayerError(.invalid, "setSleepTimer: endsAt is required")
                }
                let fade = (timer["fadeMs"] as? NSNumber)?.doubleValue ?? 0
                AudioEngine.shared.setSleepTimer(.minutes(endsAt: endsAt, fadeMs: max(0, fade)))
            case "endOfTrack":
                guard let trackId = timer["trackId"] as? String else {
                    throw PlayerError(.invalid, "setSleepTimer: trackId is required")
                }
                AudioEngine.shared.setSleepTimer(.endOfTrack(trackId: trackId))
            default:
                throw PlayerError(.invalid, "setSleepTimer: unknown kind")
            }
            return nil
        }
    }

    // MARK: - Downloads (run on the bridge thread; DownloadManager has its own queue)

    @objc func enqueueDownload(_ call: CAPPluginCall) {
        let opts = options(call)
        run(call) {
            let request = try JSONBridge.decode(DownloadRequest.self, from: opts)
            let task = try DownloadManager.shared.enqueue(request)
            return ["task": task]
        }
    }

    @objc func pauseDownload(_ call: CAPPluginCall) {
        run(call) {
            try DownloadManager.shared.pause(id: try self.requireString(call, "id"))
            return nil
        }
    }

    @objc func resumeDownload(_ call: CAPPluginCall) {
        run(call) {
            try DownloadManager.shared.resume(id: try self.requireString(call, "id"))
            return nil
        }
    }

    @objc func cancelDownload(_ call: CAPPluginCall) {
        run(call) {
            DownloadManager.shared.cancel(id: try self.requireString(call, "id"))
            return nil
        }
    }

    @objc func listDownloads(_ call: CAPPluginCall) {
        run(call) {
            ["tasks": DownloadManager.shared.list()]
        }
    }

    @objc func deleteDownload(_ call: CAPPluginCall) {
        run(call) {
            try DownloadManager.shared.delete(destName: try self.requireString(call, "destName"))
            return nil
        }
    }

    @objc func getStorageInfo(_ call: CAPPluginCall) {
        run(call) {
            DownloadManager.shared.storageInfo()
        }
    }

    @objc func setDownloadPolicy(_ call: CAPPluginCall) {
        run(call) {
            DownloadManager.shared.setPolicy(wifiOnly: call.getBool("wifiOnly") ?? false)
            return nil
        }
    }

    // MARK: - Car

    @objc func setBrowseTree(_ call: CAPPluginCall) {
        let opts = options(call)
        onMainThread(call) {
            let tree = try JSONBridge.decode(BrowseTree.self, from: opts)
            CarPlayController.shared.setTree(tree)
            return nil
        }
    }

    @objc func answerBrowse(_ call: CAPPluginCall) {
        let opts = options(call)
        onMainThread(call) {
            let answer = try JSONBridge.decode(AnswerBrowseOptions.self, from: opts)
            CarPlayController.shared.answer(requestId: answer.requestId, items: answer.items)
            return nil
        }
    }

    // MARK: - Cast (AirPlay)

    @objc func getCastState(_ call: CAPPluginCall) {
        onMainThread(call) {
            CastController.shared.state()
        }
    }

    @objc func showRoutePicker(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if CastController.shared.showPicker(in: self.bridge?.viewController?.view) {
                call.resolve()
            } else {
                call.unavailable("The AirPlay picker could not be opened.")
            }
        }
    }

    /// iOS has no API to end an AirPlay route from an app: open the picker so the user can pick
    /// this iPhone. Resolves at once when nothing is connected.
    @objc func endCastSession(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let connected = (CastController.shared.state()["status"] as? String) == "connected"
            if connected {
                _ = CastController.shared.showPicker(in: self.bridge?.viewController?.view)
            }
            call.resolve()
        }
    }
}
