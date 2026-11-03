import Foundation
import Capacitor

/// Native side of the "ArclightPlayer" Capacitor plugin.
///
/// The contract (methods, options, results and events) is apps/player/src/native/definitions.ts.
/// This is a stub: every method rejects with UNIMPLEMENTED, and the app then falls back to its
/// in-WebView HTMLAudioElement engine (no lock-screen controls, downloads, CarPlay or AirPlay
/// route picker).
///
/// The real implementation (AVQueuePlayer + MPNowPlayingInfoCenter / MPRemoteCommandCenter,
/// a background URLSession for downloads, CarPlay templates, AVRoutePickerView) replaces these
/// bodies; method names must stay in sync with definitions.ts.
@objc(ArclightPlayerPlugin)
public class ArclightPlayerPlugin: CAPPlugin, CAPBridgedPlugin {
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

    private func todo(_ call: CAPPluginCall) {
        call.unimplemented("ArclightPlayer.\(call.methodName) is not implemented on iOS yet.")
    }

    @objc func getInfo(_ call: CAPPluginCall) { todo(call) }

    @objc func load(_ call: CAPPluginCall) { todo(call) }
    @objc func setUpcoming(_ call: CAPPluginCall) { todo(call) }
    @objc func play(_ call: CAPPluginCall) { todo(call) }
    @objc func pause(_ call: CAPPluginCall) { todo(call) }
    @objc func seek(_ call: CAPPluginCall) { todo(call) }
    @objc func skipTo(_ call: CAPPluginCall) { todo(call) }
    @objc func setRate(_ call: CAPPluginCall) { todo(call) }
    @objc func setVolume(_ call: CAPPluginCall) { todo(call) }
    @objc func setRepeat(_ call: CAPPluginCall) { todo(call) }
    @objc func setShuffle(_ call: CAPPluginCall) { todo(call) }
    @objc func stop(_ call: CAPPluginCall) { todo(call) }
    @objc func getState(_ call: CAPPluginCall) { todo(call) }
    @objc func configureRemote(_ call: CAPPluginCall) { todo(call) }
    @objc func setNowPlayingExtra(_ call: CAPPluginCall) { todo(call) }
    @objc func setSleepTimer(_ call: CAPPluginCall) { todo(call) }

    @objc func enqueueDownload(_ call: CAPPluginCall) { todo(call) }
    @objc func pauseDownload(_ call: CAPPluginCall) { todo(call) }
    @objc func resumeDownload(_ call: CAPPluginCall) { todo(call) }
    @objc func cancelDownload(_ call: CAPPluginCall) { todo(call) }
    @objc func listDownloads(_ call: CAPPluginCall) { todo(call) }
    @objc func deleteDownload(_ call: CAPPluginCall) { todo(call) }
    @objc func getStorageInfo(_ call: CAPPluginCall) { todo(call) }
    @objc func setDownloadPolicy(_ call: CAPPluginCall) { todo(call) }

    @objc func setBrowseTree(_ call: CAPPluginCall) { todo(call) }
    @objc func answerBrowse(_ call: CAPPluginCall) { todo(call) }

    @objc func getCastState(_ call: CAPPluginCall) { todo(call) }
    @objc func showRoutePicker(_ call: CAPPluginCall) { todo(call) }
    @objc func endCastSession(_ call: CAPPluginCall) { todo(call) }
}
