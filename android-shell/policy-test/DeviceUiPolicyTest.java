import app.floatphone.shell.DeviceUiPolicy;

public final class DeviceUiPolicyTest {
    static void check(boolean value) { if (!value) throw new AssertionError(); }
    public static void main(String[] args) {
        for (String pkg : new String[]{"app.floatphone.shell", "com.android.settings", "com.android.permissioncontroller", "com.android.systemui", "com.vendor.securitycenter", "com.android.packageinstaller", "com.vendor.credentials"}) check(!DeviceUiPolicy.packageAllowed(pkg, "app.floatphone.shell"));
        check(DeviceUiPolicy.packageAllowed("org.synthetic.notes", "app.floatphone.shell"));
        for (String bad : new String[]{"../app", "app/other", "app;command", "", "org.synthetic\n.other"}) check(!DeviceUiPolicy.packageAllowed(bad, "app.floatphone.shell"));
        for (String label : new String[]{"Password", "一次性验证码", "bank PIN", "one-time-code", "private_key", "信用卡"}) check(DeviceUiPolicy.sensitive(label));
        check(!DeviceUiPolicy.sensitive("今日笔记"));
        check(DeviceUiPolicy.inputText("普通笔记🙂\n第二行")); check(DeviceUiPolicy.inputText(""));
        for (String bad : new String[]{"x".repeat(2049), "\u202Eevil", "\u2066evil", "\uD800", "\uDC00", "\u0000", "Bearer abcdefghijklmnop", "-----BEGIN RSA PRIVATE KEY"}) check(!DeviceUiPolicy.inputText(bad));
        check(DeviceUiPolicy.review("input", "", "名称", false));
        check(DeviceUiPolicy.review("click", "收件箱", "发送", false));
        check(DeviceUiPolicy.review("click", "付款", "下一页", false));
        check(DeviceUiPolicy.review("click", "", "确定", false));
        check(DeviceUiPolicy.review("back", "", "", true));
        check(!DeviceUiPolicy.review("click", "", "查看笔记", false));
        check(!DeviceUiPolicy.review("back", "", "", false));
        check(DeviceUiPolicy.id("opaque-uuid_123")); check(!DeviceUiPolicy.id("../path"));
        System.out.println("Device UI policy fixtures passed (no Android actions).");
    }
}
