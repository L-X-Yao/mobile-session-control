package dev.lxyao.msc

internal data class TokenStamp(
    val token: String,
    val issuedAtMs: Long,
    val ttlMs: Long,
)

internal interface TokenStore {
    fun deviceStamp(): TokenStamp?
    fun saveDeviceToken(token: String, ttlMs: Long, issuedAtMs: Long)
    fun sessionStamp(sessionId: String): TokenStamp?
    fun saveSessionToken(sessionId: String, token: String, ttlMs: Long, issuedAtMs: Long)
}

internal interface TokenRenewalClient {
    fun renew(baseUrl: String, token: String): IssuedToken
}

internal fun tokenDue(nowMs: Long, stamp: TokenStamp): Boolean {
    if (stamp.token.isEmpty()) return true
    if (stamp.ttlMs <= 0L) return false
    if (nowMs < stamp.issuedAtMs) return true
    val renewAt = stamp.issuedAtMs + (stamp.ttlMs / 10L) * 7L
    return nowMs >= renewAt
}

internal class TokenKeeper(
    val baseUrl: String,
    private val store: TokenStore,
    private val client: TokenRenewalClient,
    private val clock: () -> Long = { System.currentTimeMillis() },
) {
    fun deviceToken(): String? = synchronized(RENEW_LOCK) {
        val stamp = store.deviceStamp() ?: return@synchronized null
        if (!tokenDue(clock(), stamp)) return@synchronized stamp.token
        renew(stamp) { renewed ->
            store.saveDeviceToken(renewed.token, renewed.ttlMs, clock())
        }
    }

    fun sessionToken(sessionId: String): String? = synchronized(RENEW_LOCK) {
        val stamp = store.sessionStamp(sessionId) ?: return@synchronized null
        if (!tokenDue(clock(), stamp)) return@synchronized stamp.token
        renew(stamp) { renewed ->
            store.saveSessionToken(sessionId, renewed.token, renewed.ttlMs, clock())
        }
    }

    private companion object {
        // Renewal rotates a single-use token. Share one lock across the
        // ViewModel keeper and the push service keeper in this process.
        val RENEW_LOCK = Any()
    }

    private fun renew(stamp: TokenStamp, save: (IssuedToken) -> Unit): String? {
        if (stamp.token.isEmpty()) return null
        return try {
            val renewed = client.renew(baseUrl, stamp.token)
            save(renewed)
            renewed.token
        } catch (error: MscHttpException) {
            // An expired token cannot be renewed; a live token may survive a
            // transient network failure until its expiry.
            if (error.status == 401 || error.status == 403) null else stamp.token
        } catch (_: Exception) {
            stamp.token
        }
    }
}
