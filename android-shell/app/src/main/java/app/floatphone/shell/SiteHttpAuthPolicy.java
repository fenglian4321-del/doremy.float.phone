package app.floatphone.shell;

import java.net.URI;
import java.util.Locale;

/** No credentials or Android dependencies; fail closed on ambiguous challenges. */
public final class SiteHttpAuthPolicy {
    private final URI origin;
    private long epoch;
    private String document;
    private boolean loading, subresources, failed, committed;
    private int attempts;
    public SiteHttpAuthPolicy(String configured) {
        origin = parse(configured);
        if (origin == null || !"https".equalsIgnoreCase(origin.getScheme()) || origin.getRawUserInfo() != null || origin.getHost() == null) throw new IllegalArgumentException("HTTPS origin required");
    }
    private static URI parse(String value) { try { return value == null ? null : new URI(value); } catch (Exception ignored) { return null; } }
    private static int port(URI uri) { return uri.getPort() < 0 ? 443 : uri.getPort(); }
    public boolean trusted(String value) {
        URI uri = parse(value);
        return uri != null && "https".equalsIgnoreCase(uri.getScheme()) && uri.getRawUserInfo() == null
            && origin.getHost().equalsIgnoreCase(uri.getHost()) && port(origin) == port(uri);
    }
    private static String path(URI uri) { return uri.getRawPath() == null || uri.getRawPath().isEmpty() ? "/" : uri.getRawPath(); }
    private boolean sameDocument(String a, String b) {
        if (!trusted(a) || !trusted(b)) return false;
        URI left = parse(a), right = parse(b);
        return path(left).equals(path(right)) && java.util.Objects.equals(left.getRawQuery(), right.getRawQuery());
    }
    public synchronized long begin(String url) { epoch++; document = url; loading = trusted(url); failed = false; attempts = 0; return epoch; }
    // onPageStarted may be delivered on commit, AFTER the auth challenge.
    // An already armed navigation must retain its epoch, dialog and attempts.
    public synchronized long started(String url) { return sameDocument(document, url) ? epoch : begin(url); }
    public synchronized void resource(String url, boolean main) {
        // Once this WebView has loaded any subresource, this callback can no
        // longer prove which request was challenged. A fresh user-driven
        // Activity reload is required for later authentication, never a reset
        // that might mistake an old resource/redirect for a new main request.
        if (!main) { subresources = true; return; }
        if (!loading) return;
        if (!sameDocument(document, url)) loading = false;
    }
    public synchronized boolean canChallenge(String host, String current) {
        boolean currentMatches = sameDocument(document, current)
            || (!committed && (current == null || "about:blank".equals(current)));
        return loading && !subresources && attempts < 3 && trusted(document) && currentMatches
            && host != null && origin.getHost().toLowerCase(Locale.ROOT).equals(host.toLowerCase(Locale.ROOT));
    }
    public synchronized boolean submit(long expected, String host, String current) {
        if (epoch != expected || !canChallenge(host, current)) return false;
        attempts++; failed = false; return true;
    }
    public synchronized boolean authFailure(String url) { if (!loading || !sameDocument(document, url)) return false; failed = true; return true; }
    public synchronized boolean finished(String url, boolean pending) {
        if (!sameDocument(document, url) || failed || pending) return false;
        loading = false; committed = true; return true;
    }
    public synchronized boolean belongs(long expected) { return epoch == expected && loading; }
    public synchronized String rejection(String host, String current) {
        if (!loading) return "主文档未准备或已结束";
        if (subresources) return "已有子资源，需手动重新加载";
        if (attempts >= 3) return "已达本次手动重试次数";
        if (!trusted(document)) return "站点来源不匹配";
        if (host == null || !origin.getHost().equalsIgnoreCase(host)) return "挑战站点不匹配";
        return "当前主文档不匹配";
    }
    public synchronized long epoch() { return epoch; }
    public synchronized void invalidate() { epoch++; loading = false; }
    public String displayOrigin() { return "https://" + origin.getHost() + (port(origin) == 443 ? "" : ":" + port(origin)); }
    public static boolean validInput(String username, String password) {
        if (username == null || password == null || username.isEmpty() || username.length() > 256 || password.isEmpty() || password.length() > 1024 || username.indexOf(':') >= 0) return false;
        for (String value : new String[]{username, password}) for (int i = 0; i < value.length(); i++) if (value.charAt(i) < 32 || value.charAt(i) == 127) return false;
        return true;
    }
}
