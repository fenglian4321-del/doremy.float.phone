import app.floatphone.shell.XinchaoWakePolicy;
public class XinchaoWakePolicyTest {
    private static void check(boolean value) { if (!value) throw new AssertionError("Native wake policy"); }
    public static void main(String[] args) {
        check(XinchaoWakePolicy.deliveryId("delivery-synthetic-123"));
        for (String value : new String[]{"../outside", "delivery/foo", "delivery%2ffoo", "https://outside", "x", "delivery?x=1"}) check(!XinchaoWakePolicy.deliveryId(value));
        check(XinchaoWakePolicy.sessionId("session-synthetic"));
        for (String value : new String[]{"", "x y", "x\ny", "x\u0000y", new String(new char[161]).replace('\0', 'x')}) check(!XinchaoWakePolicy.sessionId(value));
        check(!XinchaoWakePolicy.mayNotify(1000, 1000 + 299999, 5));
        check(XinchaoWakePolicy.mayNotify(1000, 1000 + 300000, 5));
        check(!XinchaoWakePolicy.mayNotify(1000, 999, 5));
        check(!XinchaoWakePolicy.mayNotify(-1, 1000000, 5));
        check(!XinchaoWakePolicy.mayNotify(0, Long.MAX_VALUE, 0));
        check(!XinchaoWakePolicy.mayNotify(0, Long.MAX_VALUE, 1441));
        System.out.println("Native wake JVM policy: IDs, control/path refusal, cooldown boundary and clock reversal passed.");
    }
}
