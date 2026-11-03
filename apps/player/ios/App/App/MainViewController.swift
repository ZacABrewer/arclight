import UIKit
import Capacitor

/// The app's bridge view controller (set as the custom class in Main.storyboard).
/// Registers the app-local plugins (ArclightPlayer and ArclightVault), which are not npm packages.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(ArclightPlayerPlugin())
        bridge?.registerPluginInstance(TokenVaultPlugin())
    }
}
