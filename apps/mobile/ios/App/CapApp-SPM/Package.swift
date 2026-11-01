// swift-tools-version: 5.9
import PackageDescription

// DO NOT MODIFY THIS FILE - managed by Capacitor CLI commands
let package = Package(
    name: "CapApp-SPM",
    platforms: [.iOS(.v16)],
    products: [
        .library(
            name: "CapApp-SPM",
            targets: ["CapApp-SPM"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.6.0"),
        .package(name: "CapacitorApp", path: "../../../../../node_modules/.pnpm/@capacitor+app@8.1.2_@capacitor+core@8.6.0/node_modules/@capacitor/app"),
        .package(name: "CapacitorBarcodeScanner", path: "../../../../../node_modules/.pnpm/@capacitor+barcode-scanner@3.1.3_@capacitor+core@8.6.0/node_modules/@capacitor/barcode-scanner"),
        .package(name: "CapacitorBrowser", path: "../../../../../node_modules/.pnpm/@capacitor+browser@8.0.5_@capacitor+core@8.6.0/node_modules/@capacitor/browser"),
        .package(name: "CapacitorDevice", path: "../../../../../node_modules/.pnpm/@capacitor+device@8.0.3_@capacitor+core@8.6.0/node_modules/@capacitor/device"),
        .package(name: "CapacitorHaptics", path: "../../../../../node_modules/.pnpm/@capacitor+haptics@8.0.2_@capacitor+core@8.6.0/node_modules/@capacitor/haptics"),
        .package(name: "CapacitorPreferences", path: "../../../../../node_modules/.pnpm/@capacitor+preferences@8.0.1_@capacitor+core@8.6.0/node_modules/@capacitor/preferences"),
        .package(name: "CapacitorPushNotifications", path: "../../../../../node_modules/.pnpm/@capacitor+push-notifications@8.1.3_@capacitor+core@8.6.0/node_modules/@capacitor/push-notifications"),
        .package(name: "CapacitorSplashScreen", path: "../../../../../node_modules/.pnpm/@capacitor+splash-screen@8.0.2_@capacitor+core@8.6.0/node_modules/@capacitor/splash-screen"),
        .package(name: "CapacitorStatusBar", path: "../../../../../node_modules/.pnpm/@capacitor+status-bar@8.0.4_@capacitor+core@8.6.0/node_modules/@capacitor/status-bar"),
        .package(name: "CapgoCapacitorNativeBiometric", path: "../../../../../node_modules/.pnpm/@capgo+capacitor-native-bio_7b116890cf1c8638620e7f3b4ea2e056/node_modules/@capgo/capacitor-native-biometric"),
        .package(name: "CapgoCapacitorShareTarget", path: "../../../../../node_modules/.pnpm/@capgo+capacitor-share-target@8.0.64_@capacitor+core@8.6.0/node_modules/@capgo/capacitor-share-target")
    ],
    targets: [
        .target(
            name: "CapApp-SPM",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "CapacitorApp", package: "CapacitorApp"),
                .product(name: "CapacitorBarcodeScanner", package: "CapacitorBarcodeScanner"),
                .product(name: "CapacitorBrowser", package: "CapacitorBrowser"),
                .product(name: "CapacitorDevice", package: "CapacitorDevice"),
                .product(name: "CapacitorHaptics", package: "CapacitorHaptics"),
                .product(name: "CapacitorPreferences", package: "CapacitorPreferences"),
                .product(name: "CapacitorPushNotifications", package: "CapacitorPushNotifications"),
                .product(name: "CapacitorSplashScreen", package: "CapacitorSplashScreen"),
                .product(name: "CapacitorStatusBar", package: "CapacitorStatusBar"),
                .product(name: "CapgoCapacitorNativeBiometric", package: "CapgoCapacitorNativeBiometric"),
                .product(name: "CapgoCapacitorShareTarget", package: "CapgoCapacitorShareTarget")
            ]
        )
    ]
)
