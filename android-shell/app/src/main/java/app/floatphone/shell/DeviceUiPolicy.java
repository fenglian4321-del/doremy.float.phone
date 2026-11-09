package app.floatphone.shell;
import java.util.Locale;
/** No Android/system execution. Strict identifiers and conservative review rules. */
public final class DeviceUiPolicy {
    private DeviceUiPolicy() {}
    public static boolean id(String value) { return value != null && value.matches("[A-Za-z0-9_-]{1,100}"); }
    public static boolean packageAllowed(String value, String own) {
        return value != null && value.matches("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+") && !value.equals(own)
            && !value.equals("android") && !value.matches("(?i).*(permissioncontroller|packageinstaller|systemui|securitycenter|credential|keychain|settings).*" );
    }
    public static boolean sensitive(String value) { return value != null && value.toLowerCase(Locale.ROOT).matches("(?s).*(密码|验证码|口令|银行卡|信用卡|password|one.?time.?code|\\botp\\b|\\bpin\\b|private.key|bearer |sk-[a-z0-9]{16,}).*"); }
    public static boolean inputText(String value) {
        if (value == null || value.length() > 2048 || value.matches("(?is).*(-----BEGIN .*PRIVATE KEY|bearer +[a-z0-9._-]{16,}|sk-[a-z0-9_-]{16,}).*")) return false;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if ((c < 32 && c != '\n' && c != '\t') || c == 127 || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) return false;
            if (Character.isHighSurrogate(c)) { if (++i >= value.length() || !Character.isLowSurrogate(value.charAt(i))) return false; }
            else if (Character.isLowSurrogate(c)) return false;
        }
        return true;
    }
    public static boolean review(String operation, String page, String target, boolean dirty) {
        String all = (page + " " + target).toLowerCase(Locale.ROOT);
        if (all.matches("(?s).*(支付|付款|购买|转账|删除|清空|卸载|发送|发布|授权|许可|登录|提交订单|purchase|payment|checkout|transfer|delete|erase|uninstall|send|publish|permission|sign.?in|place.order).*")) return true;
        if (operation.equals("back")) return dirty;
        if (operation.equals("input")) return true;
        return !target.toLowerCase(Locale.ROOT).matches("(?s).*(返回|查看|打开|搜索|取消|关闭|上一页|下一页|back|view|open|search|cancel|close|previous.page|next.page).*" );
    }
}
