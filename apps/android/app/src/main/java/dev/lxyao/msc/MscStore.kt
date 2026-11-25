package dev.lxyao.msc

import android.content.Context
import androidx.core.content.edit
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.json.JSONObject

internal class MscStore(context: Context) : TokenStore {
    private val prefs = EncryptedSharedPreferences.create(
        context,
        "msc_secure",
        MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    var baseUrl: String?
        get() = prefs.getString(KEY_BASE, null)
        set(value) {
            prefs.edit { putString(KEY_BASE, value) }
        }

    val deviceToken: String?
        get() = prefs.getString(KEY_DEVICE, null)

    override fun deviceStamp(): TokenStamp? {
        val token = deviceToken ?: return null
        return TokenStamp(
            token = token,
            issuedAtMs = prefs.getLong(KEY_DEVICE_ISSUED, 0),
            ttlMs = prefs.getLong(KEY_DEVICE_TTL, 0),
        )
    }

    override fun saveDeviceToken(token: String, ttlMs: Long, issuedAtMs: Long) {
        prefs.edit {
            putString(KEY_DEVICE, token)
            putLong(KEY_DEVICE_TTL, ttlMs)
            putLong(KEY_DEVICE_ISSUED, issuedAtMs)
        }
    }

    var pushEndpoint: String?
        get() = prefs.getString(KEY_PUSH, null)
        set(value) {
            prefs.edit { putString(KEY_PUSH, value) }
        }

    fun sessionToken(sessionId: String): String? = sessionStamp(sessionId)?.token

    override fun sessionStamp(sessionId: String): TokenStamp? = sessionStamps()[sessionId]

    override fun saveSessionToken(
        sessionId: String,
        token: String,
        ttlMs: Long,
        issuedAtMs: Long,
    ) {
        val map = sessionStamps()
        map[sessionId] = TokenStamp(token, issuedAtMs, ttlMs)
        val json = JSONObject()
        for ((key, stamp) in map) {
            json.put(
                key,
                JSONObject()
                    .put("token", stamp.token)
                    .put("issuedAtMs", stamp.issuedAtMs)
                    .put("ttlMs", stamp.ttlMs),
            )
        }
        prefs.edit { putString(KEY_SESSIONS, json.toString()) }
    }

    fun clear() {
        prefs.edit { clear() }
    }

    private fun sessionStamps(): MutableMap<String, TokenStamp> {
        val raw = prefs.getString(KEY_SESSIONS, null) ?: return mutableMapOf()
        return try {
            val json = JSONObject(raw)
            val map = mutableMapOf<String, TokenStamp>()
            for (key in json.keys()) {
                when (val value = json.opt(key)) {
                    is String -> map[key] = TokenStamp(value, 0, 0)
                    is JSONObject -> map[key] = TokenStamp(
                        token = value.optString("token"),
                        issuedAtMs = value.optLong("issuedAtMs", 0),
                        ttlMs = value.optLong("ttlMs", 0),
                    )
                }
            }
            map
        } catch (_: Exception) {
            mutableMapOf()
        }
    }

    private companion object {
        const val KEY_BASE = "base_url"
        const val KEY_DEVICE = "device_token"
        const val KEY_DEVICE_TTL = "device_token_ttl_ms"
        const val KEY_DEVICE_ISSUED = "device_token_issued_at_ms"
        const val KEY_SESSIONS = "session_tokens"
        const val KEY_PUSH = "push_endpoint"
    }
}
