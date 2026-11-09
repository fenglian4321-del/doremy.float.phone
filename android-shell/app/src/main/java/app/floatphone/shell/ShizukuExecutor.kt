package app.floatphone.shell

import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.os.Process
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit

/** Instantiated by Shizuku app_process, NOT an Android application Service. */
class ShizukuExecutor : IShizukuExecutor.Stub() {
    private var owner: IBinder? = null
    private var ownerUid = -1
    private var token = ""
    private val seen = ConcurrentHashMap.newKeySet<String>()
    private val cancelled = ConcurrentHashMap.newKeySet<String>()
    private val processes = ConcurrentHashMap<String, java.lang.Process>()
    @Synchronized override fun attach(client: IBinder, secret: String): String {
        if (secret.length !in 32..160 || !ShizukuPolicy.identity(Process.myUid())) throw SecurityException("identity_denied")
        if (owner != null && (ownerUid != Binder.getCallingUid() || token != secret)) throw SecurityException("owner_denied")
        if (owner == null) {
            owner = client; ownerUid = Binder.getCallingUid(); token = secret
            client.linkToDeath({ shutdown() }, 0)
        }
        return identity().toString()
    }
    private fun identity() = JSONObject().put("uid", Process.myUid()).put("identity", if (Process.myUid() == 0) "root" else "shell").put("sdk", Build.VERSION.SDK_INT).put("release", Build.VERSION.RELEASE)
    private fun check(secret: String, id: String) {
        if (ownerUid != Binder.getCallingUid() || token != secret || owner?.isBinderAlive != true || cancelled.contains(id)) throw SecurityException("cancelled_or_owner_denied")
    }
    private fun command(id: String, argv: List<String>): String {
        if (cancelled.contains(id) || owner?.isBinderAlive != true) throw SecurityException("cancelled")
        val child = ProcessBuilder(argv).redirectErrorStream(true).start()
        processes[id] = child
        val reader = FutureTask {
            child.inputStream.use { stream ->
                val output = ByteArrayOutputStream(); val buffer = ByteArray(1024)
                while (true) { val n = stream.read(buffer); if (n < 0) break; if (output.size() + n > 16384) throw IllegalStateException("output_capacity"); output.write(buffer, 0, n) }
                Charsets.UTF_8.newDecoder().onMalformedInput(java.nio.charset.CodingErrorAction.REPORT).decode(java.nio.ByteBuffer.wrap(output.toByteArray())).toString()
            }
        }
        val thread = Thread(reader, "float-shizuku-output"); thread.isDaemon = true; thread.start()
        try {
            val deadline = android.os.SystemClock.elapsedRealtime() + 6000
            while (!child.waitFor(50, TimeUnit.MILLISECONDS)) {
                if (cancelled.contains(id) || owner?.isBinderAlive != true || android.os.SystemClock.elapsedRealtime() > deadline) throw IllegalStateException("cancelled_or_timeout")
                if (reader.isDone) reader.get(1, TimeUnit.SECONDS) // propagate capacity/read failures
            }
            val text = reader.get(1, TimeUnit.SECONDS)
            if (child.exitValue() != 0 || cancelled.contains(id)) throw IllegalStateException("command_failed")
            return text
        } finally { processes.remove(id, child); child.destroyForcibly(); reader.cancel(true); runCatching { child.inputStream.close() } }
    }
    override fun execute(secret: String, id: String, operation: String, pkg: String): String {
        check(secret, id)
        if (!DeviceUiPolicy.id(id) || !ShizukuPolicy.operation(operation) || seen.size >= 128 || !seen.add(id)) throw SecurityException("invalid_or_replayed_request")
        val result = identity().put("operation", operation).put("location", "android_shizuku").put("untrustedData", true)
        if (operation != "system_info") {
            if (!ShizukuPolicy.packageAllowed(pkg, "app.floatphone.shell")) throw SecurityException("package_denied")
            val resolved = command(id, ShizukuPolicy.resolve(pkg)).lineSequence().map { it.trim() }.firstOrNull { it.startsWith(pkg + "/") && it.matches(Regex("[A-Za-z0-9_.$]+/[A-Za-z0-9_.$]+")) } ?: throw IllegalStateException("application_unavailable")
            result.put("packageName", pkg).put("launcher", resolved)
            if (operation == "app_info") {
                val paths = command(id, ShizukuPolicy.packagePath(pkg)).lineSequence().filter { it.startsWith("package:") }.toList()
                if (paths.isEmpty()) throw IllegalStateException("application_unavailable")
                result.put("installed", true).put("apkCount", paths.size) // do not return filesystem paths
            } else {
                val output = command(id, ShizukuPolicy.launch(pkg, resolved))
                if (!output.contains("Status: ok")) throw IllegalStateException("launch_unconfirmed")
                result.put("activityManagerReported", true).put("businessSuccessVerified", false)
            }
        }
        check(secret, id)
        return result.toString()
    }
    override fun cancel(secret: String, id: String) { checkOwner(secret); cancelled.add(id); processes[id]?.destroyForcibly() }
    private fun checkOwner(secret: String) { if (ownerUid != Binder.getCallingUid() || token != secret) throw SecurityException("owner_denied") }
    private fun shutdown() { processes.values.forEach { it.destroyForcibly() }; kotlin.system.exitProcess(0) }
    override fun destroy() { shutdown() }
}
