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
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView

/** UI-thread-only handlers; credentials exist only in this dialog and WebView's response. */
class SiteHttpAuth(private val activity: Activity, site: String, private val clearRecovery: () -> Unit, private val recovery: () -> Unit) {
    private val policy = SiteHttpAuthPolicy(site)
    private val main = Handler(Looper.getMainLooper())
    private class Pending(val handler: HttpAuthHandler, val epoch: Long) {
        var settled = false
        var dialog: AlertDialog? = null
        var username: EditText? = null
        var password: EditText? = null
    }
    private var pending: Pending? = null
    private var deferred: Runnable? = null
    private var closed = false
    private fun cancel(value: Pending) {
        if (!value.settled) { value.settled = true; runCatching { value.handler.cancel() } }
        value.username?.text?.clear(); value.password?.text?.clear()
        value.username = null; value.password = null
        if (pending === value) pending = null
        val dialog = value.dialog; value.dialog = null; dialog?.dismiss()
    }
    private fun cancelDeferred() { deferred?.let { main.removeCallbacks(it) }; deferred = null }
    fun started(url: String?) { cancelDeferred(); pending?.let { cancel(it) }; policy.begin(url.orEmpty()) }
    fun navigationRequested() { cancelDeferred(); pending?.let { cancel(it) }; policy.invalidate() }
    fun resource(url: String, mainFrame: Boolean) { policy.resource(url, mainFrame) }
    fun finished(url: String?): Boolean = policy.finished(url.orEmpty(), pending != null)
    fun authenticationFailure(url: String): Boolean {
        if (!policy.authFailure(url)) return false
        val epoch = policy.epoch(); cancelDeferred()
        val action = Runnable { deferred = null; if (!closed && !activity.isFinishing && !activity.isDestroyed && pending == null && policy.belongs(epoch)) recovery() }
        deferred = action; main.postDelayed(action, 1000)
        return true
    }
    fun challenge(view: WebView, handler: HttpAuthHandler, host: String) {
        // This API has no request URL/frame. Accept only the main-document
        // loading window before ANY subresource; ambiguous challenges are cancelled.
        if (closed || activity.isFinishing || activity.isDestroyed || !policy.canChallenge(host, view.url)) { runCatching { handler.cancel() }; return }
        cancelDeferred(); pending?.let { cancel(it) }; clearRecovery()
        val value = Pending(handler, policy.epoch()); pending = value
        val fields = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL; setPadding(40, 8, 40, 8); isSaveEnabled = false; importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS }
        fields.addView(TextView(activity).apply { text = "仅登录 ${policy.displayOrigin()}\n请输入你本人的站点账号和密码；不写入应用设置或交给网页脚本。" })
        val username = EditText(activity).apply { hint = "站点账号"; contentDescription = "站点账号"; inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS; isSingleLine = true; isSaveEnabled = false; filters = arrayOf(InputFilter.LengthFilter(256)); importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS; imeOptions = EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING or EditorInfo.IME_FLAG_NO_EXTRACT_UI }
        val password = EditText(activity).apply { hint = "站点密码"; contentDescription = "站点密码"; inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD; isSingleLine = true; isSaveEnabled = false; filters = arrayOf(InputFilter.LengthFilter(1024)); importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS; imeOptions = EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING or EditorInfo.IME_FLAG_NO_EXTRACT_UI }
        value.username = username; value.password = password; fields.addView(username); fields.addView(password)
        val dialog = AlertDialog.Builder(activity).setTitle("登录私人站点").setView(fields).setNegativeButton("取消") { _, _ -> cancel(value); recovery() }.setPositiveButton("登录", null).create()
        value.dialog = dialog
        dialog.setOnCancelListener { cancel(value); recovery() }
        dialog.setOnDismissListener { cancel(value) }
        dialog.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        try {
            dialog.show()
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                if (closed || pending !== value || value.settled || activity.isFinishing || activity.isDestroyed || !policy.belongs(value.epoch)) { cancel(value); return@setOnClickListener }
                val user = username.text.toString(); val pass = password.text.toString()
                if (!SiteHttpAuthPolicy.validInput(user, pass)) { password.error = "请填写有效账号和密码"; return@setOnClickListener }
                if (!policy.submit(value.epoch, host, view.url)) { cancel(value); recovery(); return@setOnClickListener }
                value.settled = true; pending = null
                // Never use get/setHttpAuthUsernamePassword, logs, URLs, JS,
                // preferences or a captured credential for automatic retries.
                runCatching { handler.proceed(user, pass) }.onFailure { recovery() }
                cancel(value)
            }
        } catch (_: Throwable) { cancel(value); recovery() }
    }
    fun close() { closed = true; cancelDeferred(); pending?.let { cancel(it) }; policy.invalidate() }
}
