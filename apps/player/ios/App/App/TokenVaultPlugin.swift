import Foundation
import Security
import Capacitor

/// Native side of the app-local "ArclightVault" plugin (apps/player/src/native/vault.ts).
///
/// Keeps each account's device token in the Keychain as a generic password that is readable
/// after the first unlock (so background playback can still reach the server while the phone is
/// locked) and never leaves this device: no iCloud Keychain sync, not restored from a backup
/// onto another phone. Tokens saved by earlier versions (through the biometric plugin) are moved
/// here by the JS side the first time they are read.
@objc(TokenVaultPlugin)
public class TokenVaultPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TokenVaultPlugin"
    public let jsName = "ArclightVault"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
    ]

    private static let service = "com.moviemethat.arclight.tokens"

    private func itemQuery(_ id: String) -> [String: Any] {
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: TokenVaultPlugin.service,
            kSecAttrAccount as String: id,
            kSecAttrSynchronizable as String: false,
        ]
    }

    /// The account id ("a_<hex>"), or nil after rejecting the call.
    private func accountId(_ call: CAPPluginCall) -> String? {
        guard let id = call.getString("id"), !id.isEmpty, id.count <= 64 else {
            call.reject("Missing account id")
            return nil
        }
        return id
    }

    @objc func get(_ call: CAPPluginCall) {
        guard let id = accountId(call) else { return }
        var query = itemQuery(id)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound {
            call.resolve([:])
            return
        }
        guard status == errSecSuccess, let data = item as? Data, let value = String(data: data, encoding: .utf8) else {
            call.reject("Keychain read failed (\(status))")
            return
        }
        call.resolve(["value": value])
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let id = accountId(call) else { return }
        guard let value = call.getString("value"), !value.isEmpty, let data = value.data(using: .utf8) else {
            call.reject("Missing value")
            return
        }
        // Replace, so the accessibility class is always the one below.
        SecItemDelete(itemQuery(id) as CFDictionary)
        var attributes = itemQuery(id)
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else {
            call.reject("Keychain write failed (\(status))")
            return
        }
        call.resolve()
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let id = accountId(call) else { return }
        let status = SecItemDelete(itemQuery(id) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            call.reject("Keychain delete failed (\(status))")
            return
        }
        call.resolve()
    }
}
