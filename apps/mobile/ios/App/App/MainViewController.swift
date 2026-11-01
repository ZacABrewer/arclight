import Capacitor
import UIKit

/// The app's bridge view controller: registers the app-local ArclightNative plugin.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(ArclightNativePlugin())
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }
}
