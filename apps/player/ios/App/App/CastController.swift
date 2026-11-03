import AVFoundation
import AVKit
import UIKit

/// AirPlay on iOS. Audio follows the system route on its own (AVPlayer.allowsExternalPlayback and
/// the long-form audio session), so this only reports the route as `castState` events and shows
/// the system route picker. Google Cast is not available on iOS builds (no official Swift
/// Package for the Google Cast SDK); `kind` is therefore always 'airplay' or null.
final class CastController: NSObject {
    static let shared = CastController()

    private let detector = AVRouteDetector()
    private var lastState: NSDictionary?
    private var picker: AVRoutePickerView?
    private var tokens: [NSObjectProtocol] = []
    private var started = false

    private override init() {
        super.init()
    }

    func start() {
        onMain {
            guard !self.started else { return }
            self.started = true
            let nc = NotificationCenter.default
            self.tokens.append(nc.addObserver(forName: .AVRouteDetectorMultipleRoutesDetectedDidChange, object: self.detector, queue: .main) { [weak self] _ in
                self?.refresh()
            })
            // Route detection costs power: only while the app is in the foreground.
            self.tokens.append(nc.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
                self?.detector.isRouteDetectionEnabled = true
                self?.refresh()
            })
            self.tokens.append(nc.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
                self?.detector.isRouteDetectionEnabled = false
            })
            self.detector.isRouteDetectionEnabled = UIApplication.shared.applicationState != .background
            self.refresh()
        }
    }

    func state() -> [String: Any] {
        let outputs = AVAudioSession.sharedInstance().currentRoute.outputs
        if let airplay = outputs.first(where: { $0.portType == .airPlay }) {
            return ["status": "connected", "kind": "airplay", "deviceName": airplay.portName]
        }
        if AudioEngine.shared.avPlayer.isExternalPlaybackActive {
            return ["status": "connected", "kind": "airplay"]
        }
        if detector.multipleRoutesDetected {
            return ["status": "available", "kind": "airplay"]
        }
        return ["status": "unavailable", "kind": NSNull()]
    }

    /// Emits `castState` when the route changed.
    func refresh() {
        onMain {
            let s = self.state()
            let dict = s as NSDictionary
            if let last = self.lastState, last.isEqual(dict) { return }
            self.lastState = dict
            PlayerEventHub.shared.emit("castState", s)
        }
    }

    /// Opens the system AirPlay picker. AVRoutePickerView has no "present" API, so a tiny picker
    /// view is placed in the app's view and its button is triggered. Returns false when that
    /// button cannot be found (an iOS release changed the view's internals).
    func showPicker(in host: UIView?) -> Bool {
        guard let host = host else { return false }
        let picker: AVRoutePickerView
        if let existing = self.picker, existing.superview === host {
            picker = existing
        } else {
            self.picker?.removeFromSuperview()
            picker = AVRoutePickerView(frame: CGRect(x: host.bounds.midX, y: host.bounds.maxY - 2, width: 1, height: 1))
            picker.alpha = 0.02
            picker.isAccessibilityElement = false
            picker.prioritizesVideoDevices = false
            host.addSubview(picker)
            self.picker = picker
        }
        guard let button = Self.findButton(in: picker) else { return false }
        button.sendActions(for: .touchUpInside)
        return true
    }

    private static func findButton(in view: UIView) -> UIButton? {
        for sub in view.subviews {
            if let button = sub as? UIButton { return button }
            if let nested = findButton(in: sub) { return nested }
        }
        return nil
    }
}
