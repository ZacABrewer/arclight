import Foundation

// Value types shared by the ArclightPlayer plugin's parts. They mirror the TypeScript contract in
// apps/player/src/native/definitions.ts; keep field names in sync with it.

/// Error codes used in rejections and in `state` events (`PlayerErrorCode` in definitions.ts).
enum PlayerErrorCode: String {
    case auth, network, busy, unsupported, file, invalid, unknown
}

struct PlayerError: Error {
    let code: PlayerErrorCode
    let message: String
    var httpStatus: Int?

    init(_ code: PlayerErrorCode, _ message: String, httpStatus: Int? = nil) {
        self.code = code
        self.message = message
        self.httpStatus = httpStatus
    }

    var js: [String: Any] {
        var d: [String: Any] = ["code": code.rawValue, "message": message]
        if let httpStatus = httpStatus { d["httpStatus"] = httpStatus }
        return d
    }
}

/// Converts the plugin call's JSON-shaped options to Codable structs and back.
enum JSONBridge {
    static func decode<T: Decodable>(_ type: T.Type, from object: Any) throws -> T {
        guard JSONSerialization.isValidJSONObject(object) else {
            throw PlayerError(.invalid, "Arguments are not valid JSON")
        }
        let data = try JSONSerialization.data(withJSONObject: object, options: [])
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw PlayerError(.invalid, "Bad arguments: \(error.localizedDescription)")
        }
    }
}

/// `KeyedDecodingContainer` helpers with defaults, so a missing optional field never fails a call.
extension KeyedDecodingContainer {
    func string(_ key: Key, _ fallback: String = "") -> String {
        (try? decodeIfPresent(String.self, forKey: key)) ?? fallback
    }

    func optString(_ key: Key) -> String? {
        guard let s = (try? decodeIfPresent(String.self, forKey: key)) ?? nil, !s.isEmpty else { return nil }
        return s
    }

    func double(_ key: Key, _ fallback: Double = 0) -> Double {
        if let d = (try? decodeIfPresent(Double.self, forKey: key)) ?? nil, d.isFinite { return d }
        return fallback
    }

    func bool(_ key: Key, _ fallback: Bool = false) -> Bool {
        (try? decodeIfPresent(Bool.self, forKey: key)) ?? fallback
    }

    func headers(_ key: Key) -> [String: String] {
        (try? decodeIfPresent([String: String].self, forKey: key)) ?? [:]
    }
}

/// Turns a URL string from JS (http(s) URL, `file://` URL or absolute path) into a URL.
func resolveMediaURL(_ raw: String) -> URL? {
    let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if s.isEmpty { return nil }
    if s.hasPrefix("/") { return URL(fileURLWithPath: s) }
    guard let url = URL(string: s), let scheme = url.scheme?.lowercased() else { return nil }
    switch scheme {
    case "http", "https", "file": return url
    default: return nil
    }
}

// MARK: - Audio

/// One playable file (`NativeTrack`).
struct NativeTrack: Decodable {
    let id: String
    let itemKey: String
    let kind: String
    let partIndex: Int
    let itemOffsetMs: Double
    let url: String
    let headers: [String: String]
    let mimeType: String?
    let durationMs: Double
    let title: String
    let artist: String?
    let album: String?
    let artworkUrl: String?
    let artworkHeaders: [String: String]

    var isAudiobook: Bool { kind == "audiobook" }

    private enum CodingKeys: String, CodingKey {
        case id, itemKey, kind, partIndex, itemOffsetMs, url, headers, mimeType, durationMs, title, artist, album, artworkUrl, artworkHeaders
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        url = try c.decode(String.self, forKey: .url)
        itemKey = c.string(.itemKey)
        kind = c.string(.kind, "track")
        partIndex = Int(c.double(.partIndex))
        itemOffsetMs = c.double(.itemOffsetMs)
        headers = c.headers(.headers)
        mimeType = c.optString(.mimeType)
        durationMs = max(0, c.double(.durationMs))
        title = c.string(.title)
        artist = c.optString(.artist)
        album = c.optString(.album)
        artworkUrl = c.optString(.artworkUrl)
        artworkHeaders = c.headers(.artworkHeaders)
    }
}

struct LoadOptions: Decodable {
    let tracks: [NativeTrack]
    let startIndex: Int
    let startMs: Double
    let autoplay: Bool
    let rate: Double?

    private enum CodingKeys: String, CodingKey { case tracks, startIndex, startMs, autoplay, rate }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        tracks = try c.decode([NativeTrack].self, forKey: .tracks)
        startIndex = Int(c.double(.startIndex))
        startMs = max(0, c.double(.startMs))
        autoplay = c.bool(.autoplay, true)
        rate = (try? c.decodeIfPresent(Double.self, forKey: .rate)) ?? nil
    }
}

struct UpcomingOptions: Decodable {
    let tracks: [NativeTrack]
}

enum RepeatMode: String {
    case off, one, all
}

enum PlaybackStatus: String {
    case idle, loading, buffering, playing, paused, ended, error
}

struct RemoteConfig {
    var audiobookMode: Bool
    var skipBackMs: Double
    var skipForwardMs: Double

    static let `default` = RemoteConfig(audiobookMode: false, skipBackMs: 30_000, skipForwardMs: 30_000)
}

enum SleepTimer {
    /// `endsAt` is epoch milliseconds.
    case minutes(endsAt: Double, fadeMs: Double)
    case endOfTrack(trackId: String)
}

// MARK: - Car

/// One row of the car's browse UI (`BrowseNode`).
struct BrowseNode: Codable {
    var id: String
    var title: String
    var subtitle: String?
    var artworkUrl: String?
    var artworkHeaders: [String: String]?
    var browsable: Bool
    var playable: Bool
    var progress: Double?

    private enum CodingKeys: String, CodingKey {
        case id, title, subtitle, artworkUrl, artworkHeaders, browsable, playable, progress
    }

    init(id: String, title: String, subtitle: String? = nil, browsable: Bool, playable: Bool) {
        self.id = id
        self.title = title
        self.subtitle = subtitle
        self.artworkUrl = nil
        self.artworkHeaders = nil
        self.browsable = browsable
        self.playable = playable
        self.progress = nil
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = c.string(.title)
        subtitle = c.optString(.subtitle)
        artworkUrl = c.optString(.artworkUrl)
        let h = c.headers(.artworkHeaders)
        artworkHeaders = h.isEmpty ? nil : h
        browsable = c.bool(.browsable)
        playable = c.bool(.playable)
        let p = c.double(.progress, -1)
        progress = p >= 0 ? min(1, p) : nil
    }
}

struct BrowseTree: Codable {
    var root: [BrowseNode]
    var children: [String: [BrowseNode]]

    static let empty = BrowseTree(root: [], children: [:])

    init(root: [BrowseNode], children: [String: [BrowseNode]]) {
        self.root = root
        self.children = children
    }

    private enum CodingKeys: String, CodingKey { case root, children }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        root = (try? c.decodeIfPresent([BrowseNode].self, forKey: .root)) ?? []
        children = (try? c.decodeIfPresent([String: [BrowseNode]].self, forKey: .children)) ?? [:]
    }
}

struct AnswerBrowseOptions: Decodable {
    let requestId: String
    let items: [BrowseNode]
}

// MARK: - Downloads

struct DownloadRequest: Decodable {
    let id: String
    let url: String
    let headers: [String: String]
    let destName: String
    let wifiOnly: Bool
    let title: String?
    let expectedBytes: Int64?

    private enum CodingKeys: String, CodingKey { case id, url, headers, destName, wifiOnly, title, expectedBytes }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        url = try c.decode(String.self, forKey: .url)
        destName = try c.decode(String.self, forKey: .destName)
        headers = c.headers(.headers)
        wifiOnly = c.bool(.wifiOnly)
        title = c.optString(.title)
        let e = c.double(.expectedBytes, -1)
        expectedBytes = e > 0 ? Int64(e) : nil
    }
}
