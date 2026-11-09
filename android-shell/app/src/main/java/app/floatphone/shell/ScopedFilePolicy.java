package app.floatphone.shell;

import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;

/** Platform-free constraints: compiled and executed without an Android SDK. */
public final class ScopedFilePolicy {
    public static final int MAX_BYTES = 32768;
    private ScopedFilePolicy() {}
    public static String id(String value) {
        if (value == null || !value.matches("[A-Za-z0-9_-]{1,100}")) throw new IllegalArgumentException("invalid_id");
        return value;
    }
    public static String mode(String value) {
        if (!"work".equals(value) && !"private".equals(value)) throw new IllegalArgumentException("invalid_scope");
        return value;
    }
    private static void characters(String text) {
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if ((c < 32 && c != '\n' && c != '\r' && c != '\t') || c == 127 || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) throw new IllegalArgumentException("invalid_text");
            if (Character.isHighSurrogate(c)) {
                if (++i >= text.length() || !Character.isLowSurrogate(text.charAt(i))) throw new IllegalArgumentException("invalid_text");
            } else if (Character.isLowSurrogate(c)) throw new IllegalArgumentException("invalid_text");
        }
    }
    public static String path(String value, boolean rootAllowed) {
        if (value == null) throw new IllegalArgumentException("invalid_path");
        characters(value);
        if (value.isEmpty() && rootAllowed) return value;
        if (value.isEmpty() || value.getBytes(StandardCharsets.UTF_8).length > 240 || value.contains("\\") || value.contains(":") || value.matches("(?s).*%[a-fA-F0-9]{2}.*")) throw new IllegalArgumentException("invalid_path");
        String[] pieces = value.split("/", -1);
        if (pieces.length > 8) throw new IllegalArgumentException("invalid_path");
        for (String piece : pieces) {
            if (piece.isEmpty() || piece.equals(".") || piece.equals("..") || !piece.equals(piece.trim()) || piece.contains("\n") || piece.contains("\r") || piece.contains("\t")) throw new IllegalArgumentException("invalid_path");
        }
        return value;
    }
    public static String textPath(String value) {
        path(value, false);
        String name = value.substring(value.lastIndexOf('/') + 1).toLowerCase(Locale.ROOT);
        if (name.lastIndexOf('.') < 1 || !(name.endsWith(".txt") || name.endsWith(".md") || name.endsWith(".json") || name.endsWith(".csv") || name.endsWith(".log"))) throw new IllegalArgumentException("unsupported_text");
        return value;
    }
    public static byte[] encode(String text) {
        if (text == null) throw new IllegalArgumentException("invalid_text");
        characters(text);
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_BYTES) throw new IllegalArgumentException("text_capacity");
        return bytes;
    }
    public static String decode(byte[] bytes) {
        if (bytes.length > MAX_BYTES) throw new IllegalArgumentException("text_capacity");
        try {
            String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
            characters(text); return text;
        } catch (java.nio.charset.CharacterCodingException error) { throw new IllegalArgumentException("invalid_utf8"); }
    }
    public static String digest(byte[] bytes) {
        try {
            StringBuilder result = new StringBuilder();
            for (byte b : MessageDigest.getInstance("SHA-256").digest(bytes)) result.append(String.format(Locale.ROOT, "%02x", b & 255));
            return result.toString();
        } catch (java.security.NoSuchAlgorithmException error) { throw new IllegalStateException(error); }
    }
}
