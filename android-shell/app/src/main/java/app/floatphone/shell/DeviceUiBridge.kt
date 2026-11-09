package app.floatphone.shell

import android.app.Activity
import android.app.AlertDialog
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Rect
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.ContextThemeWrapper
import android.view.WindowManager
import android.view.accessibility.AccessibilityNodeInfo
import android.webkit.CookieManager
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.FutureTask
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** Per-task application grants; no screen capture, shell, coordinates or permission automation. */
class DeviceUiBridge(private val activity: Activity, private val origin: String, private val trusted: () -> Boolean) {
    private data class Scope(val mode: String, val workspaceId: String) { fun json() = JSONObject().put("mode", mode).put("workspaceId", workspaceId) }
    private data class Grant(val id: String, val scope: Scope, val pkg: String, val label: String, val actions: Boolean, val taskDigest: String, val expires: Long, val elapsedLimit: Long = android.os.SystemClock.elapsedRealtime() + 600000, var runId: String = "", var claim: String = "", var dirty: Boolean = false)
    private data class Node(val path: List<Int>, val signature: String)
    private data class Snapshot(val id: String, val grant: String, val fingerprint: String, val at: Long, val nodes: Map<String, Node>, val json: JSONObject)
    private class Job(val id: String, val scope: Scope, val operation: String, val grantId: String = "", val task: String = "", val actions: Boolean = false) {
        @Volatile var cancelled = false
        @Volatile var result = JSONObject().put("state", "pending")
        @Volatile var call: Call? = null
        @Volatile var dialog: AlertDialog? = null
    }
    private class Failure(val code: String) : RuntimeException(code)
    private val grants = ConcurrentHashMap<String, Grant>()
    private val jobs = ConcurrentHashMap<String, Job>()
    private val snapshots = ConcurrentHashMap<String, Snapshot>()
    private val main = Handler(Looper.getMainLooper())
    private val executor = ThreadPoolExecutor(1, 1, 0, TimeUnit.SECONDS, LinkedBlockingQueue(16))
    private val prefs = activity.getSharedPreferences("float_device_ui_receipts_v1", Context.MODE_PRIVATE)
    private val http = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).connectTimeout(2, TimeUnit.SECONDS).readTimeout(3, TimeUnit.SECONDS).callTimeout(4, TimeUnit.SECONDS).build()
    @Volatile private var closed = false
    private fun fail(code: String): Nothing = throw Failure(code)
    private fun scope(raw: String): Scope { val value = JSONObject(raw); if (value.keys().asSequence().toSet() != setOf("mode", "workspaceId") || value.optString("mode") !in listOf("work", "private") || !DeviceUiPolicy.id(value.optString("workspaceId"))) fail("invalid_scope"); return Scope(value.getString("mode"), value.getString("workspaceId")) }
    private fun ready() { if (closed || !trusted() || !origin.startsWith("https://")) fail("untrusted_origin") }
    private fun service() = CallControlService.forDeviceUi() ?: fail("accessibility_required")
    private fun digest(value: String) = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    private fun mac(value: String): String = synchronized(prefs) {
        var key = prefs.getString("ledger_key", null)
        if (key == null) { key = UUID.randomUUID().toString() + UUID.randomUUID(); if (!prefs.edit().putString("ledger_key", key).commit()) fail("state_unavailable") }
        val hmac = Mac.getInstance("HmacSHA256"); hmac.init(SecretKeySpec(key!!.toByteArray(Charsets.UTF_8), "HmacSHA256")); hmac.doFinal(value.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }
    private fun envelope(value: JSONObject) = value.put("protocol", "float-shell-device-ui/v1").put("location", "android_device").toString()
    private fun error(code: String) = envelope(JSONObject().put("state", "failed").put("code", code))
    private fun grantView(value: Grant) = JSONObject().put("id", value.id).put("label", value.label).put("allowActions", value.actions).put("taskDigest", value.taskDigest).put("expires", value.expires)
    private fun check(value: Grant, job: Job? = null) { ready(); if (job?.cancelled == true || grants[value.id] !== value || value.expires <= System.currentTimeMillis() || value.elapsedLimit <= android.os.SystemClock.elapsedRealtime()) fail("grant_expired"); service() }
    private fun trimJobs() { if (jobs.size >= 64) jobs.entries.removeIf { it.value.result.optString("state") in listOf("complete", "failed") } }
    private fun owned(raw: String, id: String): Grant { val s = scope(raw); val value = grants[id] ?: fail("grant_missing"); if (value.scope != s) fail("invalid_scope"); check(value); return value }
    private fun <T> ui(block: () -> T): T { if (Looper.myLooper() == Looper.getMainLooper()) return block(); val future = FutureTask<T> { block() }; main.post(future); return try { future.get(3, TimeUnit.SECONDS) } catch (error: Throwable) { future.cancel(false); throw error } }
    private fun finish(job: Job, value: JSONObject) { job.result = value.put("requestId", job.id).put("operation", job.operation) }
    fun capabilities(): String = runCatching { ready(); envelope(JSONObject().put("state", "complete").put("available", CallControlService.forDeviceUi() != null).put("methods", JSONArray(listOf("observe", "click", "input", "back"))).put("composedTasks", true).put("shizukuRequired", false)) }.getOrElse { error((it as? Failure)?.code ?: "unavailable") }
    fun beginGrant(raw: String, id: String, actions: Boolean, task: String, launchPicker: () -> Unit): String = runCatching {
        ready(); service(); val s = scope(raw)
        trimJobs(); if (!DeviceUiPolicy.id(id) || task.isBlank() || task.length > 4000 || jobs.size >= 64) fail("invalid_request")
        if (jobs.containsKey(id)) return@runCatching result(raw, id)
        jobs[id] = Job(id, s, "grant", task = task, actions = actions)
        ui { launchPicker() }; envelope(JSONObject().put("state", "pending").put("requestId", id))
    }.getOrElse { error((it as? Failure)?.code ?: "grant_unavailable") }
    fun finishGrant(id: String, component: ComponentName?) {
        val job = jobs[id] ?: return
        main.post {
            try {
                ready(); if (job.cancelled || component == null) fail("cancelled")
                if (!DeviceUiPolicy.packageAllowed(component.packageName, activity.packageName)) fail("protected_application")
                val label = activity.packageManager.getApplicationLabel(activity.packageManager.getApplicationInfo(component.packageName, 0)).toString().take(80)
                val dialog = AlertDialog.Builder(activity).setTitle("授权当前任务查看$label？")
                    .setMessage("任务：${job.task}\n\n仅此应用，10分钟内有效。界面文字可交给当前模型API，不读取密码或系统权限页面。${if (job.actions) "允许点击与输入；输入、风险或未识别操作仍逐次由你确认。" else "仅查看，不能点击或输入。"}关闭或撤销可停止后续操作，已执行动作不能自动撤回。")
                    .setNegativeButton("取消") { _, _ -> finish(job, JSONObject().put("state", "failed").put("code", "cancelled")) }
                    .setPositiveButton("授权此任务") { _, _ ->
                        try { synchronized(job) { ready(); if (job.cancelled) fail("cancelled"); val grant = Grant(UUID.randomUUID().toString(), job.scope, component.packageName, label, job.actions, digest(job.task), System.currentTimeMillis() + 600000); activity.startActivity(activity.packageManager.getLaunchIntentForPackage(grant.pkg) ?: throw Failure("application_unavailable")); grants[grant.id] = grant; finish(job, JSONObject().put("state", "complete").put("grant", grantView(grant))) } }
                        catch (_: Throwable) { finish(job, JSONObject().put("state", "failed").put("code", "grant_unavailable")) }
                    }.create()
                job.dialog = dialog; dialog.setOnCancelListener { finish(job, JSONObject().put("state", "failed").put("code", "cancelled")) }; dialog.show()
            } catch (error: Throwable) { finish(job, JSONObject().put("state", "failed").put("code", (error as? Failure)?.code ?: "grant_unavailable")) }
        }
    }
    fun activate(raw: String, id: String, run: String, claim: String, taskDigest: String): String = runCatching {
        val value = owned(raw, id); if (!DeviceUiPolicy.id(run) || claim.length !in 1..160 || taskDigest != value.taskDigest || (value.runId.isNotEmpty() && value.runId != run)) fail("task_mismatch")
        value.runId = run; value.claim = claim; envelope(JSONObject().put("state", "complete").put("grant", grantView(value)))
    }.getOrElse { error((it as? Failure)?.code ?: "task_mismatch") }
    fun grantStatus(raw: String, id: String): String = runCatching { envelope(JSONObject().put("state", "complete").put("grant", grantView(owned(raw, id)))) }.getOrElse { error((it as? Failure)?.code ?: "grant_missing") }
    private fun authority(value: Grant, job: Job) {
        check(value, job); if (value.runId.isEmpty()) { if (job.operation == "observe") return else fail("task_required") }
        val endpoint = origin + "/api/shared-memory/" + if (value.scope.mode == "work") "workspaces" else "private-space"
        val cookie = CookieManager.getInstance().getCookie(endpoint).orEmpty(); if (cookie.isEmpty()) fail("owner_session_required")
        val body = JSONObject().put("operation", "phone_lease").put("workspaceId", value.scope.workspaceId).put("runId", value.runId).put("claim", value.claim).toString()
        val call = http.newCall(Request.Builder().url(endpoint).header("Origin", origin).header("Cookie", cookie).header("x-float-space-external-tools", "v1").post(body.toRequestBody("application/json".toMediaType())).build()); job.call = call
        if (job.cancelled || closed) { call.cancel(); fail("cancelled") }
        call.execute().use { response ->
            if (!response.isSuccessful) fail("task_inactive")
            val stream = response.body?.byteStream() ?: fail("task_inactive"); val output = java.io.ByteArrayOutputStream(); val buffer = ByteArray(1024)
            while (true) { val count = stream.read(buffer); if (count < 0) break; if (output.size() + count > 4096) fail("task_inactive"); output.write(buffer, 0, count) }
            val decoded = Charsets.UTF_8.newDecoder().onMalformedInput(java.nio.charset.CodingErrorAction.REPORT).decode(java.nio.ByteBuffer.wrap(output.toByteArray())).toString()
            val result = JSONObject(decoded); val s = result.optJSONObject("scope")
            if (result.opt("ok") != true || result.optString("protocol") != "float-shell-ui-lease/v1" || result.optString("state") != "running" || result.optString("externalMode") !in listOf("phone", "assistant") || result.optInt("executionVersion") != 1 || result.optString("runId") != value.runId || result.optString("taskDigest") != value.taskDigest || s?.optString("mode") != value.scope.mode || s.optString("workspaceId") != value.scope.workspaceId) fail("task_inactive")
        }
        job.call = null; check(value, job)
    }
    private fun signature(node: AccessibilityNodeInfo): String { val rect = Rect(); node.getBoundsInScreen(rect); return digest(listOf(node.className, node.viewIdResourceName, node.text, node.contentDescription, rect.toShortString(), node.isEditable, node.isClickable).joinToString("|")) }
    private fun capture(value: Grant): Snapshot {
        check(value); val root = service().rootInActiveWindow ?: fail("ui_unavailable")
        try {
            if (root.packageName?.toString() != value.pkg) fail("application_changed")
            val rows = JSONArray(); val references = linkedMapOf<String, Node>(); var visited = 0; var limited = false
            fun walk(node: AccessibilityNodeInfo, path: List<Int>) {
                if (++visited > 1024 || path.size > 32) fail("ui_capacity")
                val fullText = node.text?.toString().orEmpty(); val description = node.contentDescription?.toString().orEmpty()
                if (node.isVisibleToUser && (node.isPassword || DeviceUiPolicy.sensitive(fullText + " " + description + " " + node.viewIdResourceName.orEmpty()))) fail("sensitive_ui")
                if (node.isVisibleToUser && (fullText.isNotBlank() || description.isNotBlank() || node.isClickable || node.isEditable)) {
                    if (rows.length() >= 128) fail("ui_capacity")
                    val sensitive = node.isPassword || DeviceUiPolicy.sensitive(fullText + " " + description + " " + node.viewIdResourceName.orEmpty())
                    val id = "n" + rows.length(); val rect = Rect(); node.getBoundsInScreen(rect)
                    val truncated = fullText.length > 512 || description.length > 256; limited = limited || truncated
                    rows.put(JSONObject().put("id", id).put("text", if (sensitive) "" else fullText.take(512)).put("description", if (sensitive) "" else description.take(256)).put("role", node.className?.toString().orEmpty().take(100)).put("clickable", node.isClickable && !sensitive).put("editable", node.isEditable && !sensitive).put("enabled", node.isEnabled && !sensitive).put("sensitive", sensitive).put("textTruncated", truncated).put("bounds", JSONArray(listOf(rect.left, rect.top, rect.right, rect.bottom))))
                    if (!sensitive) references[id] = Node(path, signature(node))
                }
                for (index in 0 until node.childCount) { val child = node.getChild(index) ?: continue; try { walk(child, path + index) } finally { child.recycle() } }
            }
            walk(root, emptyList()); val snapshotId = UUID.randomUUID().toString()
            val json = JSONObject().put("snapshotId", snapshotId).put("grantId", value.id).put("appLabel", value.label).put("nodes", rows).put("limited", limited).put("untrustedData", true).put("at", System.currentTimeMillis())
            if (json.toString().toByteArray(Charsets.UTF_8).size > 65536) fail("ui_capacity")
            check(value); return Snapshot(snapshotId, value.id, digest(rows.toString()), System.currentTimeMillis(), references, json).also { snapshots.entries.removeIf { it.value.grant == value.id }; snapshots[it.id] = it }
        } finally { root.recycle() }
    }
    private fun currentNode(value: Grant, path: List<Int>): AccessibilityNodeInfo {
        var current = service().rootInActiveWindow ?: fail("ui_unavailable")
        if (current.packageName?.toString() != value.pkg) { current.recycle(); fail("application_changed") }
        for (index in path) { val next = current.getChild(index); current.recycle(); current = next ?: fail("stale_snapshot") }
        return current
    }
    private fun node(value: Grant, target: Node): AccessibilityNodeInfo {
        val current = currentNode(value, target.path)
        if (signature(current) != target.signature || !current.isEnabled || current.isPassword) { current.recycle(); fail("stale_snapshot") }
        return current
    }
    private fun review(value: Grant, job: Job, operation: String, label: String, text: String) {
        val decision = CompletableFuture<Boolean>()
        main.post {
            try {
                check(value, job)
                val themed = ContextThemeWrapper(service(), android.R.style.Theme_Material_Light_Dialog_Alert)
                val dialog = AlertDialog.Builder(themed).setTitle("确认手机操作 · ${value.label}").setMessage("当前任务已授权，但此操作需要你核对。\n${if (operation == "input") "替换字段文字为：\n$text" else if (operation == "back") "返回上一界面，可能离开未保存内容。" else "点击：$label"}\n不确定时请取消。")
                    .setPositiveButton("仅执行这一次") { _, _ -> decision.complete(true) }.setNegativeButton("取消") { _, _ -> decision.complete(false) }.create()
                job.dialog = dialog; dialog.window?.setType(WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY); dialog.setOnDismissListener { decision.complete(false) }; dialog.show()
            } catch (_: Throwable) { decision.complete(false) }
        }
        val accepted = try { decision.get(45, TimeUnit.SECONDS) } finally { main.post { job.dialog?.dismiss(); job.dialog = null } }
        if (!accepted) fail("review_declined"); check(value, job); Thread.sleep(250)
    }
    fun submit(raw: String): String = runCatching {
        ready(); if (raw.toByteArray(Charsets.UTF_8).size > 16384) fail("invalid_request")
        val body = JSONObject(raw); val allowed = setOf("scope", "grantId", "requestId", "operation", "snapshotId", "nodeId", "text")
        if (body.keys().asSequence().any { it !in allowed }) fail("invalid_request")
        val s = scope(body.getJSONObject("scope").toString()); val id = body.getString("requestId"); val op = body.getString("operation")
        if (!DeviceUiPolicy.id(id) || op !in listOf("observe", "click", "input", "back")) fail("invalid_request")
        if ((op == "observe" && body.keys().asSequence().any { it in setOf("snapshotId", "nodeId", "text") }) || (op != "observe" && (body.opt("snapshotId") !is String || (op != "back" && body.opt("nodeId") !is String))) || (op == "input" && body.opt("text") !is String) || (op != "input" && body.has("text"))) fail("invalid_request")
        val value = owned(s.json().toString(), body.getString("grantId")); val key = "receipt_" + mac(origin + s.json().toString() + id)
        val fingerprint = mac(body.toString() + value.taskDigest + value.runId)
        prefs.getString(key, null)?.let { stored -> val receipt = JSONObject(stored); if (receipt.optString("fingerprint") != fingerprint) fail("request_conflict"); return@runCatching envelope(JSONObject().put("state", "complete").put("replayed", true).put("receipt", receipt).put("requestId", id)) }
        jobs[id]?.let { if (it.scope != s || it.grantId != value.id) fail("request_conflict"); return@runCatching result(s.json().toString(), id) }
        trimJobs(); if (jobs.size >= 64) fail("busy")
        val job = Job(id, s, op, value.id); jobs[id] = job
        executor.execute {
            var reserved = false
            try {
                authority(value, job)
                if (op == "observe") { val snapshot = capture(value); check(value, job); finish(job, JSONObject().put("state", "complete").put("snapshot", snapshot.json)); return@execute }
                if (!value.actions || value.runId.isEmpty()) fail("read_only")
                val snapshot = snapshots[body.optString("snapshotId")] ?: fail("stale_snapshot")
                if (snapshot.grant != value.id || System.currentTimeMillis() - snapshot.at > 120000) fail("stale_snapshot")
                val target = if (op == "back") null else snapshot.nodes[body.optString("nodeId")] ?: fail("invalid_node")
                val text = if (op == "input") body.optString("text") else ""
                if (op == "input" && !DeviceUiPolicy.inputText(text)) fail("invalid_text")
                val label = snapshot.json.getJSONArray("nodes").let { rows -> (0 until rows.length()).map { rows.getJSONObject(it) }.firstOrNull { it.optString("id") == body.optString("nodeId") }?.let { it.optString("text") + " " + it.optString("description") } }.orEmpty()
                if (op == "click" && label.isBlank()) fail("unlabeled_node")
                val page = snapshot.json.getJSONArray("nodes").toString()
                if (DeviceUiPolicy.review(op, page, label, value.dirty)) review(value, job, op, label.take(160), text)
                authority(value, job)
                if (prefs.all.keys.count { it.startsWith("receipt_") } >= 256) fail("receipt_capacity")
                val intent = JSONObject().put("requestId", id).put("grantId", value.id).put("operation", op).put("state", "uncertain").put("fingerprint", fingerprint).put("at", System.currentTimeMillis())
                if (!prefs.edit().putString(key, intent.toString()).commit()) fail("state_unavailable")
                reserved = true; snapshots.remove(snapshot.id)
                val accepted = run {
                    check(value, job)
                    if (capture(value).fingerprint != snapshot.fingerprint) fail("stale_snapshot")
                    check(value, job)
                    if (op == "back") service().performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
                    else { val n = node(value, target!!); try { if (op == "input") { if (!n.isEditable) fail("invalid_node"); n.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text) }) } else { if (!n.isClickable) fail("invalid_node"); n.performAction(AccessibilityNodeInfo.ACTION_CLICK) } } finally { n.recycle() } }
                }
                if (!accepted) fail("action_unconfirmed"); if (op == "input") value.dirty = true
                Thread.sleep(350); authority(value, job)
                val after = capture(value); val inputVerified = if (op == "input") runCatching { val current = currentNode(value, target!!.path); try { current.isEditable && !current.isPassword && current.text?.toString() == text } finally { current.recycle() } }.getOrDefault(false) else false
                val receipt = intent.put("state", "requested").put("inputVerified", inputVerified).put("uiChanged", snapshot.fingerprint != after.fingerprint)
                if (!prefs.edit().putString(key, receipt.toString()).commit()) fail("state_unavailable")
                check(value, job); finish(job, JSONObject().put("state", "complete").put("receipt", receipt).put("snapshot", after.json))
            } catch (error: Throwable) { job.cancelled = true; finish(job, JSONObject().put("state", "failed").put("code", if (reserved) "action_uncertain" else (error as? Failure)?.code ?: "unavailable")) }
            finally { job.call = null; main.post { job.dialog?.dismiss(); job.dialog = null } }
        }
        envelope(JSONObject().put("state", "pending").put("requestId", id))
    }.getOrElse { error((it as? Failure)?.code ?: "invalid_request") }
    fun result(raw: String, id: String): String = runCatching {
        ready(); val s = scope(raw); val job = jobs[id]
        val stored = prefs.getString("receipt_" + mac(origin + s.json().toString() + id), null)
        if (job != null) { if (job.scope != s) fail("invalid_scope"); if (stored != null && (job.result.optString("state") == "failed" || (job.grantId.isNotEmpty() && !grants.containsKey(job.grantId)))) return@runCatching envelope(JSONObject().put("state", "complete").put("replayed", true).put("requestId", id).put("receipt", JSONObject(stored))); if (job.grantId.isNotEmpty()) check(grants[job.grantId] ?: fail("grant_expired")); return@runCatching envelope(JSONObject(job.result.toString()).put("requestId", id)) }
        val receipt = stored ?: fail("request_missing")
        envelope(JSONObject().put("state", "complete").put("replayed", true).put("requestId", id).put("receipt", JSONObject(receipt)))
    }.getOrElse { error((it as? Failure)?.code ?: "unavailable") }
    fun cancel(raw: String, id: String): String = runCatching { ready(); val s = scope(raw); val job = jobs[id] ?: fail("request_missing"); if (job.scope != s) fail("invalid_scope"); synchronized(job) { job.cancelled = true; job.call?.cancel(); if (job.operation == "grant") { val grantId = job.result.optJSONObject("grant")?.optString("id"); if (grantId != null) { grants.remove(grantId); snapshots.entries.removeIf { it.value.grant == grantId } }; finish(job, JSONObject().put("state", "failed").put("code", "cancelled")) } }; main.post { job.dialog?.dismiss() }; error("cancelled") }.getOrElse { error((it as? Failure)?.code ?: "unavailable") }
    fun receipt(raw: String, id: String): String = runCatching { ready(); val s = scope(raw); if (!DeviceUiPolicy.id(id)) fail("invalid_request"); val value = prefs.getString("receipt_" + mac(origin + s.json().toString() + id), null); if (value != null) envelope(JSONObject().put("state", "complete").put("replayed", true).put("requestId", id).put("receipt", JSONObject(value))) else { val job = jobs[id] ?: fail("request_missing"); if (job.scope != s) fail("invalid_scope"); envelope(JSONObject().put("state", job.result.optString("state", "pending")).put("requestId", id).put("operation", job.operation).apply { if (job.result.has("code")) put("code", job.result.getString("code")) }) } }.getOrElse { error((it as? Failure)?.code ?: "unavailable") }
    fun revoke(raw: String, id: String): String = runCatching { ready(); val s = scope(raw); val value = grants[id] ?: fail("grant_missing"); if (value.scope != s) fail("invalid_scope"); grants.remove(value.id); snapshots.entries.removeIf { it.value.grant == value.id }; jobs.values.filter { it.grantId == id }.forEach { it.cancelled = true; it.call?.cancel(); it.result = JSONObject().put("state", "failed").put("code", "grant_expired"); main.post { it.dialog?.dismiss() } }; val edit = prefs.edit(); prefs.all.filterKeys { it.startsWith("receipt_") }.forEach { (key, rawValue) -> runCatching { val receipt = JSONObject(rawValue as String); if (receipt.optString("grantId") == id && receipt.optString("state") == "requested") edit.remove(key) } }; edit.commit(); envelope(JSONObject().put("state", "complete")) }.getOrElse { error((it as? Failure)?.code ?: "unavailable") }
    // React cleanup is not guaranteed on WebView reload/navigation. Native
    // work must stop even when the old JS document disappears without cleanup.
    fun invalidateDocument() {
        jobs.values.forEach { job -> synchronized(job) { job.cancelled = true; job.call?.cancel(); job.result = JSONObject().put("state", "failed").put("code", "cancelled"); main.post { job.dialog?.dismiss() } } }
        grants.clear(); snapshots.clear()
    }
    fun close() { closed = true; invalidateDocument(); jobs.clear(); executor.shutdownNow() }
}
