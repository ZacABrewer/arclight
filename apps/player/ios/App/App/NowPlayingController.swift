import Foundation
import MediaPlayer
import UIKit

/// Commands from the lock screen, Control Center, headphones, watch and CarPlay.
enum RemoteAction {
    case play
    case pause
    case togglePlayPause
    case stop
    case next
    case previous
    /// Absolute position inside the current track, seconds.
    case seek(TimeInterval)
    /// Interval in seconds.
    case skipForward(TimeInterval)
    case skipBackward(TimeInterval)
    case rate(Double)
}

protocol RemoteActionHandler: AnyObject {
    /// Returns false when nothing is loaded (the command then reports `noActionableNowPlayingItem`).
    func handleRemote(_ action: RemoteAction) -> Bool
}

/// Owns MPNowPlayingInfoCenter (lock screen / Control Center / CarPlay "Now Playing") and
/// MPRemoteCommandCenter (the buttons on all of those).
final class NowPlayingController {
    weak var handler: RemoteActionHandler?

    private let center = MPRemoteCommandCenter.shared()
    private var targets: [(MPRemoteCommand, Any)] = []
    private var artwork: MPMediaItemArtwork?
    private var artworkKey: String?
    private var currentTrackId: String?
    /// The artwork URL last fetched (one attempt per track change, also when it fails).
    private var artworkRequested: String?

    /// Rates offered by the rate control (CarPlay / watch) for audiobooks.
    static let supportedRates: [Double] = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0]

    init() {}

    // MARK: Remote commands

    func registerCommands() {
        guard targets.isEmpty else { return }
        add(center.playCommand) { [weak self] _ in self?.dispatch(.play) ?? .commandFailed }
        add(center.pauseCommand) { [weak self] _ in self?.dispatch(.pause) ?? .commandFailed }
        add(center.togglePlayPauseCommand) { [weak self] _ in self?.dispatch(.togglePlayPause) ?? .commandFailed }
        add(center.stopCommand) { [weak self] _ in self?.dispatch(.stop) ?? .commandFailed }
        add(center.nextTrackCommand) { [weak self] _ in self?.dispatch(.next) ?? .commandFailed }
        add(center.previousTrackCommand) { [weak self] _ in self?.dispatch(.previous) ?? .commandFailed }
        add(center.changePlaybackPositionCommand) { [weak self] event in
            guard let e = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            return self?.dispatch(.seek(e.positionTime)) ?? .commandFailed
        }
        add(center.skipForwardCommand) { [weak self] event in
            let interval = (event as? MPSkipIntervalCommandEvent)?.interval ?? 30
            return self?.dispatch(.skipForward(interval)) ?? .commandFailed
        }
        add(center.skipBackwardCommand) { [weak self] event in
            let interval = (event as? MPSkipIntervalCommandEvent)?.interval ?? 30
            return self?.dispatch(.skipBackward(interval)) ?? .commandFailed
        }
        add(center.changePlaybackRateCommand) { [weak self] event in
            guard let e = event as? MPChangePlaybackRateCommandEvent else { return .commandFailed }
            return self?.dispatch(.rate(Double(e.playbackRate))) ?? .commandFailed
        }
        center.changePlaybackRateCommand.supportedPlaybackRates = Self.supportedRates.map { NSNumber(value: $0) }
        // Not offered: like/dislike/bookmark, repeat and shuffle (JS owns those).
        center.likeCommand.isEnabled = false
        center.dislikeCommand.isEnabled = false
        center.bookmarkCommand.isEnabled = false
        center.changeRepeatModeCommand.isEnabled = false
        center.changeShuffleModeCommand.isEnabled = false
        center.seekForwardCommand.isEnabled = false
        center.seekBackwardCommand.isEnabled = false
        configure(audiobook: false, skipBackSeconds: 30, skipForwardSeconds: 30)
    }

    func unregisterCommands() {
        for (command, target) in targets {
            command.removeTarget(target)
        }
        targets.removeAll()
    }

    /// Music: previous / next. Audiobooks: skip back / forward by the given intervals.
    func configure(audiobook: Bool, skipBackSeconds: Double, skipForwardSeconds: Double) {
        center.playCommand.isEnabled = true
        center.pauseCommand.isEnabled = true
        center.togglePlayPauseCommand.isEnabled = true
        center.stopCommand.isEnabled = true
        center.changePlaybackPositionCommand.isEnabled = true
        center.nextTrackCommand.isEnabled = !audiobook
        center.previousTrackCommand.isEnabled = !audiobook
        center.skipForwardCommand.isEnabled = audiobook
        center.skipBackwardCommand.isEnabled = audiobook
        center.skipForwardCommand.preferredIntervals = [NSNumber(value: max(1, skipForwardSeconds))]
        center.skipBackwardCommand.preferredIntervals = [NSNumber(value: max(1, skipBackSeconds))]
        center.changePlaybackRateCommand.isEnabled = audiobook
    }

    private func add(_ command: MPRemoteCommand, _ body: @escaping (MPRemoteCommandEvent) -> MPRemoteCommandHandlerStatus) {
        let target = command.addTarget(handler: body)
        targets.append((command, target))
    }

    private func dispatch(_ action: RemoteAction) -> MPRemoteCommandHandlerStatus {
        guard let handler = handler else { return .commandFailed }
        var ok = false
        if Thread.isMainThread {
            ok = handler.handleRemote(action)
        } else {
            DispatchQueue.main.sync { ok = handler.handleRemote(action) }
        }
        return ok ? .success : .noActionableNowPlayingItem
    }

    // MARK: Now playing info

    struct Info {
        let track: NativeTrack
        let chapterTitle: String?
        let durationSeconds: Double
        let elapsedSeconds: Double
        /// 0 while paused / buffering, else the playback rate.
        let rate: Double
        let defaultRate: Double
        let queueIndex: Int
        let queueCount: Int
    }

    func update(_ info: Info) {
        let track = info.track
        if currentTrackId != track.id {
            currentTrackId = track.id
            artworkRequested = nil
            if artworkKey != track.artworkUrl {
                artwork = nil
                artworkKey = nil
            }
        }

        var d: [String: Any] = [:]
        if let chapter = info.chapterTitle, !chapter.isEmpty {
            // Audiobooks: the chapter on the first line, the book and author below.
            d[MPMediaItemPropertyTitle] = chapter
            d[MPMediaItemPropertyArtist] = [track.title, track.artist].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
            if let album = track.album { d[MPMediaItemPropertyAlbumTitle] = album }
        } else {
            d[MPMediaItemPropertyTitle] = track.title
            if let artist = track.artist { d[MPMediaItemPropertyArtist] = artist }
            if let album = track.album { d[MPMediaItemPropertyAlbumTitle] = album }
        }
        if info.durationSeconds > 0 {
            d[MPMediaItemPropertyPlaybackDuration] = info.durationSeconds
        }
        d[MPNowPlayingInfoPropertyElapsedPlaybackTime] = max(0, info.elapsedSeconds)
        d[MPNowPlayingInfoPropertyPlaybackRate] = info.rate
        d[MPNowPlayingInfoPropertyDefaultPlaybackRate] = info.defaultRate
        d[MPNowPlayingInfoPropertyMediaType] = MPNowPlayingInfoMediaType.audio.rawValue
        d[MPNowPlayingInfoPropertyPlaybackQueueIndex] = max(0, info.queueIndex)
        d[MPNowPlayingInfoPropertyPlaybackQueueCount] = max(0, info.queueCount)
        d[MPNowPlayingInfoPropertyExternalContentIdentifier] = track.id
        if let artwork = artwork, artworkKey == track.artworkUrl {
            d[MPMediaItemPropertyArtwork] = artwork
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = d

        if artwork == nil, let url = track.artworkUrl, artworkRequested != url {
            artworkRequested = url
            loadArtwork(url, headers: track.artworkHeaders, trackId: track.id)
        }
    }

    func clear() {
        currentTrackId = nil
        artworkRequested = nil
        artwork = nil
        artworkKey = nil
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }

    private func loadArtwork(_ url: String, headers: [String: String], trackId: String) {
        ArtworkLoader.shared.load(url, headers: headers) { [weak self] image in
            guard let self = self, let image = image, self.currentTrackId == trackId else { return }
            self.artworkKey = url
            self.artwork = Self.makeArtwork(image)
            if var info = MPNowPlayingInfoCenter.default().nowPlayingInfo {
                info[MPMediaItemPropertyArtwork] = self.artwork
                MPNowPlayingInfoCenter.default().nowPlayingInfo = info
            }
        }
    }

    /// The request handler may be called on any thread: it only returns the captured image.
    private static func makeArtwork(_ image: UIImage) -> MPMediaItemArtwork {
        let size = image.size
        return MPMediaItemArtwork(boundsSize: size) { _ in image }
    }
}
