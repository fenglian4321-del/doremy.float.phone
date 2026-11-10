package app.floatphone.shell

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import org.json.JSONObject
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/** No browser API returns credentials. App backups are disabled in the manifest. */
class SiteCredentialStore(context: Context, private val origin: String) {
    class Credential(val username: String, val password: String) { override fun toString() = "[protected site credential]" }
    private val prefs = context.getSharedPreferences("float_site_login_encrypted_v1", Context.MODE_PRIVATE)
    private val alias = "float_site_login_aes_v1"
    private fun entry(realm: String) = MessageDigest.getInstance("SHA-256").digest((origin + "\u0000" + realm).toByteArray()).joinToString("") { "%02x".format(it) }
    private fun key(create: Boolean): SecretKey? {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        if (!create) return null
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true).setUserAuthenticationRequired(false).setKeySize(256).build())
        }.generateKey()
    }
    @Synchronized fun read(realm: String): Credential? {
        if (!SiteCredentialCodec.validRealm(realm)) return null
        val name = entry(realm)
        return runCatching {
            val encoded = prefs.getString(name, null) ?: return null
            val key = key(false) ?: run { prefs.edit().remove(name).commit(); return null }
            val plain = SiteCredentialCodec.decrypt(key, origin, realm, encoded)
            try {
                val value = JSONObject(plain.toString(Charsets.UTF_8))
                val user = value.getString("username"); val password = value.getString("password")
                if (!SiteHttpAuthPolicy.validInput(user, password)) return null
                Credential(user, password)
            } finally { plain.fill(0) }
        }.getOrElse { prefs.edit().remove(name).commit(); null }
    }
    @Synchronized fun save(realm: String, credential: Credential): Boolean = runCatching {
        if (!SiteCredentialCodec.validRealm(realm) || !SiteHttpAuthPolicy.validInput(credential.username, credential.password)) return false
        if (prefs.all.size >= 16 && !prefs.contains(entry(realm))) return false
        val plain = JSONObject().put("username", credential.username).put("password", credential.password).toString().toByteArray(Charsets.UTF_8)
        try { prefs.edit().putString(entry(realm), SiteCredentialCodec.encrypt(key(true)!!, origin, realm, plain)).commit() }
        finally { plain.fill(0) }
    }.getOrDefault(false)
    @Synchronized fun reject(realm: String) { prefs.edit().remove(entry(realm)).commit() }
    @Synchronized fun hasSaved() = prefs.all.isNotEmpty()
    @Synchronized fun forget(): Boolean = runCatching {
        if (!prefs.edit().clear().commit()) return false
        KeyStore.getInstance("AndroidKeyStore").apply { load(null); if (containsAlias(alias)) deleteEntry(alias) }
        true
    }.getOrDefault(false)
}
