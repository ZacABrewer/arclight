import { registerPlugin } from '@capacitor/core';

/**
 * App-local Keychain store for device tokens on iOS (ios/App/App/TokenVaultPlugin.swift):
 * readable after the first unlock, this device only (no iCloud Keychain, no restore onto another
 * phone). Android keeps tokens in Keystore-backed storage through the biometric plugin.
 */
export interface ArclightVaultPlugin {
  get(options: { id: string }): Promise<{ value?: string | null }>;
  set(options: { id: string; value: string }): Promise<void>;
  remove(options: { id: string }): Promise<void>;
}

export const ArclightVault = registerPlugin<ArclightVaultPlugin>('ArclightVault');
