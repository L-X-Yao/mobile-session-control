package dev.lxyao.msc

import android.content.Context
import androidx.core.content.edit
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.json.JSONObject

class MscStore(context: Context) {
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

    var deviceToken: String?
        get() = prefs.getString(KEY_DEVICE, null)
        set(value) {
            prefs.edit { putString(KEY_DEVICE, value) }
        }

    fun sessionToken(sessionId: String): String? {
        val map = sessionTokens()
        return map[sessionId]
    }

    fun saveSessionToken(sessionId: String, token: String) {
        val map = sessionTokens()
        map[sessionId] = token
        val json = JSONObject()
        for ((key, value) in map) json.put(key, value)
        prefs.edit { putString(KEY_SESSIONS, json.toString()) }
    }

    fun clear() {
        prefs.edit { clear() }
    }

    private fun sessionTokens(): MutableMap<String, String> {
        val raw = prefs.getString(KEY_SESSIONS, null) ?: return mutableMapOf()
        return try {
            val json = JSONObject(raw)
            val map = mutableMapOf<String, String>()
            for (key in json.keys()) map[key] = json.getString(key)
            map
        } catch (_: Exception) {
            mutableMapOf()
        }
    }

    private companion object {
        const val KEY_BASE = "base_url"
        const val KEY_DEVICE = "device_token"
        const val KEY_SESSIONS = "session_tokens"
    }
}
