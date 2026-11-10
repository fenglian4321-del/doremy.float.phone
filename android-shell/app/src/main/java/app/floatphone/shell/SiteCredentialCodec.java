package app.floatphone.shell;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Ciphertext only; origin+realm are authenticated, never a WebView auth DB. */
public final class SiteCredentialCodec {
    private SiteCredentialCodec() {}
    private static byte[] aad(String origin, String realm) {
        if (origin == null || !origin.startsWith("https://") || origin.length() > 512 || !validRealm(realm)) throw new IllegalArgumentException("invalid_scope");
        return ("float-site-login/v1\0" + origin + "\0" + realm).getBytes(StandardCharsets.UTF_8);
    }
    public static boolean validRealm(String realm) {
        if (realm == null || realm.length() > 256) return false;
        for (int i = 0; i < realm.length(); i++) if (realm.charAt(i) < 32 || realm.charAt(i) == 127) return false;
        return true;
    }
    public static String encrypt(SecretKey key, String origin, String realm, byte[] plaintext) throws GeneralSecurityException {
        if (plaintext.length < 1 || plaintext.length > 8192) throw new IllegalArgumentException("invalid_size");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key); cipher.updateAAD(aad(origin, realm));
        byte[] encrypted = cipher.doFinal(plaintext), iv = cipher.getIV();
        if (iv.length != 12) throw new GeneralSecurityException("invalid_iv");
        return Base64.getEncoder().encodeToString(ByteBuffer.allocate(1 + iv.length + encrypted.length).put((byte) 1).put(iv).put(encrypted).array());
    }
    public static byte[] decrypt(SecretKey key, String origin, String realm, String encoded) throws GeneralSecurityException {
        if (encoded == null || encoded.length() > 12000) throw new IllegalArgumentException("invalid_size");
        byte[] bytes = Base64.getDecoder().decode(encoded);
        if (bytes.length < 30 || bytes[0] != 1) throw new IllegalArgumentException("invalid_envelope");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, bytes, 1, 12)); cipher.updateAAD(aad(origin, realm));
        return cipher.doFinal(bytes, 13, bytes.length - 13);
    }
}
