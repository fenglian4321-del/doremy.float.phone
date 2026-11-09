package app.floatphone.shell;

/** Pure policy shared by the native notifier and isolated JVM contract tests. */
public final class XinchaoWakePolicy {
    private XinchaoWakePolicy() {}
    public static boolean deliveryId(String value) { return value != null && value.matches("^[A-Za-z0-9][A-Za-z0-9._:-]{5,159}$"); }
    public static boolean sessionId(String value) { return value != null && value.matches("^[^\\x00-\\x20\\x7f]{1,160}$"); }
    public static boolean mayNotify(long lastAt, long now, int cooldownMinutes) {
        return cooldownMinutes >= 5 && cooldownMinutes <= 1440 && lastAt >= 0 && now >= lastAt && now - lastAt >= cooldownMinutes * 60000L;
    }
}
