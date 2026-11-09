package app.floatphone.shell;
interface IShizukuExecutor {
    String attach(IBinder owner, String token) = 0;
    String execute(String token, String requestId, String operation, String packageName) = 1;
    void cancel(String token, String requestId) = 2;
    void destroy() = 16777114;
}
