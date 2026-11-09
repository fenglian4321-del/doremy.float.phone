package app.floatphone.shell

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.webkit.CookieManager
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/** Optional owner-only wake notification. Never reads hints, models or phone UI. */
class XinchaoOfflineWake(private val context: Context, private val notify: (String, String) -> Unit) {
    companion object {
        private const val PREFS = "float_xinchao_offline_v1"
        private const val PROTOCOL = "float-shell-xinchao-wake/v1"
        private val stateLock = Any()
        private fun origin(): String? = runCatching {
            val uri = Uri.parse(MainActivity.SITE_URL)
            if (uri.scheme != "https" || uri.host.isNullOrBlank() || uri.userInfo != null) null else "https://${uri.encodedAuthority}"
        }.getOrNull()
        fun notificationsAllowed(context: Context): Boolean =
            (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) && NotificationManagerCompat.from(context).areNotificationsEnabled()
        fun enabled(context: Context): Boolean {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            return origin() != null && prefs.getString("origin", "") == origin() && prefs.getBoolean("enabled", false)
        }
        fun status(context: Context): String = JSONObject().put("protocol", PROTOCOL).put("location", "android_device")
            .put("supported", origin() != null).put("enabled", enabled(context)).put("notificationsGranted", notificationsAllowed(context))
            .put("status", context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("status", "off")).toString()
        fun configure(context: Context, value: Boolean): String = synchronized(stateLock) {
            val site = origin()
            if (site == null || (value && !notificationsAllowed(context))) return JSONObject(status(context)).put("ok", false).put("code", if (site == null) "trusted_https_required" else "notification_permission").toString()
            val saved = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("origin", site).putBoolean("enabled", value).putString("status", if (value) "waiting" else "off").commit()
            if (saved) PushService.refreshXinchaoWake(context)
            JSONObject(status(context)).put("ok", saved).toString()
        }
    }
    @Volatile private var closed = false
    @Volatile private var call: Call? = null
    @Volatile var running = false
        private set
    private var worker: Thread? = null
    private val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .connectTimeout(8, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).callTimeout(32, TimeUnit.SECONDS).build()
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private fun state(value: String) { prefs.edit().putString("status", value).apply() }
    private fun endpoint(path: String): String = origin().orEmpty() + path
    private fun request(path: String, body: String = ""): okhttp3.Response {
        if (closed || !enabled(context) || !notificationsAllowed(context)) throw IllegalStateException("stopped")
        val url = endpoint(path)
        // Owner cookie is scoped to /api/shared-memory, not the site root.
        val cookie = CookieManager.getInstance().getCookie(url).orEmpty()
        if (cookie.isEmpty()) { state("owner_session_required"); throw IllegalStateException("owner_session") }
        val request = Request.Builder().url(url).header("Origin", origin().orEmpty()).header("Cookie", cookie)
            .header("Accept", if (path.endsWith("/events")) "text/event-stream" else "application/json")
            .post(body.toRequestBody("application/json".toMediaType())).build()
        val next = client.newCall(request); call = next
        if (closed || !enabled(context)) { next.cancel(); throw IllegalStateException("stopped") }
        return next.execute()
    }
    private fun bytes(response: okhttp3.Response, limit: Int): String {
        val body = response.body ?: throw IllegalStateException("empty")
        if (!response.header("Content-Type", "").orEmpty().lowercase().contains("application/json")) throw IllegalStateException("protocol")
        val stream = body.byteStream(); val output = java.io.ByteArrayOutputStream(); val buffer = ByteArray(2048)
        while (true) { val count = stream.read(buffer); if (count < 0) break; if (output.size() + count > limit) throw IllegalStateException("capacity"); output.write(buffer, 0, count) }
        return Charsets.UTF_8.newDecoder().onMalformedInput(java.nio.charset.CodingErrorAction.REPORT).decode(java.nio.ByteBuffer.wrap(output.toByteArray())).toString()
    }
    private fun configured(): Boolean {
        request("/api/shared-memory/xinchao/proactive", "{\"operation\":\"catalog\"}").use { response ->
            if (response.code == 401 || response.code == 403) { state("owner_session_required"); return false }
            if (!response.isSuccessful) { state("service_unavailable"); return false }
            val value = JSONObject(bytes(response, 16384))
            if (value.opt("ok") != true || value.optString("protocol") != "float-xinchao-proactive/v1" || value.opt("available") != true) { state("service_unavailable"); return false }
            val settings = value.optJSONObject("settings") ?: throw IllegalStateException("protocol")
            if (settings.opt("enabled") != true || settings.opt("offlineNotify") != true) {
                prefs.edit().putBoolean("enabled", false).putString("status", "server_disabled").commit()
                return false
            }
            return true
        }
    }
    private fun deliver(value: JSONObject): Unit = synchronized(stateLock) {
        if (closed || !enabled(context) || !notificationsAllowed(context)) return
        if (value.keys().asSequence().toSet() != setOf("deliveryId", "sessionId", "cooldownMinutes")) throw IllegalStateException("protocol")
        val id = value.opt("deliveryId") as? String ?: throw IllegalStateException("protocol")
        val session = value.opt("sessionId") as? String ?: throw IllegalStateException("protocol")
        val cooldown = value.opt("cooldownMinutes") as? Number ?: throw IllegalStateException("protocol")
        if (!XinchaoWakePolicy.deliveryId(id) || !XinchaoWakePolicy.sessionId(session) || cooldown.toDouble() != cooldown.toInt().toDouble() || cooldown.toInt() !in 5..1440) throw IllegalStateException("protocol")
        val seen = JSONArray(prefs.getString("seen", "[]")); val values = (0 until seen.length()).map { seen.optString(it) }
        val now = System.currentTimeMillis()
        if (id in values || !XinchaoWakePolicy.mayNotify(prefs.getLong("lastNotificationAt", 0), now, cooldown.toInt())) return
        val retained = JSONArray(); (values + id).takeLast(128).forEach { retained.put(it) }
        // Reserve before posting. Process death cannot replay the same alert.
        if (!prefs.edit().putString("seen", retained.toString()).putLong("lastNotificationAt", now).commit()) { state("storage_unconfirmed"); return }
        try { notify(id, session); state("wake_notified") } catch (_: Throwable) { state("notification_unconfirmed") }
    }
    private fun subscribe() {
        request("/api/shared-memory/xinchao/proactive/events").use { response ->
            if (!response.isSuccessful || !response.header("Content-Type", "").orEmpty().lowercase().contains("text/event-stream")) throw IllegalStateException("stream")
            val source = response.body?.source() ?: throw IllegalStateException("empty")
            var ready = false; var total = 0; var event = ""; val data = mutableListOf<String>()
            while (!closed && enabled(context) && !source.exhausted()) {
                val line = source.readUtf8LineStrict(32768).trimEnd('\r'); total += line.toByteArray(Charsets.UTF_8).size + 1
                if (total > 131072) throw IllegalStateException("capacity")
                if (line.isEmpty()) {
                    if (event.isNotEmpty()) {
                        if (event == "ready" && !ready) { val value = JSONObject(data.joinToString("\n")); if (value.optString("protocol") != "float-xinchao-proactive-stream/v1") throw IllegalStateException("protocol"); ready = true; state("connected") }
                        else if (!ready) throw IllegalStateException("protocol")
                        else if (event == "notify") deliver(JSONObject(data.joinToString("\n")))
                        else if (event == "paused") throw IllegalStateException("paused")
                        else if (event != "inbox") throw IllegalStateException("protocol")
                    }
                    event = ""; data.clear()
                } else if (line.startsWith(":")) { /* heartbeat */ }
                else if (line.startsWith("event:") && event.isEmpty()) event = line.substring(6).trim()
                else if (line.startsWith("data:")) { data.add(line.substring(5).trimStart()); if (data.sumOf { it.length } > 65536) throw IllegalStateException("capacity") }
                else throw IllegalStateException("protocol")
            }
        }
    }
    fun start() {
        if (running || closed || !enabled(context)) return
        running = true
        worker = thread(name = "float-xinchao-offline", isDaemon = true) {
            try { while (!closed && enabled(context)) {
                if (!notificationsAllowed(context)) { state("notification_permission"); break }
                var delay = 5000L
                try { if (configured()) subscribe() else delay = 60000L } catch (_: Throwable) { if (!closed) state("connection_unconfirmed"); delay = 60000L }
                finally { call = null }
                if (!closed && enabled(context)) Thread.sleep(delay)
            } } catch (_: InterruptedException) { /* explicit stop */ }
            finally { running = false; call?.cancel(); call = null }
        }
    }
    fun close() { closed = true; call?.cancel(); worker?.interrupt() }
}
