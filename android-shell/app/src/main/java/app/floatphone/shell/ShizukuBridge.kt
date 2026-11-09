package app.floatphone.shell

import android.app.Activity
import android.app.AlertDialog
import android.content.ComponentName
import android.content.Context
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.Binder
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.webkit.CookieManager
import moe.shizuku.server.IShizukuService
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import rikka.shizuku.Shizuku
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Only nonce-gated trusted top-level RPC reaches this task-scoped bridge. */
class ShizukuBridge(private val activity: Activity, private val origin: String, private val trusted: () -> Boolean) {
    private data class Grant(val id: String, val scope: String, val pkg: String, val label: String, val launch: Boolean, val taskDigest: String, val epoch: Int, val until: Long = SystemClock.elapsedRealtime() + 600000, val expires: Long = System.currentTimeMillis() + 600000, var run: String = "", var claim: String = "")
    private class Job(val id: String, val scope: String, val operation: String, val grantId: String = "") {
        val created = SystemClock.elapsedRealtime()
        @Volatile var cancelled = false
        @Volatile var result = JSONObject().put("state", "pending")
        @Volatile var dialog: AlertDialog? = null
        @Volatile var call: Call? = null
        @Volatile var reserved = false
    }
    private class Failure(val code: String) : RuntimeException(code)
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private val watcher = Executors.newSingleThreadScheduledExecutor()
    private val grants = ConcurrentHashMap<String, Grant>()
    private val jobs = ConcurrentHashMap<String, Job>()
    private val prefs = activity.getSharedPreferences("float_shizuku_receipts_v1", Context.MODE_PRIVATE)
    private val http = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).callTimeout(4, TimeUnit.SECONDS).build()
    private val owner = Binder()
    private var secret = UUID.randomUUID().toString() + UUID.randomUUID()
    @Volatile private var service: IShizukuExecutor? = null
    @Volatile private var serviceUid = -1
    @Volatile private var epoch = 0
    @Volatile private var state = "not_running"
    @Volatile private var closed = false
    @Volatile private var bound = false
    private val args = Shizuku.UserServiceArgs(ComponentName(activity, ShizukuExecutor::class.java)).tag("float-shizuku-v1").daemon(false).processNameSuffix("float_shizuku").debuggable(BuildConfig.DEBUG).version(BuildConfig.VERSION_CODE)
    private val death = IBinder.DeathRecipient { lost("disconnected") }
    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, binder: IBinder) {
            val expected = epoch
            if (closed || !bound || state != "connecting") return
            worker.execute {
                try {
                    if (closed || !bound || epoch != expected || state != "connecting") return@execute
                    requirePermission(); val remote = IShizukuExecutor.Stub.asInterface(binder)
                    val reply = JSONObject(remote.attach(owner, secret)); val uid = reply.getInt("uid")
                    if (closed || !bound || epoch != expected || !ShizukuPolicy.identity(uid) || uid != Shizuku.getUid()) fail("identity_denied")
                    binder.linkToDeath(death, 0); serviceUid = uid; service = remote; state = "ready"
                } catch (_: Throwable) { lost("disconnected") }
            }
        }
        override fun onServiceDisconnected(name: ComponentName) { lost("disconnected") }
        override fun onBindingDied(name: ComponentName) { lost("disconnected") }
        override fun onNullBinding(name: ComponentName) { lost("disconnected") }
    }
    private val received = Shizuku.OnBinderReceivedListener { lost("authorized") }
    private val dead = Shizuku.OnBinderDeadListener { lost("disconnected") }
    private val permission = Shizuku.OnRequestPermissionResultListener { request, result ->
        if (request == 7133) { if (result == PackageManager.PERMISSION_GRANTED) state = "authorized" else lost("denied") }
    }
    init {
        Shizuku.addBinderReceivedListenerSticky(received)
        Shizuku.addBinderDeadListener(dead)
        Shizuku.addRequestPermissionResultListener(permission)
    }
    private fun fail(code: String): Nothing = throw Failure(code)
    private fun trusted() { if (closed || !trusted.invoke() || !origin.startsWith("https://")) fail("untrusted_origin") }
    private fun hash(text: String) = MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    // The public SDK caches a granted decision. Use its official AIDL to ask the
    // live server on every fence, including revocation while a UserService lives.
    private fun permitted(): Boolean = runCatching { Shizuku.pingBinder() && !Shizuku.isPreV11() && IShizukuService.Stub.asInterface(Shizuku.getBinder()).checkSelfPermission() }.getOrDefault(false)
    private fun requirePermission() { trusted(); if (!Shizuku.pingBinder()) fail("not_running"); if (!permitted()) { lost("revoked"); fail("permission_required") } }
    private fun ready(): IShizukuExecutor { requirePermission(); return service?.takeIf { it.asBinder().isBinderAlive && state == "ready" } ?: fail("not_ready") }
    private fun envelope(value: JSONObject) = value.put("protocol", "float-shizuku/v1").toString()
    private fun error(code: String) = envelope(JSONObject().put("state", "failed").put("code", code))
    private fun scope(value: JSONObject): String { if (value.keys().asSequence().toSet() != setOf("mode", "workspaceId") || value.optString("mode") !in listOf("work", "private") || !DeviceUiPolicy.id(value.optString("workspaceId"))) fail("invalid_scope"); return JSONObject().put("mode", value.getString("mode")).put("workspaceId", value.getString("workspaceId")).toString() }
    private fun view(g: Grant) = JSONObject().put("id", g.id).put("label", g.label).put("allowLaunch", g.launch).put("taskDigest", g.taskDigest).put("expires", g.expires).put("epoch", g.epoch)
    private fun owned(s: String, id: String): Grant { ready(); val g = grants[id] ?: fail("grant_expired"); if (g.scope != s || g.epoch != epoch || SystemClock.elapsedRealtime() >= g.until) fail("grant_expired"); return g }
    private fun check(g: Grant, job: Job) { owned(job.scope, g.id); if (job.cancelled) fail("cancelled") }
    private fun receiptKey(s: String, id: String) = "receipt_" + hash(origin + s + id)
    private fun trimJobs() {
        val now = SystemClock.elapsedRealtime()
        jobs.entries.removeIf { it.value.result.optString("state") != "pending" && now - it.value.created > 120000 }
        grants.entries.removeIf { now >= it.value.until }
    }
    private fun finish(job: Job, result: JSONObject) { job.result = result.put("requestId", job.id).put("operation", job.operation) }
    private fun cancel(job: Job) { job.cancelled = true; job.call?.cancel(); runCatching { service?.cancel(secret, job.id) }; main.post { job.dialog?.dismiss() }; finish(job, JSONObject().put("state", "failed").put("code", if (job.reserved) "action_uncertain" else "cancelled")) }
    @Synchronized private fun lost(next: String) { val wasBound = bound; bound = false; epoch++; state = next; jobs.values.forEach { cancel(it) }; grants.clear(); service?.asBinder()?.let { runCatching { it.unlinkToDeath(death, 0) } }; service = null; serviceUid = -1; if (wasBound) main.post { runCatching { Shizuku.unbindUserService(args, connection, true) } } }
    fun status(): String = runCatching {
        trusted(); val installed = runCatching { activity.packageManager.getPackageInfo("moe.shizuku.privileged.api", 0); true }.getOrDefault(false)
        val alive = Shizuku.pingBinder(); val allowed = if (alive) permitted() else false
        if (!alive && service != null) lost("disconnected")
        if (alive && !allowed && service != null) lost("revoked")
        val actual = if (!alive) { if (state == "disconnected") state else if (!installed) "not_installed" else "not_running" } else if (Shizuku.getVersion() < 13) "unsupported" else if (!allowed) { if (state in listOf("denied", "revoked")) state else "permission_required" } else if (service != null) "ready" else if (state in listOf("connecting", "disconnected")) state else "authorized"
        envelope(JSONObject().put("state", "complete").put("status", actual).put("binderAlive", alive).put("authorized", allowed).put("ready", actual == "ready").put("uid", serviceUid).put("identity", if (serviceUid == 0) "root" else if (serviceUid == 2000) "shell" else "unknown").put("epoch", epoch))
    }.getOrElse { error((it as? Failure)?.code ?: "unavailable") }
    private fun authority(g: Grant, job: Job) {
        check(g, job); if (g.run.isEmpty()) fail("task_required")
        val s = JSONObject(g.scope); val endpoint = origin + "/api/shared-memory/" + if (s.getString("mode") == "work") "workspaces" else "private-space"
        val cookie = CookieManager.getInstance().getCookie(endpoint).orEmpty(); if (cookie.isEmpty()) fail("owner_session_required")
        val body = JSONObject().put("operation", "phone_lease").put("workspaceId", s.getString("workspaceId")).put("runId", g.run).put("claim", g.claim)
        val call = http.newCall(Request.Builder().url(endpoint).header("Origin", origin).header("Cookie", cookie).header("x-float-space-external-tools", "v1").post(body.toString().toRequestBody("application/json".toMediaType())).build()); job.call = call
        try { call.execute().use { r ->
            if (!r.isSuccessful) fail("task_inactive")
            val bytes = r.body?.byteStream()?.use { stream ->
                val output = java.io.ByteArrayOutputStream(); val buffer = ByteArray(1024)
                while (true) { val n = stream.read(buffer); if (n < 0) break; if (output.size() + n > 4096) fail("task_inactive"); output.write(buffer, 0, n) }; output.toByteArray()
            } ?: fail("task_inactive")
            val v = JSONObject(String(bytes, Charsets.UTF_8)); val scoped = v.optJSONObject("scope")
            if (v.opt("ok") != true || v.optString("protocol") != "float-shell-ui-lease/v1" || v.optString("externalMode") != "assistant" || v.optString("state") != "running" || v.optInt("executionVersion") != 1 || v.optString("runId") != g.run || v.optString("taskDigest") != g.taskDigest || scoped?.optString("mode") != s.getString("mode") || scoped?.optString("workspaceId") != s.getString("workspaceId")) fail("task_inactive")
        } } finally { job.call = null }; check(g, job)
    }
    private fun confirm(job: Job, title: String, text: String, accepted: () -> Unit) {
        main.post {
            if (job.cancelled || closed || !trusted.invoke()) { cancel(job); return@post }
            val dialog = AlertDialog.Builder(activity).setTitle(title).setMessage(text).setNegativeButton("取消") { _, _ -> cancel(job) }.setPositiveButton("仅授权这一次") { _, _ -> if (!job.cancelled) accepted() }.create()
            job.dialog = dialog; dialog.setOnCancelListener { cancel(job) }; dialog.show()
        }
    }
    fun finishGrant(id: String, component: ComponentName?) {
        val job = jobs[id] ?: return
        runCatching {
            ready(); if (job.cancelled || component == null || !ShizukuPolicy.packageAllowed(component.packageName, activity.packageName)) fail("package_denied")
            val extra = job.result; val task = extra.getString("task"); val launch = extra.getBoolean("allowLaunch")
            val label = activity.packageManager.getApplicationLabel(activity.packageManager.getApplicationInfo(component.packageName, 0)).toString().take(80)
            confirm(job, "Shizuku · 授权$label", "任务：$task\n仅此空间、此任务和所选应用，10分钟有效。允许读取执行身份/应用公开信息${if (launch) "与逐次确认后启动应用" else "，不启动应用"}。结果如用于AI会发送给当前模型API。不读取应用私有数据、不执行任意shell。") {
                runCatching { ready(); if (job.cancelled) fail("cancelled"); val g = Grant(UUID.randomUUID().toString(), job.scope, component.packageName, label, launch, hash(task), epoch); grants[g.id] = g; finish(job, JSONObject().put("state", "complete").put("grant", view(g))) }.onFailure { finish(job, JSONObject().put("state", "failed").put("code", "grant_expired")) }
            }
        }.onFailure { finish(job, JSONObject().put("state", "failed").put("code", (it as? Failure)?.code ?: "grant_failed")) }
    }
    fun control(raw: String, picker: (String) -> Unit): String = runCatching {
        trusted(); trimJobs(); if (raw.toByteArray().size > 8192) fail("invalid_request"); val b = JSONObject(raw); val op = b.getString("operation")
        val fields = when (op) {
            "permission", "connect", "disconnect" -> setOf("operation")
            "grant" -> setOf("operation", "scope", "requestId", "task", "allowLaunch")
            "activate" -> setOf("operation", "scope", "grantId", "runId", "claim", "taskDigest")
            "action" -> setOf("operation", "scope", "grantId", "requestId", "action")
            "grant_status", "revoke" -> setOf("operation", "scope", "grantId")
            "probe", "result", "receipt", "cancel" -> setOf("operation", "scope", "requestId")
            else -> fail("invalid_request")
        }; if (b.keys().asSequence().toSet() != fields) fail("invalid_request")
        if (op == "disconnect") { lost("disconnected"); bound = false; runCatching { Shizuku.unbindUserService(args, connection, true) }; return@runCatching status() }
        if (op == "permission") { if (!Shizuku.pingBinder() || Shizuku.getVersion() < 13) fail("not_running"); main.post { runCatching { if (!Shizuku.shouldShowRequestPermissionRationale()) Shizuku.requestPermission(7133) else state = "denied" }.onFailure { state = "denied" } }; return@runCatching status() }
        if (op == "connect") { requirePermission(); if (Shizuku.getVersion() < 13) fail("unsupported"); if (service == null && state != "connecting") { lost("connecting"); bound = true; main.post { runCatching { Shizuku.bindUserService(args, connection) }.onFailure { lost("disconnected") } }; val expected = epoch; main.postDelayed({ if (epoch == expected && service == null) { lost("disconnected"); bound = false; runCatching { Shizuku.unbindUserService(args, connection, true) } } }, 15000) }; return@runCatching status() }
        val s = scope(b.getJSONObject("scope"))
        if (op == "probe") {
            ready(); val id = b.getString("requestId")
            if (!DeviceUiPolicy.id(id) || jobs.size >= 128) fail("invalid_request")
            val job = Job(id, s, "probe"); if (jobs.putIfAbsent(id, job) != null) fail("request_conflict")
            worker.execute { runCatching {
                if (job.cancelled) fail("cancelled")
                val currentEpoch = epoch; val data = JSONObject(ready().execute(secret, id, "system_info", ""))
                ready(); if (job.cancelled || currentEpoch != epoch || data.optInt("uid", -1) != serviceUid) fail("disconnected")
                finish(job, JSONObject().put("state", "complete").put("data", data))
            }.onFailure { finish(job, JSONObject().put("state", "failed").put("code", "unavailable")) } }
            return@runCatching envelope(JSONObject().put("state", "pending").put("requestId", id))
        }
        if (op in listOf("result", "receipt", "cancel")) {
            val id = b.getString("requestId"); if (!DeviceUiPolicy.id(id)) fail("invalid_request")
            val job = jobs[id]; if (job != null && job.scope != s) fail("invalid_scope")
            if (op == "cancel") { if (job != null) cancel(job); return@runCatching error("cancelled") }
            val receipt = prefs.getString(receiptKey(s, id), null)
            if (op == "result" && job != null && !job.cancelled) return@runCatching envelope(JSONObject(job.result.toString()))
            if (receipt != null) return@runCatching envelope(JSONObject().put("state", "complete").put("requestId", id).put("replayed", true).put("receipt", JSONObject(receipt)))
            if (job != null) return@runCatching envelope(JSONObject(job.result.toString()))
            fail("request_missing")
        }
        if (op == "grant") {
            ready(); val id = b.getString("requestId"); val task = b.getString("task")
            if (!DeviceUiPolicy.id(id) || task.isBlank() || task.length > 4000 || b.opt("allowLaunch") !is Boolean || jobs.size >= 128 || jobs.containsKey(id)) fail("invalid_request")
            val job = Job(id, s, "grant"); job.result.put("task", task).put("allowLaunch", b.getBoolean("allowLaunch")).put("requestId", id); if (jobs.putIfAbsent(id, job) != null) fail("request_conflict")
            main.post { runCatching { if (!job.cancelled) picker(id) }.onFailure { cancel(job) } }
            return@runCatching envelope(JSONObject().put("state", "pending").put("requestId", id))
        }
        val g = owned(s, b.getString("grantId"))
        if (op == "grant_status") return@runCatching envelope(JSONObject().put("state", "complete").put("grant", view(g)))
        if (op == "revoke") { grants.remove(g.id); jobs.values.filter { it.grantId == g.id }.forEach { cancel(it) }; return@runCatching envelope(JSONObject().put("state", "complete")) }
        if (op == "activate") { if (!DeviceUiPolicy.id(b.getString("runId")) || !DeviceUiPolicy.id(b.getString("claim")) || b.getString("taskDigest") != g.taskDigest || (g.run.isNotEmpty() && g.run != b.getString("runId"))) fail("task_mismatch"); g.run = b.getString("runId"); g.claim = b.getString("claim"); return@runCatching envelope(JSONObject().put("state", "complete").put("grant", view(g))) }
        val id = b.getString("requestId"); val action = b.getString("action")
        if (!DeviceUiPolicy.id(id) || !ShizukuPolicy.operation(action) || (action == "launch_app" && !g.launch)) fail("operation_denied")
        val key = receiptKey(s, id); val fingerprint = hash(g.id + g.run + action)
        prefs.getString(key, null)?.let { previous -> val r = JSONObject(previous); if (r.optString("fingerprint") != fingerprint) fail("request_conflict"); return@runCatching envelope(JSONObject().put("state", "complete").put("replayed", true).put("requestId", id).put("receipt", r)) }
        if (jobs.containsKey(id) || jobs.size >= 128 || prefs.all.size >= 512) fail("receipt_capacity")
        val job = Job(id, s, action, g.id); if (jobs.putIfAbsent(id, job) != null) fail("request_conflict")
        worker.execute {
            var timer: java.util.concurrent.ScheduledFuture<*>? = null
            try {
                authority(g, job)
                if (action == "launch_app") {
                    val decision = CompletableFuture<Boolean>()
                    confirm(job, "Shizuku · 启动${g.label}？", "仅启动当前任务授权的应用。不输入、点击或替你完成应用内业务。") { decision.complete(true) }
                    val deadline = SystemClock.elapsedRealtime() + 45000
                    while (!decision.isDone) { check(g, job); if (SystemClock.elapsedRealtime() > deadline) fail("review_timeout"); Thread.sleep(80) }
                    if (!decision.get()) fail("review_declined"); authority(g, job)
                }
                val receipt = JSONObject().put("requestId", id).put("operation", action).put("state", "uncertain").put("at", System.currentTimeMillis()).put("fingerprint", fingerprint)
                if (!prefs.edit().putString(key, receipt.toString()).commit()) fail("state_unavailable")
                job.reserved = true; check(g, job)
                timer = watcher.scheduleWithFixedDelay({ if (job.result.optString("state") == "pending") runCatching { authority(g, job) }.onFailure { if (job.result.optString("state") == "pending") cancel(job) } }, 200, 500, TimeUnit.MILLISECONDS)
                val result = JSONObject(ready().execute(secret, id, action, g.pkg)); check(g, job); authority(g, job)
                if (result.optInt("uid", -1) != serviceUid || result.optString("operation") != action) fail("identity_denied")
                synchronized(job) { check(g, job); receipt.put("state", "complete"); if (!prefs.edit().putString(key, receipt.toString()).commit()) fail("state_unavailable"); finish(job, JSONObject().put("state", "complete").put("data", result).put("receipt", receipt)) }
            } catch (e: Throwable) { finish(job, JSONObject().put("state", "failed").put("code", if (job.reserved) "action_uncertain" else (e as? Failure)?.code ?: "unavailable")) }
            finally { timer?.cancel(false); main.post { job.dialog?.dismiss(); job.dialog = null } }
        }
        envelope(JSONObject().put("state", "pending").put("requestId", id))
    }.getOrElse { error((it as? Failure)?.code ?: "unavailable") }
    fun invalidateDocument() { grants.clear(); jobs.values.forEach { cancel(it) } }
    fun close() { closed = true; lost("disconnected"); bound = false; runCatching { Shizuku.unbindUserService(args, connection, true) }; Shizuku.removeBinderReceivedListener(received); Shizuku.removeBinderDeadListener(dead); Shizuku.removeRequestPermissionResultListener(permission); worker.shutdownNow(); watcher.shutdownNow() }
}
