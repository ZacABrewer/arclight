import CarPlay
import UIKit

/// The CarPlay scene (role CPTemplateApplicationSceneSessionRoleApplication in Info.plist).
///
/// It only connects when the app is signed with the com.apple.developer.carplay-audio
/// entitlement (see CARPLAY_ENABLED in the Xcode project and ios/README.md); without it iOS never
/// offers the app to CarPlay and this class stays unused.
class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
    func templateApplicationScene(_ templateApplicationScene: CPTemplateApplicationScene,
                                  didConnect interfaceController: CPInterfaceController) {
        CarPlayController.shared.connect(interfaceController)
    }

    func templateApplicationScene(_ templateApplicationScene: CPTemplateApplicationScene,
                                  didDisconnectInterfaceController interfaceController: CPInterfaceController) {
        CarPlayController.shared.disconnect()
    }
}

/// Builds the CarPlay audio UI: a tab bar (Continue, Music, Books, Downloads), lists filled from
/// JS through `browseRequest` / `answerBrowse` (5 s timeout) with the persisted `setBrowseTree`
/// cache as the fallback, and the system Now Playing screen. Main thread only.
final class CarPlayController: NSObject {
    static let shared = CarPlayController()

    static let browseTimeout: TimeInterval = 5

    /// True when this build was made with CARPLAY_ENABLED=YES (Info.plist ArclightCarPlayEnabled).
    static var enabledInBuild: Bool {
        let value = (Bundle.main.object(forInfoDictionaryKey: "ArclightCarPlayEnabled") as? String) ?? "NO"
        return value.uppercased() == "YES"
    }

    private struct PendingBrowse {
        let parentId: String
        let update: ([BrowseNode]) -> Void
        let timeout: DispatchWorkItem
    }

    private var interface: CPInterfaceController?
    private var tree: BrowseTree?
    private var pending: [String: PendingBrowse] = [:]
    /// Root tabs and the node each shows, refreshed when JS sends a new tree.
    private var tabLists: [(parentId: String, template: CPListTemplate)] = []
    /// A row was picked to play: show Now Playing once playback starts.
    private var awaitingPlayback = false

    private override init() {
        super.init()
    }

    var isConnected: Bool { interface != nil }

    // MARK: - Connection

    func connect(_ interfaceController: CPInterfaceController) {
        interface = interfaceController
        let nowPlaying = CPNowPlayingTemplate.shared
        nowPlaying.isUpNextButtonEnabled = false
        nowPlaying.isAlbumArtistButtonEnabled = false

        tabLists.removeAll()
        let rootNodes = cachedChildren("root") ?? []
        func title(_ id: String, _ fallback: String) -> String {
            rootNodes.first(where: { $0.id == id })?.title ?? fallback
        }

        let continueTab = makeTab(parentId: "continue", title: title("continue", "Continue"), symbol: "clock.arrow.circlepath")
        let musicTab = makeMusicTab(albums: title("albums", "Albums"), artists: title("artists", "Artists"), playlists: title("playlists", "Playlists"))
        let booksTab = makeTab(parentId: "books", title: title("books", "Books"), symbol: "book")
        let downloadsTab = makeTab(parentId: "downloads", title: title("downloads", "Downloads"), symbol: "arrow.down.circle")

        let tabBar = CPTabBarTemplate(templates: [continueTab, musicTab, booksTab, downloadsTab])
        interfaceController.setRootTemplate(tabBar, animated: false, completion: nil)
        PlayerEventHub.shared.emit("carConnection", ["connected": true, "kind": "carplay"])
    }

    func disconnect() {
        interface = nil
        tabLists.removeAll()
        for (_, p) in pending { p.timeout.cancel() }
        pending.removeAll()
        awaitingPlayback = false
        PlayerEventHub.shared.emit("carConnection", ["connected": false, "kind": "carplay"])
    }

    // MARK: - Templates

    private func makeTab(parentId: String, title: String, symbol: String) -> CPListTemplate {
        let template = CPListTemplate(title: title, sections: [])
        template.tabTitle = title
        template.tabImage = UIImage(systemName: symbol)
        tabLists.append((parentId, template))
        fill(template, parentId: parentId, parentNode: nil)
        return template
    }

    private func makeMusicTab(albums: String, artists: String, playlists: String) -> CPListTemplate {
        let rows = [
            BrowseNode(id: "albums", title: albums, browsable: true, playable: false),
            BrowseNode(id: "artists", title: artists, browsable: true, playable: false),
            BrowseNode(id: "playlists", title: playlists, browsable: true, playable: false),
        ]
        let items = rows.map { node -> CPListItem in
            let item = CPListItem(text: node.title, detailText: nil, image: nil)
            item.accessoryType = .disclosureIndicator
            item.handler = { [weak self] _, completion in
                self?.open(node, parentId: "music")
                completion()
            }
            return item
        }
        let template = CPListTemplate(title: "Music", sections: [CPListSection(items: items)])
        template.tabTitle = "Music"
        template.tabImage = UIImage(systemName: "music.note")
        return template
    }

    /// Fills `template` with the children of `parentId`: cache first, then JS's answer.
    private func fill(_ template: CPListTemplate, parentId: String, parentNode: BrowseNode?) {
        template.emptyViewTitleVariants = ["Loading…"]
        template.emptyViewSubtitleVariants = []
        children(of: parentId) { [weak self, weak template] nodes in
            guard let self = self, let template = template else { return }
            template.emptyViewTitleVariants = ["Nothing here yet"]
            template.emptyViewSubtitleVariants = ["Open Arclight on your iPhone to load your library."]
            template.updateSections(self.sections(for: nodes, parentId: parentId, parentNode: parentNode))
        }
    }

    private func sections(for nodes: [BrowseNode], parentId: String, parentNode: BrowseNode?) -> [CPListSection] {
        var items: [CPListItem] = []
        if let parent = parentNode, parent.playable, !nodes.isEmpty {
            let playAll = CPListItem(text: "Play", detailText: parent.title, image: UIImage(systemName: "play.fill"))
            playAll.handler = { [weak self] _, completion in
                self?.play(parent, parentId: parentId)
                completion()
            }
            items.append(playAll)
        }
        let limit = max(1, CPListTemplate.maximumItemCount - items.count)
        for node in nodes.prefix(limit) {
            items.append(makeItem(node, parentId: parentId))
        }
        return items.isEmpty ? [] : [CPListSection(items: items)]
    }

    private func makeItem(_ node: BrowseNode, parentId: String) -> CPListItem {
        let cached = ArtworkLoader.shared.cached(node.artworkUrl).map(Self.fit)
        let item = CPListItem(text: node.title, detailText: node.subtitle, image: cached)
        if node.browsable { item.accessoryType = .disclosureIndicator }
        if let progress = node.progress { item.playbackProgress = CGFloat(progress) }
        item.handler = { [weak self] _, completion in
            self?.open(node, parentId: parentId)
            completion()
        }
        if cached == nil, let url = node.artworkUrl {
            ArtworkLoader.shared.load(url, headers: node.artworkHeaders) { [weak item] image in
                guard let item = item, let image = image else { return }
                item.setImage(Self.fit(image))
            }
        }
        return item
    }

    private static func fit(_ image: UIImage) -> UIImage {
        let maxSize = CPListItem.maximumImageSize
        guard maxSize.width > 0, maxSize.height > 0,
              image.size.width > maxSize.width || image.size.height > maxSize.height else { return image }
        let scale = min(maxSize.width / image.size.width, maxSize.height / image.size.height)
        let size = CGSize(width: floor(image.size.width * scale), height: floor(image.size.height * scale))
        let format = UIGraphicsImageRendererFormat.default()
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
    }

    private func open(_ node: BrowseNode, parentId: String) {
        if node.browsable {
            guard let interface = interface else { return }
            let template = CPListTemplate(title: node.title, sections: [])
            fill(template, parentId: node.id, parentNode: node)
            interface.pushTemplate(template, animated: true, completion: nil)
        } else if node.playable {
            play(node, parentId: parentId)
        }
    }

    private func play(_ node: BrowseNode, parentId: String) {
        let hub = PlayerEventHub.shared
        guard hub.hasListeners("browsePlay") else {
            showAlert("Open Arclight on your iPhone to start playing.")
            return
        }
        awaitingPlayback = true
        hub.emit("browsePlay", ["nodeId": node.id, "parentId": parentId])
        showNowPlaying()
    }

    private func showNowPlaying() {
        guard let interface = interface else { return }
        let nowPlaying = CPNowPlayingTemplate.shared
        if interface.topTemplate === nowPlaying { return }
        interface.pushTemplate(nowPlaying, animated: true, completion: nil)
    }

    private func showAlert(_ message: String) {
        guard let interface = interface, interface.presentedTemplate == nil else { return }
        let ok = CPAlertAction(title: "OK", style: .cancel) { [weak interface] _ in
            interface?.dismissTemplate(animated: true, completion: nil)
        }
        let alert = CPAlertTemplate(titleVariants: [message], actions: [ok])
        interface.presentTemplate(alert, animated: true, completion: nil)
    }

    /// Called by the audio engine on every status change.
    func playbackStateChanged() {
        guard awaitingPlayback, isConnected else { return }
        let status = AudioEngine.shared.status
        if status == .playing || status == .loading || status == .buffering {
            awaitingPlayback = false
            showNowPlaying()
        } else if status == .error {
            awaitingPlayback = false
        }
    }

    // MARK: - Browse data

    /// Calls `update` with the cached children right away (when cached), then with JS's answer;
    /// with no answer within the timeout and nothing cached, with an empty list.
    func children(of parentId: String, update: @escaping ([BrowseNode]) -> Void) {
        let cached = cachedChildren(parentId)
        if let cached = cached { update(cached) }
        let hub = PlayerEventHub.shared
        guard hub.hasListeners("browseRequest") else {
            if cached == nil { update([]) }
            return
        }
        let requestId = UUID().uuidString
        let timeout = DispatchWorkItem { [weak self] in
            guard let self = self, self.pending.removeValue(forKey: requestId) != nil else { return }
            if cached == nil { update(self.cachedChildren(parentId) ?? []) }
        }
        pending[requestId] = PendingBrowse(parentId: parentId, update: update, timeout: timeout)
        hub.emit("browseRequest", ["requestId": requestId, "parentId": parentId])
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.browseTimeout, execute: timeout)
    }

    /// `answerBrowse` from JS.
    func answer(requestId: String, items: [BrowseNode]) {
        guard let p = pending.removeValue(forKey: requestId) else { return }
        p.timeout.cancel()
        var t = loadTree()
        if p.parentId == "root" {
            t.root = items
        } else {
            t.children[p.parentId] = items
        }
        tree = t
        saveTree()
        p.update(items)
    }

    /// `setBrowseTree` from JS.
    func setTree(_ newTree: BrowseTree) {
        tree = newTree
        saveTree()
        // Refresh the tabs from the new cache (no new round trip to JS).
        for (parentId, template) in tabLists {
            if let nodes = cachedChildren(parentId) {
                template.updateSections(sections(for: nodes, parentId: parentId, parentNode: nil))
            }
        }
    }

    private func cachedChildren(_ parentId: String) -> [BrowseNode]? {
        let t = loadTree()
        if parentId == "root" { return t.root.isEmpty ? nil : t.root }
        return t.children[parentId]
    }

    // MARK: - Persistence

    private var treeFile: URL {
        DownloadManager.appSupport.appendingPathComponent("carplay-browse-tree.json")
    }

    private func loadTree() -> BrowseTree {
        if let tree = tree { return tree }
        var loaded = BrowseTree.empty
        if let data = try? Data(contentsOf: treeFile), let decoded = try? JSONDecoder().decode(BrowseTree.self, from: data) {
            loaded = decoded
        }
        tree = loaded
        return loaded
    }

    private func saveTree() {
        guard let tree = tree, let data = try? JSONEncoder().encode(tree) else { return }
        let file = treeFile
        DispatchQueue.global(qos: .utility).async {
            try? data.write(to: file, options: [.atomic])
        }
    }
}
