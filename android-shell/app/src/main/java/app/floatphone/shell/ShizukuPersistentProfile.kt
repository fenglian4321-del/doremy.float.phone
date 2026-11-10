package app.floatphone.shell

import android.app.Activity
import android.app.AlertDialog
import android.content.ComponentName
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Durable user-approved capabilities, with one-use local tickets per tool call. */
class ShizukuPersistentProfile(
    private val activity: Activity, private val trusted: () -> Boolean,
    private val ready: () -> Unit, private val uid: () -> Int,
    private val invoke: (String, String, String) -> String, private val cancelRemote: (String) -> Unit
) {
    private val prefs = activity.getSharedPreferences("float_shizuku_profile_v1", Context.MODE_PRIVATE)
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private val watcher = Executors.newSingleThreadScheduledExecutor()
    @Volatile private var documentEpoch = 0
    @Volatile private var closed = false
    private data class Ticket(val id: String, val scope: String, val revision: Int, val epoch: Int, val uid: Int, val until: Long = SystemClock.elapsedRealtime() + 90000, var used: Boolean = false)
    private class Job(val id: String, val scope: String, val operation: String, val ticket: String = "") {
        @Volatile var cancelled = false
        @Volatile var reserved = false
        @Volatile var value = JSONObject().put("state", "pending")
        @Volatile var dialog: AlertDialog? = null
    }
    private val tickets = ConcurrentHashMap<String, Ticket>()
    private val jobs = ConcurrentHashMap<String, Job>()
    private class Failure(val code: String) : RuntimeException(code)
    private fun fail(code: String): Nothing = throw Failure(code)
    private fun hash(text: String) = MessageDigest.getInstance("SHA-256").digest(text.toByteArray()).joinToString("") { "%02x".format(it) }
    private fun envelope(v: JSONObject) = v.put("protocol", "float-shizuku/v1").toString()
    private fun error(code: String) = envelope(JSONObject().put("state", "failed").put("code", code))
    private fun here() { if (closed || !trusted() || activity.isFinishing || activity.isDestroyed) fail("untrusted_origin") }
    private fun active() { here(); ready() }
    fun enabled() = prefs.getBoolean("enabled", false)
    private fun revision() = prefs.getInt("revision", 0)
    private fun apps() = JSONArray(prefs.getString("apps", "[]"))
    fun view() = JSONObject().put("version", 1).put("configured", prefs.contains("enabled")).put("enabled", enabled()).put("allowChat", prefs.getBoolean("allowChat", true)).put("allowLaunch", prefs.getBoolean("allowLaunch", false)).put("revision", revision()).put("applications", apps()).put("recent", JSONArray(prefs.getString("recent", "[]")))
    private fun scope(v: JSONObject): String {
        if (v.keys().asSequence().toSet() != setOf("mode", "workspaceId") || v.optString("mode") !in listOf("chat", "group_chat", "work", "private") || !DeviceUiPolicy.id(v.optString("workspaceId"))) fail("invalid_scope")
        return JSONObject().put("mode", v.getString("mode")).put("workspaceId", v.getString("workspaceId")).toString()
    }
    private fun allowedScope(scope: String) { active(); if (!enabled()) fail("profile_disabled"); if (JSONObject(scope).getString("mode") in listOf("chat", "group_chat") && !prefs.getBoolean("allowChat", true)) fail("chat_disabled") }
    private fun ticket(scope: String, id: String): Ticket {
        allowedScope(scope); val t = tickets[id] ?: fail("ticket_expired")
        if (t.scope != scope || t.revision != revision() || t.epoch != documentEpoch || t.uid != uid() || SystemClock.elapsedRealtime() >= t.until) fail("ticket_expired")
        return t
    }
    private fun check(t: Ticket, j: Job) { ticket(j.scope, t.id); if (j.cancelled) fail("cancelled") }
    private fun finish(j: Job, v: JSONObject) { j.value = v.put("requestId", j.id).put("operation", j.operation) }
    private fun cancel(j: Job) { if (j.value.optString("state") != "pending") return; j.cancelled = true; runCatching { cancelRemote(j.id) }; main.post { j.dialog?.dismiss() }; finish(j, JSONObject().put("state", "failed").put("code", if (j.reserved) "action_uncertain" else "cancelled")) }
    fun invalidate() { documentEpoch++; tickets.clear(); jobs.values.forEach { cancel(it) } }
    fun disable() { if (!prefs.edit().putBoolean("enabled", false).putInt("revision", revision() + 1).commit()) fail("state_unavailable"); invalidate() }
    private fun changed(except: Job) { documentEpoch++; tickets.clear(); jobs.values.filter { it !== except }.forEach { cancel(it) } }
    private fun confirm(j: Job, title: String, text: String, action: () -> Unit) {
        main.post {
            if (j.cancelled || closed || !trusted()) { cancel(j); return@post }
            val dialog = AlertDialog.Builder(activity).setTitle(title).setMessage(text).setNegativeButton("取消") { _, _ -> cancel(j) }.setPositiveButton("保存此授权") { _, _ ->
                runCatching { active(); if (j.cancelled) fail("cancelled"); action() }.onFailure { finish(j, JSONObject().put("state", "failed").put("code", (it as? Failure)?.code ?: "unavailable")) }
            }.create(); j.dialog = dialog; dialog.setOnCancelListener { cancel(j) }; dialog.show()
        }
    }
    fun ownsPicker(id: String) = jobs[id]?.operation == "profile_add_app"
    fun picked(id: String, component: ComponentName?) {
        val j = jobs[id] ?: return
        runCatching {
            active(); if (j.cancelled || component == null || !ShizukuPolicy.packageAllowed(component.packageName, activity.packageName)) fail("package_denied")
            val label = activity.packageManager.getApplicationLabel(activity.packageManager.getApplicationInfo(component.packageName, 0)).toString().take(80)
            confirm(j, "持续允许使用 $label？", "将此应用加入本机Shizuku允许列表。启用的角色聊天和工作区可查询它${if (prefs.getBoolean("allowLaunch", false)) "并直接启动它，不再逐次申请任务授权" else "；尚未允许自动启动"}。应用名、包名和结果可发送给当前模型服务，不读取应用内容。可随时移除。") {
                val rows = apps(); if ((0 until rows.length()).none { rows.getJSONObject(it).optString("packageName") == component.packageName }) { if (rows.length() >= 16) fail("application_capacity"); rows.put(JSONObject().put("packageName", component.packageName).put("label", label)) }
                if (!prefs.edit().putString("apps", rows.toString()).putInt("revision", revision() + 1).commit()) fail("state_unavailable")
                changed(j); finish(j, JSONObject().put("state", "complete").put("profile", view()))
            }
        }.onFailure { finish(j, JSONObject().put("state", "failed").put("code", (it as? Failure)?.code ?: "unavailable")) }
    }
    @Synchronized private fun recent(j: Job, label: String, ok: Boolean, code: String = "") {
        val old = JSONArray(prefs.getString("recent", "[]")); val rows = JSONArray()
        rows.put(JSONObject().put("requestId", j.id).put("operation", j.operation).put("label", label).put("ok", ok).put("code", code).put("at", System.currentTimeMillis()))
        for (i in 0 until minOf(old.length(), 19)) rows.put(old.get(i))
        prefs.edit().putString("recent", rows.toString()).commit()
    }
    private fun key(scope: String, id: String) = "receipt_" + hash(scope + id)
    private fun maintain() {
        val now = SystemClock.elapsedRealtime()
        tickets.entries.removeIf { now >= it.value.until }
        if (jobs.size >= 128) jobs.entries.removeIf { it.value.value.optString("state") != "pending" }
        val receipts = prefs.all.filterKeys { it.startsWith("receipt_") }
        if (receipts.size >= 512) {
            // A retired one-use ticket cannot execute again, even after pruning
            // confirmed metadata. Unknown outcomes are never pruned here.
            val edit = prefs.edit()
            receipts.entries.sortedBy { runCatching { JSONObject(it.value as String).optLong("at") }.getOrDefault(Long.MAX_VALUE) }.take(receipts.size - 64).forEach { (k, raw) ->
                runCatching { val r = JSONObject(raw as String); if (r.optString("state") == "complete" && !tickets.containsKey(r.optString("ticketId"))) edit.remove(k) }
            }; edit.commit()
        }
    }
    fun control(raw: String, picker: (String) -> Unit): String = runCatching {
        here(); maintain(); if (raw.toByteArray().size > 8192) fail("invalid_request")
        val b = JSONObject(raw); val op = b.getString("operation")
        val fields = when (op) {
            "profile_config" -> setOf("operation", "scope", "requestId", "enabled", "allowChat", "allowLaunch")
            "profile_add_app" -> setOf("operation", "scope", "requestId")
            "profile_remove_app" -> setOf("operation", "packageName")
            "profile_begin" -> setOf("operation", "scope")
            "profile_end" -> setOf("operation", "scope", "ticketId")
            "profile_action" -> setOf("operation", "scope", "ticketId", "requestId", "action", "packageName")
            "profile_result", "profile_receipt", "profile_cancel" -> setOf("operation", "scope", "requestId")
            else -> fail("invalid_request")
        }; if (b.keys().asSequence().toSet() != fields) fail("invalid_request")
        if (op == "profile_config" || op == "profile_add_app") {
            val id = b.getString("requestId"); if (!DeviceUiPolicy.id(id) || jobs.size >= 128) fail("invalid_request")
            val j = Job(id, scope(b.getJSONObject("scope")), op); if (jobs.putIfAbsent(id, j) != null) fail("request_conflict")
            if (op == "profile_add_app") { active(); main.post { runCatching { picker(id) }.onFailure { cancel(j) } } }
            else {
                if (listOf("enabled", "allowChat", "allowLaunch").any { b.opt(it) !is Boolean }) fail("invalid_request")
                if (!b.getBoolean("enabled")) { if (!prefs.edit().putBoolean("enabled", false).putInt("revision", revision() + 1).commit()) fail("state_unavailable"); changed(j); finish(j, JSONObject().put("state", "complete").put("profile", view())) }
                else { active(); confirm(j, "启用Shizuku持续模式？", "保存到此手机，后续对话不再每次申请任务授权。${if (b.getBoolean("allowChat")) "允许Float角色聊天及" else "允许"}工作区使用。${if (b.getBoolean("allowLaunch")) "允许直接启动允许列表中的应用，无须逐次确认。" else "仅查询，不启动应用。"}不会开放任意shell、读取应用内容、私有文件、截屏或输入。允许的应用名/包名和结果可交给当前模型服务。关闭或撤权即停，断连不会重放旧任务。") {
                    if (!prefs.edit().putBoolean("enabled", true).putBoolean("allowChat", b.getBoolean("allowChat")).putBoolean("allowLaunch", b.getBoolean("allowLaunch")).putInt("revision", revision() + 1).commit()) fail("state_unavailable")
                    changed(j); finish(j, JSONObject().put("state", "complete").put("profile", view()))
                } }
            }
            return@runCatching envelope(JSONObject(j.value.toString()).put("requestId", id))
        }
        if (op == "profile_remove_app") {
            val pkg = b.getString("packageName"); val old = apps(); val rows = JSONArray(); for (i in 0 until old.length()) if (old.getJSONObject(i).optString("packageName") != pkg) rows.put(old.get(i))
            if (!prefs.edit().putString("apps", rows.toString()).putInt("revision", revision() + 1).commit()) fail("state_unavailable")
            invalidate(); return@runCatching envelope(JSONObject().put("state", "complete").put("profile", view()))
        }
        val s = scope(b.getJSONObject("scope"))
        if (op in listOf("profile_result", "profile_receipt", "profile_cancel")) {
            val id = b.getString("requestId"); if (!DeviceUiPolicy.id(id)) fail("invalid_request")
            val j = jobs[id]; if (j != null && j.scope != s) fail("invalid_scope")
            if (op == "profile_cancel") { if (j != null) { tickets.remove(j.ticket); cancel(j) }; return@runCatching error("cancelled") }
            if (op == "profile_result" && j != null && !j.cancelled) return@runCatching envelope(JSONObject(j.value.toString()).put("requestId", id))
            val r = prefs.getString(key(s, id), null) ?: fail("request_missing")
            return@runCatching envelope(JSONObject().put("state", "complete").put("requestId", id).put("replayed", true).put("receipt", JSONObject(r)))
        }
        if (op == "profile_begin") {
            allowedScope(s); if (tickets.size >= 64) fail("busy")
            val t = Ticket(UUID.randomUUID().toString(), s, revision(), documentEpoch, uid()); tickets[t.id] = t
            return@runCatching envelope(JSONObject().put("state", "complete").put("ticketId", t.id).put("revision", t.revision))
        }
        val tid = b.getString("ticketId")
        if (op == "profile_end") {
            val t = tickets[tid]; if (t != null && t.scope != s) fail("invalid_scope")
            tickets.remove(tid); jobs.values.filter { it.ticket == tid }.forEach { cancel(it) }
            return@runCatching envelope(JSONObject().put("state", "complete"))
        }
        val t = ticket(s, tid); val id = b.getString("requestId"); val action = b.getString("action"); val pkg = b.getString("packageName")
        if (!DeviceUiPolicy.id(id) || action !in listOf("apps", "system_info", "app_info", "launch_app")) fail("invalid_request")
        val selected = apps().let { rows -> (0 until rows.length()).map { rows.getJSONObject(it) }.firstOrNull { it.optString("packageName") == pkg } }
        if (action in listOf("app_info", "launch_app") && selected == null) fail("package_denied")
        if (action !in listOf("app_info", "launch_app") && pkg.isNotEmpty()) fail("invalid_request")
        if (action == "launch_app" && !prefs.getBoolean("allowLaunch", false)) fail("read_only")
        val k = key(s, id); val fingerprint = hash(t.id + s + action + pkg)
        prefs.getString(k, null)?.let { previous -> val r = JSONObject(previous); if (r.optString("fingerprint") != fingerprint) fail("request_conflict"); return@runCatching envelope(JSONObject().put("state", "complete").put("requestId", id).put("replayed", true).put("receipt", r)) }
        synchronized(t) { if (t.used) fail("ticket_used"); t.used = true }
        if (prefs.all.count { it.key.startsWith("receipt_") } >= 512 || jobs.size >= 128) fail("receipt_capacity")
        val j = Job(id, s, action, tid); if (jobs.putIfAbsent(id, j) != null) fail("request_conflict")
        worker.execute {
            var timer: java.util.concurrent.ScheduledFuture<*>? = null
            val label = selected?.optString("label") ?: "手机"
            try {
                check(t, j)
                val r = JSONObject().put("requestId", id).put("operation", action).put("state", "uncertain").put("ticketId", tid).put("at", System.currentTimeMillis()).put("fingerprint", fingerprint)
                if (!prefs.edit().putString(k, r.toString()).commit()) fail("state_unavailable")
                j.reserved = true; check(t, j)
                timer = watcher.scheduleWithFixedDelay({ if (j.value.optString("state") == "pending") runCatching { check(t, j) }.onFailure { cancel(j) } }, 100, 300, TimeUnit.MILLISECONDS)
                val result = if (action == "apps") JSONObject().put("applications", apps()).put("uid", uid()) else JSONObject(invoke(id, action, pkg))
                check(t, j); if (result.optInt("uid", -1) != t.uid) fail("identity_denied")
                result.put("operation", action).put("location", "android_shizuku").put("label", label).put("untrustedData", true).put("businessSuccessVerified", false)
                synchronized(j) { check(t, j); r.put("state", "complete"); if (!prefs.edit().putString(k, r.toString()).commit()) fail("state_unavailable"); finish(j, JSONObject().put("state", "complete").put("data", result).put("receipt", r)); recent(j, label, true) }
            } catch (e: Throwable) { val code = if (j.reserved) "action_uncertain" else (e as? Failure)?.code ?: "unavailable"; finish(j, JSONObject().put("state", "failed").put("code", code)); recent(j, label, false, code) }
            finally { timer?.cancel(false) }
        }
        envelope(JSONObject().put("state", "pending").put("requestId", id))
    }.getOrElse { error((it as? Failure)?.code ?: "unavailable") }
    fun close() { closed = true; invalidate(); worker.shutdownNow(); watcher.shutdownNow() }
}
