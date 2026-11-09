package app.floatphone.shell;
import java.util.Arrays;
import java.util.List;
/** Fixed argv only. No shell parser, user arguments, paths, input or private data. */
public final class ShizukuPolicy {
    private ShizukuPolicy() {}
    public static boolean identity(int uid) { return uid == 0 || uid == 2000; }
    public static boolean operation(String value) { return Arrays.asList("system_info", "app_info", "launch_app").contains(value); }
    public static boolean packageAllowed(String pkg, String own) {
        return DeviceUiPolicy.packageAllowed(pkg, own) && !pkg.startsWith("moe.shizuku.") && !pkg.startsWith("rikka.sui");
    }
    public static List<String> resolve(String pkg) {
        if (!packageAllowed(pkg, "app.floatphone.shell")) throw new IllegalArgumentException("package_denied");
        return Arrays.asList("/system/bin/cmd", "package", "resolve-activity", "--brief", "--user", "current", "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", "-p", pkg);
    }
    public static List<String> packagePath(String pkg) {
        if (!packageAllowed(pkg, "app.floatphone.shell")) throw new IllegalArgumentException("package_denied");
        return Arrays.asList("/system/bin/cmd", "package", "path", "--user", "current", pkg);
    }
    public static List<String> launch(String pkg, String component) {
        if (!packageAllowed(pkg, "app.floatphone.shell") || component == null || !component.startsWith(pkg + "/") || !component.matches("[A-Za-z0-9_.$]+/[A-Za-z0-9_.$]+")) throw new IllegalArgumentException("component_denied");
        return Arrays.asList("/system/bin/am", "start", "-W", "--user", "current", "-n", component);
    }
}
