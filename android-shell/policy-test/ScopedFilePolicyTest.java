import app.floatphone.shell.ScopedFilePolicy;
import java.nio.charset.StandardCharsets;

public final class ScopedFilePolicyTest {
    private static int cases;
    private static void equal(Object expected, Object actual) { cases++; if (!expected.equals(actual)) throw new AssertionError("Mismatch in synthetic policy fixture"); }
    private static void reject(Runnable code) { cases++; try { code.run(); } catch (IllegalArgumentException expected) { return; } throw new AssertionError("Unsafe fixture accepted"); }
    public static void main(String[] args) {
        equal("", ScopedFilePolicy.path("", true));
        equal("笔记/材料.md", ScopedFilePolicy.textPath("笔记/材料.md"));
        for (String bad : new String[]{"", "..", "../life.md", "/sdcard/x.md", "a//b", "a/./b", "a/../b", "a\\b", "content://tree", "C:/x", "%2e%2e/x.md", "a%2Fb.md", "a\nb.md", " a.md", "a\u202eb.md", "a/b/c/d/e/f/g/h/i.md"}) reject(() -> ScopedFilePolicy.path(bad, false));
        for (String bad : new String[]{"image.png", "data.pdf", "script.sh", "file", ".md"}) reject(() -> ScopedFilePolicy.textPath(bad));
        for (String path : new String[]{"a.TXT", "a.md", "a.JSON", "a.csv", "a.log"}) equal(path, ScopedFilePolicy.textPath(path));
        equal("中文\n😀", ScopedFilePolicy.decode(ScopedFilePolicy.encode("中文\n😀")));
        equal(32768, ScopedFilePolicy.encode("a".repeat(32768)).length);
        reject(() -> ScopedFilePolicy.encode("中".repeat(10923)));
        reject(() -> ScopedFilePolicy.decode(new byte[]{(byte) 0xff}));
        reject(() -> ScopedFilePolicy.encode("\uD800"));
        reject(() -> ScopedFilePolicy.encode("\uDC00"));
        reject(() -> ScopedFilePolicy.encode("a\u0000b"));
        reject(() -> ScopedFilePolicy.decode(new byte[32769]));
        equal("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", ScopedFilePolicy.digest(new byte[0]));
        equal("work", ScopedFilePolicy.mode("work")); equal("private", ScopedFilePolicy.mode("private"));
        reject(() -> ScopedFilePolicy.mode("life")); reject(() -> ScopedFilePolicy.id("../x"));
        System.out.println("Scoped-file JVM policy: " + cases + " scope/path/UTF-8/size/hash fixtures passed; no files or phone accessed.");
    }
}
