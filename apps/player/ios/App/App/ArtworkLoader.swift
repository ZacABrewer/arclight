import UIKit

/// Loads cover images for the lock screen and CarPlay: http(s) URLs (with the request headers JS
/// gives, e.g. `Authorization: Bearer ...`) and local files. Small in-memory cache; callbacks
/// run on the main thread.
final class ArtworkLoader {
    static let shared = ArtworkLoader()

    private let cache = NSCache<NSString, UIImage>()
    private let session: URLSession
    private var waiting: [String: [(UIImage?) -> Void]] = [:]

    private init() {
        cache.countLimit = 120
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 20
        config.requestCachePolicy = .returnCacheDataElseLoad
        config.urlCache = URLCache(memoryCapacity: 8 * 1024 * 1024, diskCapacity: 64 * 1024 * 1024, diskPath: "arclight-artwork")
        session = URLSession(configuration: config)
    }

    func cached(_ urlString: String?) -> UIImage? {
        guard let urlString = urlString else { return nil }
        return cache.object(forKey: urlString as NSString)
    }

    func load(_ urlString: String?, headers: [String: String]?, completion: @escaping (UIImage?) -> Void) {
        guard let urlString = urlString, let url = resolveMediaURL(urlString) else {
            onMain { completion(nil) }
            return
        }
        if let image = cache.object(forKey: urlString as NSString) {
            onMain { completion(image) }
            return
        }
        onMain {
            if self.waiting[urlString] != nil {
                self.waiting[urlString]?.append(completion)
                return
            }
            self.waiting[urlString] = [completion]
            self.fetch(url, key: urlString, headers: headers ?? [:])
        }
    }

    private func fetch(_ url: URL, key: String, headers: [String: String]) {
        if url.isFileURL {
            DispatchQueue.global(qos: .utility).async {
                let image = UIImage(contentsOfFile: url.path)
                self.finish(key, image)
            }
            return
        }
        var request = URLRequest(url: url)
        for (name, value) in headers {
            request.setValue(value, forHTTPHeaderField: name)
        }
        session.dataTask(with: request) { data, response, _ in
            var image: UIImage?
            if let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode), let data = data {
                image = UIImage(data: data)
            }
            self.finish(key, image)
        }.resume()
    }

    private func finish(_ key: String, _ image: UIImage?) {
        onMain {
            if let image = image { self.cache.setObject(image, forKey: key as NSString) }
            let callbacks = self.waiting.removeValue(forKey: key) ?? []
            for cb in callbacks { cb(image) }
        }
    }
}
