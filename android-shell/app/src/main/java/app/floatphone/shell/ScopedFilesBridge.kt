package app.floatphone.shell

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.CancellationSignal
import android.provider.DocumentsContract
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** SAF only. No raw paths, network, deletion, overwrite, shell or model access. */
class ScopedFilesBridge(context: Context, private val origin: String, private val trusted: () -> Boolean) {
    init { require(origin.startsWith("https://")) { "untrusted_source" } }
    private val app = context.applicationContext
    private val resolver = app.contentResolver
    private val prefs = app.getSharedPreferences("float_scoped_files_v1", Context.MODE_PRIVATE)
    private val worker = ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS, LinkedBlockingQueue<Runnable>(8))
    private class Job(val scope: JSONObject, val digest: String) {
        val signal = CancellationSignal()
        @Volatile var cancelled = false
        @Volatile var writing = false
        @Volatile var grantId: String? = null
        var path: String? = null
        var expectedDigest: String? = null
        var expectedBytes: Int = 0
        @Volatile var result: JSONObject? = null
        val at = System.currentTimeMillis()
    }
    private val jobs = ConcurrentHashMap<String, Job>()
    @Volatile private var closed = false
    private val lock = Any()
    private fun envelope() = JSONObject().put("protocol", "float-shell-files/v1").put("location", "android_device")
    private fun error(code: String) = envelope().put("ok", false).put("code", code)
    private fun complete(result: JSONObject) = envelope().put("ok", true).put("state", "complete").put("result", result)
    fun capabilities(): String = envelope().put("ok", true).put("createOnly", true).put("maxTextBytes", ScopedFilePolicy.MAX_BYTES).put("maxDirectoryEntries", 128).toString()
    private fun check(job: Job) {
        if (closed || !trusted() || job.cancelled) throw IllegalArgumentException("cancelled")
    }
    private fun exact(value: JSONObject, keys: Set<String>) {
        if (value.keys().asSequence().toSet() != keys) throw IllegalArgumentException("invalid_request")
    }
    private fun scope(raw: String): JSONObject {
        if (raw.length > 512) throw IllegalArgumentException("invalid_scope")
        val value = JSONObject(raw); exact(value, setOf("mode", "workspaceId"))
        ScopedFilePolicy.mode(value.getString("mode")); ScopedFilePolicy.id(value.getString("workspaceId"))
        return value
    }
    private fun same(a: JSONObject, b: JSONObject) = a.optString("mode") == b.optString("mode") && a.optString("workspaceId") == b.optString("workspaceId")
    private fun records(key: String): JSONArray = JSONArray(prefs.getString(key, "[]") ?: "[]")
    private fun elements(array: JSONArray) = (0 until array.length()).map { array.getJSONObject(it) }
    private fun commit(key: String, rows: List<JSONObject>) {
        if (!prefs.edit().putString(key, JSONArray(rows).toString()).commit()) throw IllegalArgumentException("storage_failed")
    }
    private fun publicGrant(grant: JSONObject): JSONObject {
        val uri = Uri.parse(grant.getString("uri"))
        val permission = resolver.persistedUriPermissions.find { it.uri == uri }
        return JSONObject().put("id", grant.getString("id")).put("label", grant.getString("label"))
            .put("readable", permission?.isReadPermission == true).put("writable", permission?.isWritePermission == true)
    }
    private fun grant(job: Job, id: String, requireRead: Boolean = true): JSONObject = synchronized(lock) {
        ScopedFilePolicy.id(id)
        val found = elements(records("grants")).find { it.optString("id") == id && it.optString("origin") == origin && same(it.getJSONObject("scope"), job.scope) }
            ?: throw IllegalArgumentException("grant_scope")
        if (requireRead && !publicGrant(found).getBoolean("readable")) throw IllegalArgumentException("permission_revoked")
        found
    }
    private fun reserve(id: String, selected: JSONObject, digest: String): Job {
        ScopedFilePolicy.id(id)
        jobs[id]?.let {
            if (!same(it.scope, selected) || it.digest != digest) throw IllegalArgumentException("id_conflict")
            return it
        }
        for ((key, value) in jobs) if (value.result != null && System.currentTimeMillis() - value.at > 300_000) jobs.remove(key, value)
        if (jobs.size >= 32) throw IllegalArgumentException("busy")
        return Job(selected, digest).also { jobs[id] = it }
    }
    /** UI chooses the tree. Replaying the same picker request never opens a second dialog. */
    fun beginPicker(rawScope: String, id: String, launch: () -> Unit): String = try {
        synchronized(lock) {
            val selected = scope(rawScope)
            val digest = ScopedFilePolicy.digest(("picker:" + selected.toString()).toByteArray(Charsets.UTF_8))
            val existing = jobs.containsKey(id)
            val job = reserve(id, selected, digest); check(job)
            if (!existing) try { launch() } catch (failure: Throwable) { job.result = safeFailure(failure) }
            result(rawScope, id)
        }
    } catch (failure: Throwable) { safeFailure(failure).toString() }
    fun finishPicker(id: String, uri: Uri?, flags: Int) {
        val job = jobs[id] ?: return
        try {
            worker.execute {
                try {
                    check(job)
                    if (uri == null) { job.result = error("cancelled"); return@execute }
                    if (uri.scheme != "content" || uri.authority.isNullOrBlank() || !DocumentsContract.isTreeUri(uri)) throw IllegalArgumentException("invalid_tree")
                    val take = flags and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                    if (take and Intent.FLAG_GRANT_READ_URI_PERMISSION == 0) throw IllegalArgumentException("permission_revoked")
                    synchronized(lock) {
                        val all = elements(records("grants"))
                        if (all.size >= 32) throw IllegalArgumentException("grant_capacity")
                        resolver.takePersistableUriPermission(uri, take)
                        val root = DocumentsContract.buildDocumentUriUsingTree(uri, DocumentsContract.getTreeDocumentId(uri))
                        val name = metadata(root, job).getString("name").filter { it.code >= 32 && it.code !in 0x202a..0x202e && it.code !in 0x2066..0x2069 }.take(80)
                        check(job)
                        val added = JSONObject().put("id", UUID.randomUUID().toString()).put("scope", job.scope).put("origin", origin).put("uri", uri.toString()).put("label", name.ifBlank { "授权目录" })
                        commit("grants", all + added)
                        job.result = complete(JSONObject().put("grant", publicGrant(added)))
                    }
                } catch (failure: Throwable) { job.result = safeFailure(failure) }
            }
        } catch (_: Throwable) { job.result = error("busy") }
    }
    private fun metadata(uri: Uri, job: Job): JSONObject {
        check(job)
        val columns = arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE, DocumentsContract.Document.COLUMN_DOCUMENT_ID)
        return resolver.query(uri, columns, null, null, null, job.signal)?.use { cursor ->
            if (!cursor.moveToFirst()) throw IllegalArgumentException("file_missing")
            JSONObject().put("name", cursor.getString(0)).put("directory", cursor.getString(1) == DocumentsContract.Document.MIME_TYPE_DIR)
                .put("bytes", if (cursor.isNull(2) || cursor.getLong(2) < 0) JSONObject.NULL else cursor.getLong(2)).put("documentId", cursor.getString(3))
        } ?: throw IllegalArgumentException("provider_unavailable")
    }
    private fun children(tree: Uri, parent: Uri, job: Job): List<JSONObject> {
        check(job)
        val uri = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getDocumentId(parent))
        val columns = arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE, DocumentsContract.Document.COLUMN_DOCUMENT_ID)
        return resolver.query(uri, columns, null, null, null, job.signal)?.use { cursor ->
            val rows = mutableListOf<JSONObject>()
            while (cursor.moveToNext()) {
                check(job)
                if (rows.size >= 128) throw IllegalArgumentException("directory_capacity")
                val name = ScopedFilePolicy.path(cursor.getString(0), false)
                if (name.contains('/')) throw IllegalArgumentException("invalid_path")
                rows.add(JSONObject().put("name", name).put("directory", cursor.getString(1) == DocumentsContract.Document.MIME_TYPE_DIR)
                    .put("bytes", if (cursor.isNull(2) || cursor.getLong(2) < 0) JSONObject.NULL else cursor.getLong(2)).put("documentId", cursor.getString(3)))
            }
            rows.sortedBy { it.getString("name") }
        } ?: throw IllegalArgumentException("provider_unavailable")
    }
    private fun resolve(tree: Uri, path: String, job: Job): Uri {
        var current = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
        if (path.isEmpty()) return current
        for (name in path.split('/')) {
            if (!metadata(current, job).getBoolean("directory")) throw IllegalArgumentException("not_directory")
            val matches = children(tree, current, job).filter { it.getString("name") == name }
            if (matches.size != 1) throw IllegalArgumentException(if (matches.isEmpty()) "file_missing" else "ambiguous_name")
            current = DocumentsContract.buildDocumentUriUsingTree(tree, matches.single().getString("documentId"))
            val root = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
            if (!DocumentsContract.isChildDocument(resolver, root, current)) throw IllegalArgumentException("outside_tree")
        }
        return current
    }
    private fun read(uri: Uri, job: Job): ByteArray {
        check(job)
        return resolver.openInputStream(uri)?.use { input ->
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(4096)
            while (true) {
                check(job)
                val count = input.read(buffer); if (count < 0) break
                if (output.size() + count > ScopedFilePolicy.MAX_BYTES) throw IllegalArgumentException("text_capacity")
                output.write(buffer, 0, count)
            }
            output.toByteArray().also { ScopedFilePolicy.decode(it) }
        } ?: throw IllegalArgumentException("provider_unavailable")
    }
    private fun journal(job: Job, id: String, digest: String, result: JSONObject?) = synchronized(lock) {
        val rows = elements(records("writes")).toMutableList()
        val old = rows.indexOfFirst { it.optString("id") == id && it.optString("origin") == origin && same(it.getJSONObject("scope"), job.scope) }
        if (old < 0 && rows.size >= 128) throw IllegalArgumentException("receipt_capacity")
        val entry = JSONObject().put("id", id).put("origin", origin).put("scope", job.scope).put("grantId", job.grantId).put("digest", digest).put("path", job.path).put("expectedDigest", job.expectedDigest).put("expectedBytes", job.expectedBytes).put("result", result ?: error("write_uncertain"))
        if (old >= 0) rows[old] = entry else rows.add(entry)
        commit("writes", rows)
    }
    private fun oldWrite(selected: JSONObject, id: String): JSONObject? = synchronized(lock) {
        elements(records("writes")).find { it.optString("id") == id && it.optString("origin") == origin && same(it.getJSONObject("scope"), selected) }
    }
    fun submit(raw: String): String = try {
        if (raw.length > 80_000) throw IllegalArgumentException("request_capacity")
        val body = JSONObject(raw); val op = body.getString("operation")
        val keys = setOf("operation", "requestId", "scope") + when (op) {
            "grants" -> emptySet()
            "revoke" -> setOf("grantId")
            "list", "read" -> setOf("grantId", "path")
            "create" -> setOf("grantId", "path", "content")
            else -> throw IllegalArgumentException("operation_forbidden")
        }
        exact(body, keys)
        val selected = scope(body.getJSONObject("scope").toString()); val id = ScopedFilePolicy.id(body.getString("requestId"))
        val digest = ScopedFilePolicy.digest(raw.toByteArray(Charsets.UTF_8))
        synchronized(lock) {
            val previous = oldWrite(selected, id)
            if (previous != null) {
                if (previous.getString("digest") != digest) throw IllegalArgumentException("id_conflict")
                return@synchronized previous.getJSONObject("result").toString()
            }
            val existing = jobs.containsKey(id); val job = reserve(id, selected, digest); check(job)
            if (!existing) worker.execute { execute(body, job, id, digest) }
            result(selected.toString(), id)
        }
    } catch (failure: Throwable) { safeFailure(failure).toString() }
    private fun execute(body: JSONObject, job: Job, id: String, digest: String) {
        try {
            check(job)
            val op = body.getString("operation")
            if (op == "grants") {
                val rows = synchronized(lock) { elements(records("grants")).filter { it.optString("origin") == origin && same(it.getJSONObject("scope"), job.scope) }.map { publicGrant(it) } }
                job.result = complete(JSONObject().put("grants", JSONArray(rows))); return
            }
            job.grantId = body.getString("grantId")
            val grant = grant(job, body.getString("grantId"), op != "revoke"); val tree = Uri.parse(grant.getString("uri"))
            if (op == "revoke") {
                synchronized(lock) {
                    val remaining = elements(records("grants")).filter { it.optString("id") != grant.getString("id") }
                    commit("grants", remaining)
                    for (other in jobs.values) if (other !== job && other.grantId == job.grantId) { other.cancelled = true; other.result = error("permission_revoked"); other.signal.cancel() }
                    commit("writes", elements(records("writes")).filter { it.optString("grantId") != job.grantId })
                    if (remaining.none { it.optString("uri") == tree.toString() }) runCatching {
                        val held = resolver.persistedUriPermissions.find { it.uri == tree }
                        val flags = (if (held?.isReadPermission == true) Intent.FLAG_GRANT_READ_URI_PERMISSION else 0) or (if (held?.isWritePermission == true) Intent.FLAG_GRANT_WRITE_URI_PERMISSION else 0)
                        if (flags != 0) resolver.releasePersistableUriPermission(tree, flags)
                    }
                }
                job.result = complete(JSONObject().put("revoked", true)); return
            }
            val path = ScopedFilePolicy.path(body.getString("path"), op == "list")
            if (op == "create") {
                ScopedFilePolicy.textPath(path); val bytes = ScopedFilePolicy.encode(body.getString("content"))
                if (!publicGrant(grant).getBoolean("writable")) throw IllegalArgumentException("read_only")
                val parentPath = path.substringBeforeLast('/', ""); val name = path.substringAfterLast('/')
                val parent = resolve(tree, parentPath, job)
                if (!metadata(parent, job).getBoolean("directory")) throw IllegalArgumentException("not_directory")
                if (children(tree, parent, job).any { it.getString("name") == name }) throw IllegalArgumentException("file_exists")
                job.path = path; job.expectedDigest = ScopedFilePolicy.digest(bytes); job.expectedBytes = bytes.size
                synchronized(job) { check(job); journal(job, id, digest, null); job.writing = true }
                // From this point failure is uncertain, never automatically retried.
                val mime = when (name.substringAfterLast('.').lowercase()) { "md" -> "text/markdown"; "json" -> "application/json"; "csv" -> "text/csv"; else -> "text/plain" }
                val made = DocumentsContract.createDocument(resolver, parent, mime, name) ?: throw IllegalArgumentException("write_uncertain")
                if (made.scheme != "content" || made.authority != tree.authority) throw IllegalArgumentException("write_uncertain")
                if (metadata(made, job).getString("name") != name || !DocumentsContract.isChildDocument(resolver, DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree)), made)) throw IllegalArgumentException("write_uncertain")
                check(job)
                resolver.openOutputStream(made, "w")?.use { output -> output.write(bytes); output.flush() } ?: throw IllegalArgumentException("write_uncertain")
                val actual = read(made, job)
                if (!actual.contentEquals(bytes)) throw IllegalArgumentException("write_uncertain")
                val done = complete(JSONObject().put("path", path).put("bytes", bytes.size).put("digest", ScopedFilePolicy.digest(bytes)).put("created", true))
                journal(job, id, digest, done); job.result = done; return
            }
            val uri = resolve(tree, path, job)
            if (op == "list") {
                if (!metadata(uri, job).getBoolean("directory")) throw IllegalArgumentException("not_directory")
                val rows = children(tree, uri, job).map { item -> JSONObject(item.toString()).apply { remove("documentId") } }
                job.result = complete(JSONObject().put("path", path).put("files", JSONArray(rows))); return
            }
            ScopedFilePolicy.textPath(path)
            if (metadata(uri, job).getBoolean("directory")) throw IllegalArgumentException("not_file")
            val bytes = read(uri, job)
            job.result = complete(JSONObject().put("path", path).put("content", ScopedFilePolicy.decode(bytes)).put("bytes", bytes.size).put("digest", ScopedFilePolicy.digest(bytes)))
        } catch (failure: Throwable) {
            job.result = if (job.writing) error("write_uncertain") else safeFailure(failure)
            if (job.writing) runCatching { journal(job, id, digest, job.result) }
        }
    }
    fun result(rawScope: String, id: String): String = try {
        val selected = scope(rawScope); ScopedFilePolicy.id(id)
        val job = jobs[id]
        if (job != null) {
            if (!same(job.scope, selected)) throw IllegalArgumentException("grant_scope")
            (job.result ?: envelope().put("ok", true).put("state", "pending")).toString()
        } else (oldWrite(selected, id)?.getJSONObject("result") ?: error("request_missing")).toString()
    } catch (failure: Throwable) { safeFailure(failure).toString() }
    /** Explicit recovery only reads the original target and compares the durable hash. */
    fun verify(rawScope: String, id: String): String = try {
        val selected = scope(rawScope); ScopedFilePolicy.id(id)
        synchronized(lock) {
            val current = jobs[id]
            if (current != null && !same(current.scope, selected)) throw IllegalArgumentException("grant_scope")
            if (current != null && current.result == null) return@synchronized result(rawScope, id)
            val old = oldWrite(selected, id) ?: return@synchronized error("request_missing").toString()
            if (old.getJSONObject("result").optBoolean("ok", false)) return@synchronized old.getJSONObject("result").toString()
            val job = Job(selected, old.getString("digest"))
            job.grantId = old.getString("grantId"); job.path = old.getString("path"); job.expectedDigest = old.getString("expectedDigest"); job.expectedBytes = old.getInt("expectedBytes")
            jobs[id] = job
            try { worker.execute {
                try {
                    check(job)
                    val allowed = grant(job, job.grantId!!); val tree = Uri.parse(allowed.getString("uri"))
                    val bytes = read(resolve(tree, ScopedFilePolicy.textPath(job.path), job), job)
                    if (bytes.size != job.expectedBytes || ScopedFilePolicy.digest(bytes) != job.expectedDigest) throw IllegalArgumentException("write_uncertain")
                    val done = complete(JSONObject().put("path", job.path).put("bytes", bytes.size).put("digest", job.expectedDigest).put("created", true))
                    journal(job, id, job.digest, done); job.result = done
                } catch (_: Throwable) { job.result = error("write_uncertain") }
            } } catch (_: Throwable) { job.result = error("write_uncertain") }
            result(rawScope, id)
        }
    } catch (failure: Throwable) { safeFailure(failure).toString() }
    fun cancel(rawScope: String, id: String): String { return try {
        val selected = scope(rawScope); val job = jobs[ScopedFilePolicy.id(id)] ?: return error("request_missing").toString()
        if (!same(job.scope, selected)) throw IllegalArgumentException("grant_scope")
        synchronized(job) { if (job.writing) error("write_uncertain").toString() else {
            job.cancelled = true; job.signal.cancel(); result(rawScope, id)
        } }
    } catch (failure: Throwable) { safeFailure(failure).toString() } }
    private fun safeFailure(failure: Throwable): JSONObject {
        val known = setOf("invalid_id", "invalid_scope", "invalid_path", "invalid_text", "invalid_utf8", "unsupported_text", "text_capacity", "request_capacity", "invalid_request", "operation_forbidden", "busy", "cancelled", "grant_scope", "permission_revoked", "grant_capacity", "receipt_capacity", "storage_failed", "file_missing", "provider_unavailable", "directory_capacity", "not_directory", "not_file", "ambiguous_name", "outside_tree", "read_only", "file_exists", "id_conflict", "write_uncertain")
        return error(if (failure is SecurityException) "permission_revoked" else failure.message?.takeIf { it in known } ?: "provider_unavailable")
    }
    fun close() { closed = true; jobs.values.forEach { it.cancelled = true; it.signal.cancel() }; worker.shutdownNow() }
}
