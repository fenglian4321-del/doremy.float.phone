import app.floatphone.shell.SiteCredentialCodec;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.Arrays;
import java.util.Base64;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;

public final class SiteCredentialCodecTest {
    private static int checks;
    private static void check(boolean ok) { checks++; if (!ok) throw new AssertionError("credential scope/integrity check failed"); }
    private interface Attempt { void run() throws Exception; }
    private static void rejects(Attempt attempt) throws Exception { checks++; try { attempt.run(); } catch (GeneralSecurityException | IllegalArgumentException expected) { return; } throw new AssertionError("invalid credential envelope accepted"); }
    public static void main(String[] args) throws Exception {
        KeyGenerator generator = KeyGenerator.getInstance("AES"); generator.init(256);
        SecretKey key = generator.generateKey(), other = generator.generateKey();
        String origin = "https://float.example", realm = "restricted";
        byte[] plain = "{\"username\":\"SYNTHETIC_ACCOUNT\",\"password\":\"SYNTHETIC_PASSWORD_仅测试\"}".getBytes(StandardCharsets.UTF_8);
        String encoded = SiteCredentialCodec.encrypt(key, origin, realm, plain);
        check(Arrays.equals(plain, SiteCredentialCodec.decrypt(key, origin, realm, encoded)));
        check(!encoded.contains("SYNTHETIC"));
        check(!encoded.equals(SiteCredentialCodec.encrypt(key, origin, realm, plain)));
        rejects(() -> SiteCredentialCodec.decrypt(other, origin, realm, encoded));
        rejects(() -> SiteCredentialCodec.decrypt(key, "https://other.example", realm, encoded));
        rejects(() -> SiteCredentialCodec.decrypt(key, "https://float.example:444", realm, encoded));
        rejects(() -> SiteCredentialCodec.decrypt(key, origin, "another-realm", encoded));
        rejects(() -> SiteCredentialCodec.decrypt(key, "http://float.example", realm, encoded));
        byte[] altered = Base64.getDecoder().decode(encoded); altered[altered.length - 1] ^= 1;
        rejects(() -> SiteCredentialCodec.decrypt(key, origin, realm, Base64.getEncoder().encodeToString(altered)));
        rejects(() -> SiteCredentialCodec.decrypt(key, origin, realm, "garbage%%"));
        rejects(() -> SiteCredentialCodec.decrypt(key, origin, realm, "A".repeat(12001)));
        rejects(() -> SiteCredentialCodec.encrypt(key, origin, realm, new byte[0]));
        rejects(() -> SiteCredentialCodec.encrypt(key, origin, realm, new byte[8193]));
        for (String value : new String[]{"", "中文领域", "realm_with-space"}) check(SiteCredentialCodec.validRealm(value));
        for (String value : new String[]{"a\nb", "a\u0000b", "x".repeat(257)}) check(!SiteCredentialCodec.validRealm(value));
        byte[] max = new byte[8192]; Arrays.fill(max, (byte) 42);
        check(Arrays.equals(max, SiteCredentialCodec.decrypt(key, origin, realm, SiteCredentialCodec.encrypt(key, origin, realm, max))));
        System.out.println("Remembered login: " + checks + " AES-GCM encryption, random nonce, origin/port/realm AAD, tamper/wrong-key and size checks passed; Android Keystore/device lifecycle still requires device testing.");
    }
}
