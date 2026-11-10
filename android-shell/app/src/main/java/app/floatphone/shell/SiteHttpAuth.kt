package app.floatphone.shell

import android.app.Activity
import android.app.AlertDialog
import android.os.Handler
import android.os.Looper
import android.text.InputFilter
import android.text.InputType
import android.view.View
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.webkit.HttpAuthHandler
import android.webkit.WebView
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView

/** UI-thread-only handlers; confirmed login can be remembered in native encrypted storage. */
class SiteHttpAuth(private val activity: Activity, site: String, private val clearRecovery: () -> Unit, private val recovery: () -> Unit) {
    private val policy = SiteHttpAuthPolicy(site)
    private val main = Handler(Looper.getMainLooper())
    private val saved = SiteCredentialStore(activity, policy.displayOrigin())
    private data class Submitted(val credential: SiteCredentialStore.Credential, val epoch: Long, val realm: String, val remember: Boolean, val automatic: Boolean)
    private var submitted: Submitted? = null
    private var automaticEpoch = -1L
    private class Pending(val handler: HttpAuthHandler, val epoch: Long) {
        var settled = false
        var dialog: AlertDialog? = null
        var username: EditText? = null
        var password: EditText? = null
    }
    private var pending: Pending? = null
    private var deferred: Runnable? = null
    private var closed = false
    private var challengeCount = 0
    private var status = "尚未发起站点加载"
    private var lastChallenge = "尚未收到"
    private fun cancel(value: Pending) {
        if (!value.settled) { value.settled = true; runCatching { value.handler.cancel() } }
        value.username?.text?.clear(); value.password?.text?.clear()
        value.username = null; value.password = null
        if (pending === value) pending = null
        val dialog = value.dialog; value.dialog = null; dialog?.dismiss()
    }
    private fun cancelDeferred() { deferred?.let { main.removeCallbacks(it) }; deferred = null }
    fun requested(url: String) { submitted = null; cancelDeferred(); pending?.let { cancel(it) }; policy.begin(url); status = "已准备主文档，等待认证挑战" }
    fun started(url: String?) {
        val before = policy.epoch(); policy.started(url.orEmpty())
        if (policy.epoch() != before) { submitted = null; cancelDeferred(); pending?.let { cancel(it) } }
    }
    fun navigationRequested() { submitted = null; cancelDeferred(); pending?.let { cancel(it) }; policy.invalidate(); status = "导航改变，旧认证已取消" }
    fun resource(url: String, mainFrame: Boolean) { policy.resource(url, mainFrame) }
    fun finished(url: String?): Boolean {
        val epoch = policy.epoch()
        val complete = policy.finished(url.orEmpty(), pending != null)
        if (complete) {
            val candidate = submitted; submitted = null
            status = "主文档加载完成"
            if (candidate != null && candidate.epoch == epoch && candidate.remember && !candidate.automatic) {
                status = if (saved.save(candidate.realm, candidate.credential)) "登录成功，已在本机加密记住" else "登录成功，但本机未能记住；下次需重新输入"
            }
        }
        return complete
    }
    fun forgetSaved(): Boolean {
        submitted = null; automaticEpoch = policy.epoch(); pending?.let { cancel(it) }
        val ok = saved.forget(); status = if (ok) "已忘记保存登录；现有站点会话可能继续有效" else "忘记保存登录未完成"
        return ok
    }
    fun diagnostics() = "$status；收到认证挑战 $challengeCount 次；上次挑战：$lastChallenge"
    fun authenticationFailure(url: String): Boolean {
        if (!policy.authFailure(url)) return false
        if (pending == null) status = "站点认证响应未完成，等待认证回调"
        val epoch = policy.epoch(); cancelDeferred()
        val action = Runnable { deferred = null; if (!closed && !activity.isFinishing && !activity.isDestroyed && pending == null && policy.belongs(epoch)) recovery() }
        deferred = action; main.postDelayed(action, 1000)
        return true
    }
    fun challenge(view: WebView, handler: HttpAuthHandler, host: String, realm: String) {
        // This API has no request URL/frame. Accept only the main-document
        // loading window before ANY subresource; ambiguous challenges are cancelled.
        challengeCount++
        if (closed || activity.isFinishing || activity.isDestroyed || !SiteCredentialCodec.validRealm(realm) || !policy.canChallenge(host, view.url)) {
            status = "认证已取消：" + if (closed || activity.isFinishing || activity.isDestroyed) "页面已退出" else policy.rejection(host, view.url)
            lastChallenge = status
            runCatching { handler.cancel() }; return
        }
        cancelDeferred(); pending?.let { cancel(it) }; clearRecovery()
        val previous = submitted
        if (previous != null && previous.epoch == policy.epoch()) {
            if (previous.automatic) saved.reject(previous.realm)
            submitted = null
        }
        if (automaticEpoch != policy.epoch() && previous == null) {
            val credential = saved.read(realm)
            if (credential != null && policy.submit(policy.epoch(), host, view.url)) {
                automaticEpoch = policy.epoch()
                submitted = Submitted(credential, policy.epoch(), realm, true, true)
                status = "正在使用本机已保存登录"; lastChallenge = "已提交本站本机加密登录"
                runCatching { handler.proceed(credential.username, credential.password) }.onFailure { submitted = null; runCatching { handler.cancel() }; status = "保存登录未完成，请手动登录"; recovery() }
                return
            }
        }
        val value = Pending(handler, policy.epoch()); pending = value
        val fields = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL; setPadding(40, 8, 40, 8); isSaveEnabled = false; importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS }
        fields.addView(TextView(activity).apply { text = "仅登录 ${policy.displayOrigin()}\n请输入你本人的站点账号和密码；记住登录时仅在本机加密保存，不交给网页脚本。" })
        val username = EditText(activity).apply { hint = "站点账号"; contentDescription = "站点账号"; inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS; isSingleLine = true; isSaveEnabled = false; filters = arrayOf(InputFilter.LengthFilter(256)); importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS; imeOptions = EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING or EditorInfo.IME_FLAG_NO_EXTRACT_UI }
        val password = EditText(activity).apply { hint = "站点密码"; contentDescription = "站点密码"; inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD; isSingleLine = true; isSaveEnabled = false; filters = arrayOf(InputFilter.LengthFilter(1024)); importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS; imeOptions = EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING or EditorInfo.IME_FLAG_NO_EXTRACT_UI }
        value.username = username; value.password = password; fields.addView(username); fields.addView(password)
        val remember = CheckBox(activity).apply { text = "记住此设备登录（成功后加密保存）"; isChecked = true; isSaveEnabled = false }
        fields.addView(remember)
        val dialog = AlertDialog.Builder(activity).setTitle("登录私人站点").setView(fields).setNegativeButton("取消") { _, _ -> status = "本人取消登录"; cancel(value); recovery() }.setPositiveButton("登录", null).create()
        value.dialog = dialog
        dialog.setOnCancelListener { status = "本人取消登录"; cancel(value); recovery() }
        dialog.setOnDismissListener { cancel(value) }
        dialog.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        try {
            dialog.show()
            status = "登录框已显示，等待本人输入"
            lastChallenge = "已显示原生登录框"
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                if (closed || pending !== value || value.settled || activity.isFinishing || activity.isDestroyed || !policy.belongs(value.epoch)) { cancel(value); return@setOnClickListener }
                val user = username.text.toString(); val pass = password.text.toString()
                if (!SiteHttpAuthPolicy.validInput(user, pass)) { password.error = "请填写有效账号和密码"; return@setOnClickListener }
                if (!policy.submit(value.epoch, host, view.url)) { cancel(value); recovery(); return@setOnClickListener }
                value.settled = true; pending = null
                status = "已手动提交，等待站点响应"
                submitted = Submitted(SiteCredentialStore.Credential(user, pass), value.epoch, realm, remember.isChecked, false)
                if (!remember.isChecked) saved.reject(realm)
                // Save only after this main document successfully finishes.
                // The encrypted store is never exposed through JS, URLs or logs.
                runCatching { handler.proceed(user, pass) }.onFailure { submitted = null; runCatching { handler.cancel() }; status = "提交认证响应未完成"; recovery() }
                cancel(value)
            }
        } catch (_: Throwable) { status = "原生登录框未能显示"; cancel(value); recovery() }
    }
    fun close() { closed = true; submitted = null; cancelDeferred(); pending?.let { cancel(it) }; policy.invalidate() }
}
