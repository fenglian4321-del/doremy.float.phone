import app.floatphone.shell.ShizukuPolicy;
public final class ShizukuPolicyTest {
    static void check(boolean value) { if (!value) throw new AssertionError(); }
    public static void main(String[] args) {
        check(ShizukuPolicy.identity(0)); check(ShizukuPolicy.identity(2000)); check(!ShizukuPolicy.identity(10001));
        for (String op : new String[]{"system_info","app_info","launch_app"}) check(ShizukuPolicy.operation(op));
        for (String op : new String[]{"shell","exec","input","read_file","screenshot","pm install"}) check(!ShizukuPolicy.operation(op));
        for (String pkg : new String[]{"app.floatphone.shell","moe.shizuku.privileged.api","com.android.settings","com.android.permissioncontroller","com.vendor.securitycenter","org.app;id","org.app\nwhoami","../private"}) check(!ShizukuPolicy.packageAllowed(pkg,"app.floatphone.shell"));
        check(ShizukuPolicy.resolve("org.example.notes").contains("org.example.notes"));
        check(ShizukuPolicy.launch("org.example.notes","org.example.notes/.Main").get(0).equals("/system/bin/am"));
        for (String target : new String[]{"other.app/.Main","org.example.notes/.Main;id","org.example.notes/.Main\nwhoami","org.example.notes/../../secret"}) {
            boolean denied=false;try { ShizukuPolicy.launch("org.example.notes",target); } catch (IllegalArgumentException expected) { denied=true; }check(denied);
        }
        check(!ShizukuPolicy.packagePath("org.example.notes").contains("sh"));
        System.out.println("Shizuku fixed-argv/UID/package/component policy passed");
    }
}
