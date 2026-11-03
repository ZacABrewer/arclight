import Foundation
import Network

/// Background downloads for offline listening.
///
/// Two background URLSessions (identifiers derived from the bundle ID): one that may use any
/// network and one restricted to unmetered networks (no cellular, no expensive / hotspot) for
/// the Wi-Fi-only setting. Switching a task between them goes through resume data. iOS keeps
/// downloading while the app is suspended or killed by the system and relaunches the app in the
/// background to deliver the results (AppDelegate's handleEventsForBackgroundURLSession).
///
/// Files land in `Application Support/arclight-downloads/<destName>`, excluded from iCloud
/// backup. The task list is persisted next to it so `listDownloads` survives relaunches.
final class DownloadManager: NSObject, URLSessionDownloadDelegate {
    static let shared = DownloadManager()

    static let folderName = "arclight-downloads"

    struct Record: Codable {
        var id: String
        var url: String
        var headers: [String: String]
        var destName: String
        var wifiOnly: Bool
        var title: String?
        var expectedBytes: Int64?
        var status: String
        var bytesWritten: Int64
        var totalBytes: Int64
        var path: String?
        var reason: String?
        var httpStatus: Int?
        var updatedAt: Double

        var js: [String: Any] {
            var d: [String: Any] = [
                "id": id,
                "status": status,
                "destName": destName,
                "bytesWritten": Int(bytesWritten),
                "totalBytes": Int(totalBytes),
            ]
            if let path = path { d["path"] = path }
            if let reason = reason { d["reason"] = reason }
            return d
        }
    }

    private let bundleId = Bundle.main.bundleIdentifier ?? "com.moviemethat.arclight"
    /// Created once in `start()` (a background session identifier must have a single session).
    private var anySession: URLSession!
    private var wifiSession: URLSession!
    private var sessionsReady = false

    /// All state below is touched on `queue` only.
    private let queue = DispatchQueue(label: "arclight.downloads")
    private var records: [String: Record] = [:]
    private var tasks: [String: URLSessionDownloadTask] = [:]
    /// Ids whose task we cancelled on purpose (pause / policy switch / cancel): not a failure.
    private var intentionallyCancelled: Set<String> = []
    /// Ids whose file was already moved in didFinishDownloadingTo (completion then is a no-op).
    private var finished: Set<String> = []
    private var lastProgressEmit: [String: Double] = [:]
    private var backgroundCompletions: [String: () -> Void] = [:]

    private let pathMonitor = NWPathMonitor()
    private var path: NWPath?

    private override init() {
        super.init()
    }

    // MARK: - Locations

    static var appSupport: URL {
        let url = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    static var folder: URL {
        var url = appSupport.appendingPathComponent(folderName, isDirectory: true)
        if !FileManager.default.fileExists(atPath: url.path) {
            try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        }
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
        return url
    }

    private var stateFile: URL { Self.appSupport.appendingPathComponent("arclight-downloads-state.json") }
    private var resumeFolder: URL {
        let url = Self.appSupport.appendingPathComponent("arclight-downloads-resume", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func resumeFile(_ id: String) -> URL {
        let safe = id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? UUID().uuidString
        return resumeFolder.appendingPathComponent(safe + ".resume")
    }

    /// Validates `destName` ("file.ext" or "folder/file.ext") and returns its URL in the folder.
    static func destination(for destName: String) throws -> URL {
        let parts = destName.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        let valid = !destName.isEmpty && !destName.hasPrefix("/") && parts.count <= 2 &&
            parts.allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." && !$0.contains("\\") }
        guard valid else { throw PlayerError(.invalid, "Bad destName: \(destName)") }
        let url = folder.appendingPathComponent(destName)
        guard url.standardizedFileURL.path.hasPrefix(folder.standardizedFileURL.path + "/") else {
            throw PlayerError(.invalid, "destName escapes the download folder")
        }
        return url
    }

    // MARK: - Start-up

    /// Creates both background sessions (reconnecting to tasks iOS kept running) and loads state.
    func start() {
        var first = false
        queue.sync {
            guard !sessionsReady else { return }
            sessionsReady = true
            first = true
            loadState()
            anySession = makeSession(wifiOnly: false)
            wifiSession = makeSession(wifiOnly: true)
        }
        guard first else { return }
        pathMonitor.pathUpdateHandler = { [weak self] path in
            guard let self = self else { return }
            self.queue.async {
                self.path = path
                self.refreshWaitingReasons()
            }
        }
        pathMonitor.start(queue: queue)
        reconcile()
    }

    private func makeSession(wifiOnly: Bool) -> URLSession {
        let id = wifiOnly ? "\(bundleId).downloads.wifi" : "\(bundleId).downloads"
        let config = URLSessionConfiguration.background(withIdentifier: id)
        config.sessionSendsLaunchEvents = true
        config.isDiscretionary = false
        config.allowsCellularAccess = !wifiOnly
        if wifiOnly {
            config.allowsExpensiveNetworkAccess = false
        }
        config.httpMaximumConnectionsPerHost = 3
        config.timeoutIntervalForResource = 7 * 24 * 3600
        let delegateQueue = OperationQueue()
        delegateQueue.maxConcurrentOperationCount = 1
        delegateQueue.underlyingQueue = queue
        return URLSession(configuration: config, delegate: self, delegateQueue: delegateQueue)
    }

    private func session(wifiOnly: Bool) -> URLSession { wifiOnly ? wifiSession : anySession }

    /// Matches persisted records with the tasks iOS still has; restarts what got lost.
    private func reconcile() {
        let group = DispatchGroup()
        var live: [URLSessionDownloadTask] = []
        let lock = NSLock()
        for session in [anySession, wifiSession] {
            group.enter()
            session.getAllTasks { all in
                lock.lock()
                live.append(contentsOf: all.compactMap { $0 as? URLSessionDownloadTask })
                lock.unlock()
                group.leave()
            }
        }
        group.notify(queue: queue) {
            for task in live {
                guard let id = task.taskDescription, self.records[id] != nil else {
                    task.cancel()
                    continue
                }
                if self.tasks[id] != nil && self.tasks[id] !== task {
                    task.cancel()
                    continue
                }
                self.tasks[id] = task
            }
            for (id, record) in self.records where (record.status == "queued" || record.status == "running" || record.status == "waiting") && self.tasks[id] == nil {
                self.startTask(id: id, preferResume: true)
            }
            self.saveState()
        }
    }

    func handleBackgroundEvents(identifier: String, completion: @escaping () -> Void) {
        queue.async {
            self.backgroundCompletions[identifier] = completion
        }
        start()
    }

    // MARK: - API (called from the plugin)

    func enqueue(_ request: DownloadRequest) throws -> [String: Any] {
        guard let url = URL(string: request.url), let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            throw PlayerError(.invalid, "Download URL must be http(s)")
        }
        let dest = try Self.destination(for: request.destName)
        start()
        return try queue.sync { () throws -> [String: Any] in
            if var existing = records[request.id] {
                if existing.status == "completed", let p = existing.path, FileManager.default.fileExists(atPath: p) {
                    return existing.js
                }
                if existing.status != "failed" && existing.status != "completed" {
                    return existing.js
                }
                // A failed (or completed-but-deleted) task enqueued again: retry it.
                existing.url = request.url
                existing.headers = request.headers
                existing.wifiOnly = request.wifiOnly
                existing.status = "queued"
                existing.reason = nil
                existing.httpStatus = nil
                existing.path = nil
                existing.updatedAt = nowMs()
                records[request.id] = existing
                startTask(id: request.id, preferResume: true)
                saveState()
                return records[request.id]?.js ?? existing.js
            }
            if let expected = request.expectedBytes, let free = freeBytes(), free < expected + 50 * 1024 * 1024 {
                throw PlayerError(.file, "Not enough free space for \(request.destName)")
            }
            _ = dest
            let record = Record(
                id: request.id, url: request.url, headers: request.headers, destName: request.destName,
                wifiOnly: request.wifiOnly, title: request.title, expectedBytes: request.expectedBytes,
                status: "queued", bytesWritten: 0, totalBytes: request.expectedBytes ?? -1,
                path: nil, reason: nil, httpStatus: nil, updatedAt: nowMs()
            )
            records[request.id] = record
            startTask(id: request.id, preferResume: false)
            saveState()
            return records[request.id]?.js ?? record.js
        }
    }

    func pause(id: String) throws {
        start()
        try queue.sync { () throws -> Void in
            guard var record = records[id] else { throw PlayerError(.invalid, "Unknown download \(id)") }
            guard record.status != "completed" else { return }
            record.status = "paused"
            record.reason = nil
            record.updatedAt = nowMs()
            records[id] = record
            if let task = tasks.removeValue(forKey: id) {
                intentionallyCancelled.insert(id)
                let file = resumeFile(id)
                task.cancel(byProducingResumeData: { data in
                    if let data = data { try? data.write(to: file, options: .atomic) }
                })
            }
            saveState()
        }
    }

    func resume(id: String) throws {
        start()
        try queue.sync { () throws -> Void in
            guard var record = records[id] else { throw PlayerError(.invalid, "Unknown download \(id)") }
            guard record.status == "paused" || record.status == "failed" else { return }
            record.status = "queued"
            record.reason = nil
            record.httpStatus = nil
            record.updatedAt = nowMs()
            records[id] = record
            startTask(id: id, preferResume: true)
            saveState()
        }
    }

    func cancel(id: String) {
        start()
        queue.sync {
            if let task = tasks.removeValue(forKey: id) {
                intentionallyCancelled.insert(id)
                task.cancel()
            }
            try? FileManager.default.removeItem(at: resumeFile(id))
            if let record = records.removeValue(forKey: id), record.status != "completed",
               let dest = try? Self.destination(for: record.destName) {
                // Only a partial / unfinished target; a completed file is removed by deleteDownload.
                try? FileManager.default.removeItem(at: dest)
            }
            saveState()
        }
    }

    func list() -> [[String: Any]] {
        start()
        return queue.sync {
            records.values.sorted { $0.updatedAt < $1.updatedAt }.map { $0.js }
        }
    }

    /// Deletes a downloaded file by `destName` or absolute path inside the folder.
    func delete(destName: String) throws {
        let folderPath = Self.folder.standardizedFileURL.path
        let target: URL
        if destName.hasPrefix("/") || destName.hasPrefix("file://") {
            guard let url = resolveMediaURL(destName), url.isFileURL,
                  url.standardizedFileURL.path.hasPrefix(folderPath + "/") else {
                throw PlayerError(.invalid, "Path is outside the download folder")
            }
            target = url
        } else {
            target = try Self.destination(for: destName)
        }
        if FileManager.default.fileExists(atPath: target.path) {
            do {
                try FileManager.default.removeItem(at: target)
            } catch {
                throw PlayerError(.file, "Could not delete \(target.lastPathComponent): \(error.localizedDescription)")
            }
        }
        // Remove an emptied server sub-folder.
        let parent = target.deletingLastPathComponent()
        if parent.standardizedFileURL.path != folderPath,
           let contents = try? FileManager.default.contentsOfDirectory(atPath: parent.path), contents.isEmpty {
            try? FileManager.default.removeItem(at: parent)
        }
        start()
        queue.sync {
            let targetPath = target.standardizedFileURL.path
            for (id, record) in records {
                let matches = (record.path.map { URL(fileURLWithPath: $0).standardizedFileURL.path == targetPath } ?? false)
                    || ((try? Self.destination(for: record.destName))?.standardizedFileURL.path == targetPath)
                if matches && (record.status == "completed" || record.status == "failed") {
                    records.removeValue(forKey: id)
                }
            }
            saveState()
        }
    }

    func storageInfo() -> [String: Any] {
        var used: Int64 = 0
        let folder = Self.folder
        if let e = FileManager.default.enumerator(at: folder, includingPropertiesForKeys: [.totalFileAllocatedSizeKey, .fileSizeKey, .isRegularFileKey]) {
            for case let url as URL in e {
                guard let v = try? url.resourceValues(forKeys: [.totalFileAllocatedSizeKey, .fileSizeKey, .isRegularFileKey]),
                      v.isRegularFile == true else { continue }
                used += Int64(v.totalFileAllocatedSize ?? v.fileSize ?? 0)
            }
        }
        return ["usedBytes": Int(used), "freeBytes": Int(freeBytes() ?? 0)]
    }

    /// Moves queued / running / waiting tasks to the session matching the new rule.
    func setPolicy(wifiOnly: Bool) {
        start()
        queue.sync {
            for (id, record) in records where record.wifiOnly != wifiOnly {
                guard record.status == "queued" || record.status == "running" || record.status == "waiting" || record.status == "paused" else {
                    continue
                }
                var r = record
                r.wifiOnly = wifiOnly
                records[id] = r
                guard record.status != "paused" else { continue }
                if let task = tasks.removeValue(forKey: id) {
                    intentionallyCancelled.insert(id)
                    let file = resumeFile(id)
                    task.cancel(byProducingResumeData: { [weak self] data in
                        guard let self = self else { return }
                        if let data = data { try? data.write(to: file, options: .atomic) }
                        self.queue.async {
                            if self.records[id]?.status != "paused" && self.records[id] != nil {
                                self.startTask(id: id, preferResume: true)
                                self.saveState()
                            }
                        }
                    })
                } else {
                    startTask(id: id, preferResume: true)
                }
            }
            refreshWaitingReasons()
            saveState()
        }
    }

    // MARK: - Tasks (on `queue`)

    private func startTask(id: String, preferResume: Bool) {
        guard var record = records[id], let url = URL(string: record.url) else { return }
        let urlSession: URLSession = self.session(wifiOnly: record.wifiOnly)
        var task: URLSessionDownloadTask?
        let resume = resumeFile(id)
        if preferResume, let data = try? Data(contentsOf: resume) {
            task = urlSession.downloadTask(withResumeData: data)
        }
        try? FileManager.default.removeItem(at: resume)
        if task == nil {
            var request = URLRequest(url: url)
            for (name, value) in record.headers {
                request.setValue(value, forHTTPHeaderField: name)
            }
            task = urlSession.downloadTask(with: request)
            record.bytesWritten = 0
        }
        guard let t = task else { return }
        t.taskDescription = id
        if let expected = record.expectedBytes { t.countOfBytesClientExpectsToReceive = expected }
        tasks[id] = t
        intentionallyCancelled.remove(id)
        finished.remove(id)
        record.status = waitingReason(for: record) == nil ? "queued" : "waiting"
        record.reason = waitingReason(for: record)
        record.updatedAt = nowMs()
        records[id] = record
        t.resume()
    }

    private func waitingReason(for record: Record) -> String? {
        guard let path = path else { return nil }
        if path.status != .satisfied { return "offline" }
        if record.wifiOnly && (path.isExpensive || path.usesInterfaceType(.cellular)) { return "wifi" }
        return nil
    }

    private func refreshWaitingReasons() {
        var changed = false
        for (id, record) in records where record.status == "queued" || record.status == "waiting" || record.status == "running" {
            let reason = waitingReason(for: record)
            var r = record
            if let reason = reason {
                r.status = "waiting"
                r.reason = reason
            } else if record.status == "waiting" {
                r.status = r.bytesWritten > 0 ? "running" : "queued"
                r.reason = nil
            }
            if r.status != record.status || r.reason != record.reason {
                records[id] = r
                changed = true
            }
        }
        if changed { saveState() }
    }

    private func freeBytes() -> Int64? {
        let values = try? Self.appSupport.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        return values?.volumeAvailableCapacityForImportantUsage
    }

    // MARK: - Persistence (on `queue`)

    private func loadState() {
        guard let data = try? Data(contentsOf: stateFile),
              let list = try? JSONDecoder().decode([Record].self, from: data) else { return }
        let weekAgo = nowMs() - 7 * 24 * 3600 * 1000
        for record in list {
            // Completed entries are kept a week for listDownloads, then forgotten (the file stays).
            if record.status == "completed" && record.updatedAt < weekAgo { continue }
            records[record.id] = record
        }
    }

    private func saveState() {
        let list = Array(records.values)
        guard let data = try? JSONEncoder().encode(list) else { return }
        try? data.write(to: stateFile, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        var url = stateFile
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
    }

    // MARK: - URLSessionDownloadDelegate (delegate queue runs on `queue`)

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard let id = downloadTask.taskDescription, var record = records[id] else { return }
        record.bytesWritten = totalBytesWritten
        record.totalBytes = totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : (record.expectedBytes ?? -1)
        if record.status != "running" {
            record.status = "running"
            record.reason = nil
        }
        record.updatedAt = nowMs()
        records[id] = record
        let now = nowMs()
        if now - (lastProgressEmit[id] ?? 0) >= 500 {
            lastProgressEmit[id] = now
            PlayerEventHub.shared.emit("downloadProgress", [
                "id": id, "bytesWritten": Int(record.bytesWritten), "totalBytes": Int(record.totalBytes),
            ])
        }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didResumeAtOffset fileOffset: Int64, expectedTotalBytes: Int64) {
        guard let id = downloadTask.taskDescription, var record = records[id] else { return }
        record.bytesWritten = fileOffset
        if expectedTotalBytes > 0 { record.totalBytes = expectedTotalBytes }
        records[id] = record
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let id = downloadTask.taskDescription, var record = records[id] else { return }
        let status = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 200
        finished.insert(id)
        tasks.removeValue(forKey: id)
        lastProgressEmit.removeValue(forKey: id)
        guard (200..<300).contains(status) else {
            // The body is an error page: drop it.
            try? FileManager.default.removeItem(at: location)
            let retryable = status >= 500 || status == 429 || status == 408
            fail(&record, message: "Server answered HTTP \(status)", httpStatus: status, retryable: retryable)
            return
        }
        do {
            let dest = try Self.destination(for: record.destName)
            let fm = FileManager.default
            try fm.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
            if fm.fileExists(atPath: dest.path) { try fm.removeItem(at: dest) }
            try fm.moveItem(at: location, to: dest)
            var target = dest
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try? target.setResourceValues(values)
            let size = (try? fm.attributesOfItem(atPath: dest.path)[.size] as? NSNumber)?.int64Value ?? record.bytesWritten
            record.status = "completed"
            record.path = dest.path
            record.bytesWritten = size
            record.totalBytes = size
            record.reason = nil
            record.updatedAt = nowMs()
            records[id] = record
            saveState()
            PlayerEventHub.shared.emit("downloadCompleted", [
                "id": id, "path": dest.path, "uri": dest.absoluteString, "sizeBytes": Int(size),
            ], retain: true)
        } catch {
            try? FileManager.default.removeItem(at: location)
            fail(&record, message: "Could not save the file: \(error.localizedDescription)", httpStatus: nil, retryable: false)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let id = task.taskDescription else { return }
        if finished.remove(id) != nil { return }
        if intentionallyCancelled.contains(id) {
            if tasks[id] === task || tasks[id] == nil { intentionallyCancelled.remove(id) }
            return
        }
        guard var record = records[id] else { return }
        if let current = tasks[id], current !== task { return }
        tasks.removeValue(forKey: id)
        lastProgressEmit.removeValue(forKey: id)
        guard let error = error else { return }
        let ns = error as NSError
        if let data = ns.userInfo[NSURLSessionDownloadTaskResumeData] as? Data {
            try? data.write(to: resumeFile(id), options: .atomic)
        }
        if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled {
            // Cancelled by the system (e.g. the app was force-quit): start again from the resume data.
            records[id] = record
            startTask(id: id, preferResume: true)
            saveState()
            return
        }
        let retryable = ns.domain == NSURLErrorDomain && [
            NSURLErrorTimedOut, NSURLErrorNetworkConnectionLost, NSURLErrorNotConnectedToInternet,
            NSURLErrorCannotConnectToHost, NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed,
            NSURLErrorInternationalRoamingOff, NSURLErrorDataNotAllowed, NSURLErrorBackgroundSessionWasDisconnected,
        ].contains(ns.code)
        fail(&record, message: error.localizedDescription, httpStatus: nil, retryable: retryable)
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        guard let id = session.configuration.identifier, let completion = backgroundCompletions.removeValue(forKey: id) else { return }
        DispatchQueue.main.async { completion() }
    }

    private func fail(_ record: inout Record, message: String, httpStatus: Int?, retryable: Bool) {
        record.status = "failed"
        record.reason = message
        record.httpStatus = httpStatus
        record.updatedAt = nowMs()
        records[record.id] = record
        saveState()
        var data: [String: Any] = ["id": record.id, "message": message, "retryable": retryable]
        if let s = httpStatus { data["httpStatus"] = s }
        PlayerEventHub.shared.emit("downloadFailed", data, retain: true)
    }
}
