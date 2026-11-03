import Foundation

/// Where native parts send events for JS. The Capacitor plugin implements this.
protocol PlayerEventSink: AnyObject {
    func send(event: String, data: [String: Any], retain: Bool)
    func hasJSListeners(_ event: String) -> Bool
}

/// Routes events from the audio engine, downloads, CarPlay and AirPlay to the plugin.
///
/// The audio engine and the download manager are app-wide singletons: they outlive a WebView
/// reload and can run (CarPlay, background download events) before the plugin is loaded. Events
/// that must not be lost (`retain: true`: trackChanged, downloadCompleted, downloadFailed...)
/// are queued while no plugin is attached and delivered when one attaches; once attached,
/// Capacitor's own `retainUntilConsumed` holds them until JS adds a listener.
final class PlayerEventHub {
    static let shared = PlayerEventHub()

    private weak var sink: PlayerEventSink?
    private var pending: [(event: String, data: [String: Any])] = []
    private let maxPending = 500

    private init() {}

    func attach(_ sink: PlayerEventSink) {
        onMain {
            self.sink = sink
            let queued = self.pending
            self.pending.removeAll()
            for item in queued {
                sink.send(event: item.event, data: item.data, retain: true)
            }
        }
    }

    func emit(_ event: String, _ data: [String: Any], retain: Bool = false) {
        onMain {
            if let sink = self.sink {
                sink.send(event: event, data: data, retain: retain)
            } else if retain {
                self.pending.append((event, data))
                if self.pending.count > self.maxPending {
                    self.pending.removeFirst(self.pending.count - self.maxPending)
                }
            }
        }
    }

    /// True when a plugin is attached and JS listens for `event` (so a request can be answered).
    func hasListeners(_ event: String) -> Bool {
        guard let sink = sink else { return false }
        return sink.hasJSListeners(event)
    }
}

/// Runs `block` on the main thread (synchronously when already there).
func onMain(_ block: @escaping () -> Void) {
    if Thread.isMainThread {
        block()
    } else {
        DispatchQueue.main.async(execute: block)
    }
}

/// Milliseconds since 1970, as JS `Date.now()`.
func nowMs() -> Double {
    Date().timeIntervalSince1970 * 1000
}

/// Seconds (CMTime / TimeInterval) to integer milliseconds, 0 for NaN / infinity.
func toMs(_ seconds: Double) -> Int {
    guard seconds.isFinite, seconds > 0 else { return 0 }
    return Int((seconds * 1000).rounded())
}
