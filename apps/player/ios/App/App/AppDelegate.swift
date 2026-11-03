import UIKit
import CarPlay
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Reconnect to the background download sessions early: iOS may have relaunched the app
        // in the background just to deliver finished downloads.
        DownloadManager.shared.start()
        return true
    }

    /// A background download session has events for us (the app may have been relaunched for
    /// them). DownloadManager calls `completionHandler` once it has processed them all.
    func application(_ application: UIApplication,
                     handleEventsForBackgroundURLSession identifier: String,
                     completionHandler: @escaping () -> Void) {
        DownloadManager.shared.handleBackgroundEvents(identifier: identifier, completion: completionHandler)
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        if connectingSceneSession.role == UISceneSession.Role.carTemplateApplication {
            // Only reached in builds signed with the CarPlay audio entitlement.
            let config = UISceneConfiguration(name: "CarPlay Configuration",
                                              sessionRole: connectingSceneSession.role)
            config.sceneClass = CPTemplateApplicationScene.self
            config.delegateClass = CarPlaySceneDelegate.self
            return config
        }
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}
