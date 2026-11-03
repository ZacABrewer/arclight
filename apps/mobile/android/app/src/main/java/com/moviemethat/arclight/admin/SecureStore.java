package com.moviemethat.arclight.admin;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Small secrets (push relay device credentials) scoped by server origin, encrypted with an
 * AES-GCM key held in the Android Keystore. The key never leaves the Keystore and is not part of
 * a backup, so restored data simply reads as absent (the server re-registers for push).
 * The entry name is bound to the ciphertext (GCM associated data), so a value cannot be moved
 * from one server's scope to another's.
 */
final class SecureStore {

    private static final String PREFS = "ArclightSecure";
    private static final String KEY_ALIAS = "arclight.secure.v1";
    private static final int IV_BYTES = 12;

    private final SharedPreferences prefs;

    SecureStore(Context context) {
        prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static String entry(String scope, String key) {
        return Base64.encodeToString((scope + "\n" + key).getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP | Base64.URL_SAFE);
    }

    private static SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        KeyStore.Entry e = ks.getEntry(KEY_ALIAS, null);
        if (e instanceof KeyStore.SecretKeyEntry) return ((KeyStore.SecretKeyEntry) e).getSecretKey();
        KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        gen.init(
            new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        );
        return gen.generateKey();
    }

    synchronized String get(String scope, String key) {
        String name = entry(scope, key);
        String stored = prefs.getString(name, null);
        if (stored == null) return null;
        try {
            byte[] all = Base64.decode(stored, Base64.NO_WRAP);
            if (all.length <= IV_BYTES) return null;
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, all, 0, IV_BYTES));
            c.updateAAD(name.getBytes(StandardCharsets.UTF_8));
            return new String(c.doFinal(all, IV_BYTES, all.length - IV_BYTES), StandardCharsets.UTF_8);
        } catch (Exception e) {
            // Key gone (restored backup, Keystore reset) or tampered data: treat as absent.
            prefs.edit().remove(name).apply();
            return null;
        }
    }

    synchronized void set(String scope, String key, String value) throws Exception {
        String name = entry(scope, key);
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, key());
        c.updateAAD(name.getBytes(StandardCharsets.UTF_8));
        byte[] ct = c.doFinal(value.getBytes(StandardCharsets.UTF_8));
        byte[] iv = c.getIV();
        byte[] all = ByteBuffer.allocate(iv.length + ct.length).put(iv).put(ct).array();
        prefs.edit().putString(name, Base64.encodeToString(all, Base64.NO_WRAP)).apply();
    }

    synchronized void remove(String scope, String key) {
        prefs.edit().remove(entry(scope, key)).apply();
    }
}
