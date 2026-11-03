import AVFoundation
import MediaPlayer
import UIKit

/// An AVPlayerItem that remembers which entry of the native queue it plays.
final class QueueItem: AVPlayerItem {
    let trackIndex: Int
    let trackId: String

    init(asset: AVURLAsset, trackIndex: Int, trackId: String) {
        self.trackIndex = trackIndex
        self.trackId = trackId
        super.init(asset: asset, automaticallyLoadedAssetKeys: ["duration", "playable"])
    }
}

/// Native audio: AVQueuePlayer holding the current track plus the next one (so AVFoundation
/// prerolls it and the change is gapless), the AVAudioSession, the lock screen and remote
/// commands, and the optional native sleep timer.
///
/// JS owns the play queue; this keeps the slice it was given (`load` + `setUpcoming`) and plays
/// through it on its own while the WebView is suspended. All state lives on the main thread.
final class AudioEngine: NSObject, RemoteActionHandler {
    static let shared = AudioEngine()

    static let minRate = 0.5
    static let maxRate = 3.5
    /// JS gets this long to answer a remote next / previous before native moves itself.
    static let remoteSkipTimeout: TimeInterval = 2
    /// "previous" restarts the track instead when past this point.
    static let restartThresholdMs = 3000.0

    private var player = AVQueuePlayer()
    private(set) var tracks: [NativeTrack] = []
    private(set) var index = -1
    private(set) var status: PlaybackStatus = .idle
    private var lastError: PlayerError?
    private(set) var rate: Double = 1
    private(set) var volume: Double = 1
    private(set) var repeatMode: RepeatMode = .off

    /// What the user asked for (play vs pause), independent of buffering.
    private var wantsPlay = false
    /// The item we treat as current (to tell our own queue changes from AVFoundation's).
    private var currentItem: QueueItem?
    private var rebuilding = false
    /// Seek to apply once the current item is ready (AVPlayerItem seeks before that are unreliable).
    private var pendingStartMs: Double?

    private var timeObserver: Any?
    private var playerObservations: [NSKeyValueObservation] = []
    private var itemObservations: [NSKeyValueObservation] = []
    private var notificationTokens: [NSObjectProtocol] = []

    private var remoteConfig: RemoteConfig?
    private var chapterTitle: String?
    private var pendingRemoteSkip: DispatchWorkItem?

    private var sleepTimer: SleepTimer?
    private var sleepTick: Timer?
    /// 0..1 multiplier while the sleep timer fades out.
    private var fadeFactor: Double = 1

    private var sessionActive = false
    private var wasPlayingBeforeInterruption = false

    let nowPlaying = NowPlayingController()

    private override init() {
        super.init()
        configurePlayer()
        observeSession()
        nowPlaying.handler = self
        nowPlaying.registerCommands()
    }

    var currentTrack: NativeTrack? {
        index >= 0 && index < tracks.count ? tracks[index] : nil
    }

    /// The AVPlayer, for AirPlay route checks.
    var avPlayer: AVPlayer { player }

    // MARK: - Setup

    private func configurePlayer() {
        player.actionAtItemEnd = .advance
        player.allowsExternalPlayback = true
        player.automaticallyWaitsToMinimizeStalling = true
        player.volume = Float(volume * fadeFactor)

        playerObservations = [
            player.observe(\.currentItem, options: [.new]) { [weak self] _, _ in
                onMain { self?.currentItemChanged() }
            },
            player.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
                onMain { self?.refreshStatus() }
            },
        ]
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 1, preferredTimescale: 1000), queue: .main) { [weak self] _ in
            guard let self = self, self.player.timeControlStatus == .playing else { return }
            self.emitPosition()
        }
    }

    private func teardownPlayer() {
        if let token = timeObserver {
            player.removeTimeObserver(token)
            timeObserver = nil
        }
        playerObservations.forEach { $0.invalidate() }
        playerObservations.removeAll()
        itemObservations.forEach { $0.invalidate() }
        itemObservations.removeAll()
        player.pause()
        player.removeAllItems()
    }

    private func observeSession() {
        let nc = NotificationCenter.default
        let session = AVAudioSession.sharedInstance()
        notificationTokens.append(nc.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: .main) { [weak self] n in
            self?.handleInterruption(n)
        })
        notificationTokens.append(nc.addObserver(forName: AVAudioSession.routeChangeNotification, object: session, queue: .main) { [weak self] n in
            self?.handleRouteChange(n)
        })
        notificationTokens.append(nc.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: session, queue: .main) { [weak self] _ in
            self?.handleMediaServicesReset()
        })
        notificationTokens.append(nc.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: nil, queue: .main) { [weak self] n in
            guard let item = n.object as? QueueItem else { return }
            self?.itemDidPlayToEnd(item)
        })
        notificationTokens.append(nc.addObserver(forName: .AVPlayerItemFailedToPlayToEndTime, object: nil, queue: .main) { [weak self] n in
            guard let self = self, let item = n.object as? QueueItem, item === self.currentItem else { return }
            let error = n.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error
            self.fail(Self.classify(error, item: item))
        })
    }

    private func configureSession() {
        let session = AVAudioSession.sharedInstance()
        do {
            // Long-form audio: music and audiobooks, routed like Music / Podcasts (AirPlay 2 aware).
            try session.setCategory(.playback, mode: .default, policy: .longFormAudio, options: [])
        } catch {
            try? session.setCategory(.playback, mode: .default, options: [])
        }
    }

    private func activateSession() {
        guard !sessionActive else { return }
        configureSession()
        do {
            try AVAudioSession.sharedInstance().setActive(true)
            sessionActive = true
        } catch {
            NSLog("[ArclightPlayer] audio session activation failed: \(error.localizedDescription)")
        }
    }

    private func deactivateSession() {
        guard sessionActive else { return }
        sessionActive = false
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }

    // MARK: - Queue

    func load(_ options: LoadOptions) throws {
        guard !options.tracks.isEmpty else { throw PlayerError(.invalid, "load: no tracks") }
        guard options.startIndex >= 0 && options.startIndex < options.tracks.count else {
            throw PlayerError(.invalid, "load: startIndex \(options.startIndex) is out of range")
        }
        cancelPendingRemoteSkip()
        tracks = options.tracks
        if let r = options.rate { rate = Self.clampRate(r) }
        try startTrack(at: options.startIndex, startMs: options.startMs, autoplay: options.autoplay, reason: "load")
    }

    func setUpcoming(_ upcoming: [NativeTrack]) {
        guard index >= 0, index < tracks.count else {
            // Nothing loaded: there is no "current" to keep. Remember nothing.
            return
        }
        tracks = Array(tracks[0...index]) + upcoming
        rebuildUpcoming()
    }

    func skipTo(index target: Int, positionMs: Double) throws {
        guard target >= 0 && target < tracks.count else {
            throw PlayerError(.invalid, "skipTo: index \(target) is out of range")
        }
        cancelPendingRemoteSkip()
        try startTrack(at: target, startMs: max(0, positionMs), autoplay: wantsPlay, reason: "skip")
    }

    /// Replaces the AVQueuePlayer's items with `tracks[i]` (+ the next one) and starts it.
    private func startTrack(at i: Int, startMs: Double, autoplay: Bool, reason: String) throws {
        let previousId = currentTrack?.id
        rebuilding = true
        itemObservations.forEach { $0.invalidate() }
        itemObservations.removeAll()
        player.removeAllItems()
        currentItem = nil
        pendingStartMs = nil
        index = i
        lastError = nil
        wantsPlay = autoplay

        let item: QueueItem
        do {
            item = try makeItem(trackIndex: i)
        } catch let error as PlayerError {
            rebuilding = false
            wantsPlay = false
            emitTrackChanged(previousId: previousId, reason: reason)
            fail(error)
            throw error
        }
        currentItem = item
        observe(item)
        player.insert(item, after: nil)
        appendUpcoming()
        rebuilding = false
        updateEndOfTrackAction()

        if startMs > 0 {
            if item.status == .readyToPlay {
                seekCurrent(toMs: startMs, completion: nil)
            } else {
                pendingStartMs = startMs
            }
        }
        emitTrackChanged(previousId: previousId, reason: reason)
        if autoplay {
            activateSession()
            setStatus(.loading)
            if pendingStartMs == nil {
                player.rate = Float(rate)
            }
        } else {
            player.pause()
            setStatus(.paused)
        }
        applyRemoteMode()
        updateNowPlaying()
    }

    private func makeItem(trackIndex i: Int) throws -> QueueItem {
        let track = tracks[i]
        guard let url = resolveMediaURL(track.url) else {
            throw PlayerError(.invalid, "Unsupported track URL for \(track.id)")
        }
        var options: [String: Any] = [:]
        if url.isFileURL {
            guard FileManager.default.isReadableFile(atPath: url.path) else {
                throw PlayerError(.file, "Downloaded file is missing: \(url.lastPathComponent)")
            }
        } else if !track.headers.isEmpty {
            // Documented-in-practice key for per-asset request headers (no public constant).
            options["AVURLAssetHTTPHeaderFieldsKey"] = track.headers
        }
        let asset = AVURLAsset(url: url, options: options)
        let item = QueueItem(asset: asset, trackIndex: i, trackId: track.id)
        item.audioTimePitchAlgorithm = track.isAudiobook ? .timeDomain : .spectral
        return item
    }

    /// Index that follows `i` on its own (end of track): repeat one loops, repeat all wraps.
    private func autoNextIndex(after i: Int) -> Int? {
        guard !tracks.isEmpty else { return nil }
        if repeatMode == .one { return i }
        if i + 1 < tracks.count { return i + 1 }
        return repeatMode == .all ? 0 : nil
    }

    /// Index for a "next" button press: always moves on (repeat one does not trap it).
    private func manualNextIndex(after i: Int) -> Int? {
        if i + 1 < tracks.count { return i + 1 }
        return repeatMode == .all && !tracks.isEmpty ? 0 : nil
    }

    /// Keeps the AVQueuePlayer at "current + next" so the next track is prerolled.
    private func appendUpcoming() {
        let items = player.items()
        guard items.count < 2, let last = items.last as? QueueItem else { return }
        guard let next = autoNextIndex(after: last.trackIndex), next < tracks.count else { return }
        guard let item = try? makeItem(trackIndex: next) else { return }
        if player.canInsert(item, after: last) {
            player.insert(item, after: last)
        }
    }

    private func rebuildUpcoming() {
        guard let current = player.currentItem else { return }
        for item in player.items() where item !== current {
            player.remove(item)
        }
        appendUpcoming()
        updateEndOfTrackAction()
    }

    private func observe(_ item: QueueItem) {
        itemObservations.forEach { $0.invalidate() }
        itemObservations = [
            item.observe(\.status, options: [.new]) { [weak self] item, _ in
                onMain { self?.itemStatusChanged(item) }
            },
        ]
    }

    private func itemStatusChanged(_ item: QueueItem) {
        guard item === currentItem else { return }
        switch item.status {
        case .readyToPlay:
            if let ms = pendingStartMs {
                pendingStartMs = nil
                seekCurrent(toMs: ms) { [weak self] in
                    guard let self = self, self.wantsPlay else { return }
                    self.player.rate = Float(self.rate)
                }
            } else {
                emitPosition()
            }
            updateNowPlaying()
        case .failed:
            fail(Self.classify(item.error, item: item))
        default:
            break
        }
    }

    /// AVQueuePlayer moved to another item on its own (gapless advance) or ran dry.
    private func currentItemChanged() {
        guard !rebuilding else { return }
        // After a failure the queue may skip the failed item on its own; stay on the error so JS
        // can fetch fresh links and reload (play() restarts the failed track).
        guard status != .error else { return }
        let newItem = player.currentItem as? QueueItem
        if newItem === currentItem && newItem != nil { return }
        guard let item = newItem else {
            queueDrained()
            return
        }
        let previousId = currentTrack?.id
        currentItem = item
        index = item.trackIndex
        lastError = nil
        observe(item)
        appendUpcoming()
        updateEndOfTrackAction()
        emitTrackChanged(previousId: previousId, reason: "auto")
        applyRemoteMode()
        updateNowPlaying()
        refreshStatus()
        emitPosition()
    }

    private func itemDidPlayToEnd(_ item: QueueItem) {
        guard item === currentItem else { return }
        if case .endOfTrack(let id)? = sleepTimer, id == item.trackId {
            // actionAtItemEnd was .pause for this track: we stay paused at its end.
            fireSleepTimer()
            if player.items().count > 1 {
                player.advanceToNextItem()
            }
            return
        }
        if autoNextIndex(after: item.trackIndex) == nil {
            markEnded()
        }
    }

    private func queueDrained() {
        if status == .ended || status == .error || status == .idle { return }
        if let next = autoNextIndex(after: index), next != index || repeatMode == .one {
            // The next track could not be prerolled (missing file?): start it the slow way.
            try? startTrack(at: next, startMs: 0, autoplay: wantsPlay, reason: "auto")
        } else {
            markEnded()
        }
    }

    private func markEnded() {
        guard status != .ended else { return }
        wantsPlay = false
        setStatus(.ended)
        emitPosition()
        PlayerEventHub.shared.emit("queueEnded", ["trackId": currentTrack?.id ?? NSNull()], retain: true)
        updateNowPlaying()
    }

    // MARK: - Transport

    func play() throws {
        guard index >= 0, index < tracks.count else { throw PlayerError(.invalid, "play: nothing is loaded") }
        if status == .ended || status == .error || player.currentItem == nil {
            try startTrack(at: index, startMs: status == .error ? currentPositionMs() : 0, autoplay: true, reason: "skip")
            return
        }
        if let item = player.currentItem {
            let duration = item.duration.seconds
            if duration.isFinite && duration > 0 && player.currentTime().seconds >= duration - 0.25 {
                player.seek(to: .zero)
            }
        }
        wantsPlay = true
        activateSession()
        if pendingStartMs == nil {
            player.rate = Float(rate)
        }
        refreshStatus()
        updateNowPlaying()
    }

    func pause() {
        wantsPlay = false
        player.pause()
        refreshStatus()
        emitPosition()
        updateNowPlaying()
    }

    func seek(toMs ms: Double) {
        guard currentItem != nil else { return }
        if pendingStartMs != nil {
            pendingStartMs = max(0, ms)
            return
        }
        seekCurrent(toMs: ms, completion: nil)
    }

    private func seekCurrent(toMs ms: Double, completion: (() -> Void)?) {
        var target = max(0, ms) / 1000
        if let d = player.currentItem?.duration.seconds, d.isFinite, d > 0 {
            target = min(target, max(0, d - 0.5))
        }
        let time = CMTime(seconds: target, preferredTimescale: 1000)
        player.seek(to: time, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
            onMain {
                self?.emitPosition()
                self?.updateNowPlaying()
                completion?()
            }
        }
    }

    func setRate(_ value: Double) {
        rate = Self.clampRate(value)
        if player.rate > 0 {
            player.rate = Float(rate)
        }
        updateNowPlaying()
    }

    func setVolume(_ value: Double) {
        volume = min(1, max(0, value))
        applyVolume()
    }

    func setRepeat(_ mode: RepeatMode) {
        repeatMode = mode
        rebuildUpcoming()
    }

    func stop() {
        cancelPendingRemoteSkip()
        cancelSleepTimer()
        wantsPlay = false
        rebuilding = true
        itemObservations.forEach { $0.invalidate() }
        itemObservations.removeAll()
        player.pause()
        player.removeAllItems()
        rebuilding = false
        currentItem = nil
        pendingStartMs = nil
        tracks = []
        index = -1
        lastError = nil
        chapterTitle = nil
        setStatus(.idle)
        nowPlaying.clear()
        deactivateSession()
    }

    func configureRemote(_ config: RemoteConfig) {
        remoteConfig = config
        applyRemoteMode()
    }

    func setChapterTitle(_ title: String?) {
        chapterTitle = title
        updateNowPlaying()
    }

    private func applyRemoteMode() {
        let config = remoteConfig ?? RemoteConfig(audiobookMode: currentTrack?.isAudiobook ?? false, skipBackMs: 30_000, skipForwardMs: 30_000)
        nowPlaying.configure(audiobook: config.audiobookMode, skipBackSeconds: config.skipBackMs / 1000, skipForwardSeconds: config.skipForwardMs / 1000)
    }

    private func applyVolume() {
        player.volume = Float(volume * fadeFactor)
    }

    static func clampRate(_ r: Double) -> Double {
        guard r.isFinite else { return 1 }
        return min(maxRate, max(minRate, r))
    }

    // MARK: - Status & events

    private func refreshStatus() {
        guard index >= 0 else { return }
        if status == .ended || status == .error { return }
        switch player.timeControlStatus {
        case .playing:
            setStatus(.playing)
        case .waitingToPlayAtSpecifiedRate:
            setStatus(status == .loading ? .loading : .buffering)
        case .paused:
            // Waiting for the start seek before playing: still loading.
            if wantsPlay && pendingStartMs != nil { return }
            if wantsPlay && status == .loading && currentItem?.status != .readyToPlay { return }
            setStatus(.paused)
        @unknown default:
            break
        }
        updateNowPlaying()
    }

    private func setStatus(_ newStatus: PlaybackStatus, error: PlayerError? = nil) {
        if newStatus == status && error == nil { return }
        status = newStatus
        lastError = error
        var data: [String: Any] = [
            "status": newStatus.rawValue,
            "trackId": currentTrack?.id ?? NSNull(),
            "index": index,
        ]
        if let error = error { data["error"] = error.js }
        PlayerEventHub.shared.emit("state", data)
        CarPlayController.shared.playbackStateChanged()
    }

    private func fail(_ error: PlayerError) {
        wantsPlay = false
        player.pause()
        setStatus(.error, error: error)
        updateNowPlaying()
    }

    private func emitTrackChanged(previousId: String?, reason: String) {
        guard let track = currentTrack else { return }
        PlayerEventHub.shared.emit("trackChanged", [
            "index": index,
            "trackId": track.id,
            "previousTrackId": previousId ?? NSNull(),
            "reason": reason,
        ], retain: true)
    }

    private func emitPosition() {
        guard let track = currentTrack else { return }
        PlayerEventHub.shared.emit("position", [
            "trackId": track.id,
            "index": index,
            "positionMs": Int(currentPositionMs()),
            "durationMs": currentDurationMs(),
            "bufferedMs": bufferedMs(),
        ])
    }

    private func currentPositionMs() -> Double {
        if let pending = pendingStartMs { return pending }
        guard player.currentItem != nil else { return 0 }
        return Double(toMs(player.currentTime().seconds))
    }

    private func currentDurationMs() -> Int {
        if let d = player.currentItem?.duration.seconds, d.isFinite, d > 0 { return toMs(d) }
        return Int(currentTrack?.durationMs ?? 0)
    }

    private func bufferedMs() -> Int {
        guard let item = player.currentItem else { return 0 }
        let now = player.currentTime()
        var best: Double = 0
        for value in item.loadedTimeRanges {
            let range = value.timeRangeValue
            let end = CMTimeRangeGetEnd(range).seconds
            if range.containsTime(now) { return toMs(end) }
            if end.isFinite { best = max(best, end) }
        }
        return toMs(best)
    }

    func snapshot() -> [String: Any] {
        var d: [String: Any] = [
            "status": status.rawValue,
            "index": index,
            "trackId": currentTrack?.id ?? NSNull(),
            "positionMs": Int(currentPositionMs()),
            "durationMs": currentDurationMs(),
            "bufferedMs": bufferedMs(),
            "rate": rate,
            "volume": volume,
            "repeat": repeatMode.rawValue,
        ]
        if status == .error, let error = lastError { d["error"] = error.js }
        return d
    }

    var isPlaying: Bool { wantsPlay && (status == .playing || status == .buffering || status == .loading) }

    private func updateNowPlaying() {
        guard let track = currentTrack else {
            nowPlaying.clear()
            return
        }
        let playingRate = player.timeControlStatus == .playing ? Double(player.rate) : 0
        nowPlaying.update(NowPlayingController.Info(
            track: track,
            chapterTitle: chapterTitle,
            durationSeconds: Double(currentDurationMs()) / 1000,
            elapsedSeconds: currentPositionMs() / 1000,
            rate: playingRate,
            defaultRate: rate,
            queueIndex: index,
            queueCount: tracks.count
        ))
    }

    // MARK: - Remote commands

    func handleRemote(_ action: RemoteAction) -> Bool {
        guard currentTrack != nil else { return false }
        let hub = PlayerEventHub.shared
        switch action {
        case .play:
            try? play()
            hub.emit("remoteCommand", ["command": "play", "handled": true])
        case .pause:
            pause()
            hub.emit("remoteCommand", ["command": "pause", "handled": true])
        case .togglePlayPause:
            if wantsPlay { pause() } else { try? play() }
            hub.emit("remoteCommand", ["command": "togglePlayPause", "handled": true])
        case .stop:
            // Pause only: JS decides whether to tear the queue down (it calls stop()).
            pause()
            hub.emit("remoteCommand", ["command": "stop", "handled": false])
        case .next:
            remoteSkipTrack(next: true)
        case .previous:
            remoteSkipTrack(next: false)
        case .seek(let seconds):
            seek(toMs: seconds * 1000)
            hub.emit("remoteCommand", ["command": "seekTo", "positionMs": toMs(seconds), "handled": true])
        case .skipForward(let seconds):
            let interval = seconds * 1000
            seek(toMs: currentPositionMs() + interval)
            hub.emit("remoteCommand", ["command": "skipForward", "intervalMs": Int(interval), "handled": true])
        case .skipBackward(let seconds):
            let interval = seconds * 1000
            seek(toMs: max(0, currentPositionMs() - interval))
            hub.emit("remoteCommand", ["command": "skipBackward", "intervalMs": Int(interval), "handled": true])
        case .rate(let r):
            setRate(r)
        }
        return true
    }

    /// `next` / `previous`: JS decides; if it does not react in time, move within the native queue.
    private func remoteSkipTrack(next: Bool) {
        cancelPendingRemoteSkip()
        let hub = PlayerEventHub.shared
        let command = next ? "next" : "previous"
        guard hub.hasListeners("remoteCommand") else {
            applyRemoteSkip(next: next)
            return
        }
        hub.emit("remoteCommand", ["command": command, "handled": false])
        let work = DispatchWorkItem { [weak self] in
            self?.pendingRemoteSkip = nil
            self?.applyRemoteSkip(next: next)
        }
        pendingRemoteSkip = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.remoteSkipTimeout, execute: work)
    }

    private func applyRemoteSkip(next: Bool) {
        guard index >= 0 else { return }
        let autoplay = wantsPlay || status == .ended
        if next {
            guard let target = manualNextIndex(after: index) else { return }
            try? startTrack(at: target, startMs: 0, autoplay: autoplay, reason: "remote")
        } else {
            if currentPositionMs() > Self.restartThresholdMs || (index == 0 && repeatMode != .all) {
                seek(toMs: 0)
                return
            }
            let target = index > 0 ? index - 1 : tracks.count - 1
            try? startTrack(at: target, startMs: 0, autoplay: autoplay, reason: "remote")
        }
    }

    private func cancelPendingRemoteSkip() {
        pendingRemoteSkip?.cancel()
        pendingRemoteSkip = nil
    }

    // MARK: - Sleep timer

    func setSleepTimer(_ timer: SleepTimer?) {
        cancelSleepTimer()
        guard let timer = timer else { return }
        sleepTimer = timer
        switch timer {
        case .minutes:
            let tick = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in self?.sleepTimerTick() }
            RunLoop.main.add(tick, forMode: .common)
            sleepTick = tick
            sleepTimerTick()
        case .endOfTrack:
            updateEndOfTrackAction()
        }
    }

    private func sleepTimerTick() {
        guard case .minutes(let endsAt, let fadeMs)? = sleepTimer else { return }
        let remaining = endsAt - nowMs()
        if remaining <= 0 {
            fireSleepTimer()
            return
        }
        if fadeMs > 0 && remaining < fadeMs {
            fadeFactor = max(0, remaining / fadeMs)
        } else {
            fadeFactor = 1
        }
        applyVolume()
    }

    private func fireSleepTimer() {
        cancelSleepTimer()
        pause()
        PlayerEventHub.shared.emit("sleepTimerFired", [:], retain: true)
    }

    private func cancelSleepTimer() {
        sleepTick?.invalidate()
        sleepTick = nil
        sleepTimer = nil
        fadeFactor = 1
        applyVolume()
        updateEndOfTrackAction()
    }

    /// With an end-of-track sleep timer on the current track, stop at its end instead of advancing.
    private func updateEndOfTrackAction() {
        if case .endOfTrack(let id)? = sleepTimer, id == currentTrack?.id {
            player.actionAtItemEnd = .pause
        } else {
            player.actionAtItemEnd = .advance
        }
    }

    // MARK: - Audio session events

    private func handleInterruption(_ n: Notification) {
        guard let info = n.userInfo,
              let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        switch type {
        case .began:
            wasPlayingBeforeInterruption = wantsPlay
            if wantsPlay {
                wantsPlay = false
                sessionActive = false
                refreshStatus()
                emitPosition()
                updateNowPlaying()
            }
        case .ended:
            let optionsRaw = info[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            let options = AVAudioSession.InterruptionOptions(rawValue: optionsRaw)
            if options.contains(.shouldResume) && wasPlayingBeforeInterruption {
                try? play()
            }
            wasPlayingBeforeInterruption = false
        @unknown default:
            break
        }
    }

    private func handleRouteChange(_ n: Notification) {
        if let raw = n.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
           let reason = AVAudioSession.RouteChangeReason(rawValue: raw),
           reason == .oldDeviceUnavailable,
           wantsPlay {
            // Headphones unplugged / Bluetooth gone: pause instead of blasting the speaker.
            pause()
            PlayerEventHub.shared.emit("remoteCommand", ["command": "pause", "handled": true])
        }
        CastController.shared.refresh()
    }

    private func handleMediaServicesReset() {
        // Every AVFoundation object is invalid now: rebuild the player and report an error so
        // JS reloads the queue (or the user presses play, which restarts the current track).
        sessionActive = false
        let resumeIndex = index
        teardownPlayer()
        player = AVQueuePlayer()
        configurePlayer()
        currentItem = nil
        if resumeIndex >= 0 {
            fail(PlayerError(.unknown, "Audio services were reset"))
        }
    }

    // MARK: - Errors

    /// Maps AVFoundation / URL loading errors to the contract's codes.
    static func classify(_ error: Error?, item: AVPlayerItem?) -> PlayerError {
        var httpStatus: Int?
        if let events = item?.errorLog()?.events {
            for event in events.reversed() where event.errorStatusCode >= 400 && event.errorStatusCode < 600 {
                httpStatus = event.errorStatusCode
                break
            }
        }
        var chain: [NSError] = []
        var next = error.map { $0 as NSError }
        while let e = next, chain.count < 8 {
            chain.append(e)
            next = e.userInfo[NSUnderlyingErrorKey] as? NSError
        }
        for e in chain where e.domain == "CoreMediaErrorDomain" && httpStatus == nil {
            // CoreMedia reports some HTTP failures only as codes.
            switch e.code {
            case -12660: httpStatus = 403
            case -12938: httpStatus = 404
            default: break
            }
        }
        let message = error?.localizedDescription ?? "Playback failed"
        if let s = httpStatus {
            switch s {
            case 401, 403: return PlayerError(.auth, message, httpStatus: s)
            case 429, 503: return PlayerError(.busy, message, httpStatus: s)
            case 500...599: return PlayerError(.network, message, httpStatus: s)
            default: return PlayerError(.unknown, message, httpStatus: s)
            }
        }
        for e in chain {
            if e.domain == NSURLErrorDomain {
                switch e.code {
                case NSURLErrorUserAuthenticationRequired, NSURLErrorUserCancelledAuthentication:
                    return PlayerError(.auth, message)
                case NSURLErrorFileDoesNotExist, NSURLErrorNoPermissionsToReadFile, NSURLErrorCannotOpenFile:
                    return PlayerError(.file, message)
                default:
                    return PlayerError(.network, message)
                }
            }
            if e.domain == NSCocoaErrorDomain && (e.code == NSFileReadNoSuchFileError || e.code == NSFileReadNoPermissionError) {
                return PlayerError(.file, message)
            }
            if e.domain == AVFoundationErrorDomain {
                switch e.code {
                // fileFormatNotRecognized, fileFailedToParse, decodeFailed, decoderNotFound
                case -11828, -11829, -11821, -11833:
                    return PlayerError(.unsupported, message)
                // contentIsNotAuthorized
                case -11835:
                    return PlayerError(.auth, message)
                // serverIncorrectlyConfigured
                case -11850:
                    return PlayerError(.network, message)
                default:
                    break
                }
            }
        }
        return PlayerError(.unknown, message)
    }
}
