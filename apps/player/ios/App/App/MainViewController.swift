import UIKit
import Capacitor

/// The app's bridge view controller (set as the custom class in Main.storyboard).
/// Registers the app-local ArclightPlayer plugin, which is not an npm package.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(ArclightPlayerPlugin())
    }
}
