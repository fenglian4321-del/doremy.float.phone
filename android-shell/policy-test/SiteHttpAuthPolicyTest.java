import app.floatphone.shell.SiteHttpAuthPolicy;

public final class SiteHttpAuthPolicyTest {
    private static final String SITE = "https://float.example.test";
    private static int checks;
    private static void check(boolean value) { checks++; if (!value) throw new AssertionError("check " + checks); }
    private static SiteHttpAuthPolicy fresh() { SiteHttpAuthPolicy p = new SiteHttpAuthPolicy(SITE); p.begin(SITE + "/"); return p; }
    public static void main(String[] args) {
        // Reproduce the 1.0.34 ordering: a challenge can arrive before the
        // WebView's onPageStarted. Arm from the native load request instead.
        SiteHttpAuthPolicy early = new SiteHttpAuthPolicy(SITE);
        check(!early.canChallenge("float.example.test", null));
        long armed = early.begin(SITE + "/");
        early.resource(SITE + "/", true);
        check(early.canChallenge("float.example.test", null));
        check(early.submit(armed, "float.example.test", null));
        check(early.started(SITE + "/") == armed);
        check(early.belongs(armed));
        check(early.submit(armed, "float.example.test", SITE + "/"));
        check(early.started(SITE + "/") == armed);
        check(early.submit(armed, "float.example.test", SITE + "/"));
        check(!early.submit(armed, "float.example.test", SITE + "/"));
        early.invalidate();
        check(!early.canChallenge("float.example.test", SITE + "/"));
        check(early.started("https://other.test/") != armed);
        check(!early.canChallenge("float.example.test", "https://other.test/"));
        SiteHttpAuthPolicy p = fresh();
        check(p.canChallenge("float.example.test", SITE + "/"));
        check(p.canChallenge("FLOAT.EXAMPLE.TEST", SITE + ":443/"));
        check(p.canChallenge("float.example.test", null));
        for (String url : new String[]{"http://float.example.test/", SITE+":8443/", "https://float.example.test.evil/", "https://user:pass@float.example.test/", "https://evil.test/", "file:///private", SITE+"/other", SITE+"/?other=1"}) check(!p.canChallenge("float.example.test", url));
        for (String host : new String[]{"evil.test","float.example.test:443","float.example.test.evil","https://float.example.test",""}) check(!p.canChallenge(host, SITE+"/"));
        check(!p.trusted("https://user@float.example.test/"));
        long epoch=p.epoch(); check(p.submit(epoch,"float.example.test",SITE+"/"));
        check(p.submit(epoch,"float.example.test",SITE+"/")); check(p.submit(epoch,"float.example.test",SITE+"/"));
        check(!p.submit(epoch,"float.example.test",SITE+"/"));
        p=fresh();epoch=p.epoch();p.invalidate();check(!p.submit(epoch,"float.example.test",SITE+"/"));
        p.begin(SITE+"/");check(!p.submit(epoch,"float.example.test",SITE+"/"));
        p=fresh();p.resource("https://other.test/image",false);check(!p.canChallenge("float.example.test",SITE+"/"));
        p.begin(SITE+"/");check(!p.canChallenge("float.example.test",SITE+"/"));
        p=fresh();p.resource(SITE+"/script.js",false);check(!p.canChallenge("float.example.test",SITE+"/"));
        p=new SiteHttpAuthPolicy(SITE);p.resource(SITE+"/early",false);p.begin(SITE+"/");check(!p.canChallenge("float.example.test",SITE+"/"));
        p=fresh();p.resource(SITE+":8443/",true);check(!p.canChallenge("float.example.test",SITE+"/"));
        p=fresh();check(p.authFailure(SITE+"/"));check(!p.finished(SITE+"/",false));
        check(p.canChallenge("float.example.test",SITE+"/"));check(!p.finished(SITE+"/",true));
        check(p.submit(p.epoch(),"float.example.test",SITE+"/"));check(p.finished(SITE+"/",false));
        check(!p.canChallenge("float.example.test",SITE+"/"));check(!p.canChallenge("float.example.test",null));
        p=fresh();check(p.submit(p.epoch(),"float.example.test",SITE+"/"));check(p.authFailure(SITE+"/"));
        check(!p.finished(SITE+"/",false));check(p.canChallenge("float.example.test",SITE+"/"));
        check(!p.authFailure("https://evil.test/"));
        check(SiteHttpAuthPolicy.validInput("synthetic-user"," synthetic password "));
        for (String user : new String[]{"", "a:b", "a\n", "a".repeat(257)}) check(!SiteHttpAuthPolicy.validInput(user,"synthetic"));
        for (String password : new String[]{"", "bad\r", "bad\u0000", "x".repeat(1025)}) check(!SiteHttpAuthPolicy.validInput("synthetic",password));
        boolean rejected=false;try {new SiteHttpAuthPolicy("http://float.example.test");}catch(IllegalArgumentException expected){rejected=true;}check(rejected);
        System.out.println("HTTP auth policy: " + checks + " origin/frame/navigation/retry/input/lifecycle/order checks passed");
    }
}
