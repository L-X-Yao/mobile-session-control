package dev.lxyao.msc

import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TokenRefreshTest {
    private class FakeStore(var device: TokenStamp? = null) : TokenStore {
        val sessions = mutableMapOf<String, TokenStamp>()

        override fun deviceStamp(): TokenStamp? = device

        override fun saveDeviceToken(token: String, ttlMs: Long, issuedAtMs: Long) {
            device = TokenStamp(token, issuedAtMs, ttlMs)
        }

        override fun sessionStamp(sessionId: String): TokenStamp? = sessions[sessionId]

        override fun saveSessionToken(
            sessionId: String,
            token: String,
            ttlMs: Long,
            issuedAtMs: Long,
        ) {
            sessions[sessionId] = TokenStamp(token, issuedAtMs, ttlMs)
        }
    }

    private class FakeClient(
        var result: IssuedToken? = null,
        var error: Exception? = null,
    ) : TokenRenewalClient {
        var calls = 0
        var lastToken: String? = null

        override fun renew(baseUrl: String, token: String): IssuedToken {
            calls += 1
            lastToken = token
            error?.let { throw it }
            return result ?: throw IllegalStateException("no fake result")
        }
    }

    @Test
    fun zeroTtlNeverExpires() {
        assertFalse(tokenDue(10_000, TokenStamp("t", 0, 0)))
    }

    @Test
    fun renewsAtSeventyPercentAndOnBackwardClock() {
        val stamp = TokenStamp("t", 1_000, 1_000)
        assertFalse(tokenDue(1_699, stamp))
        assertTrue(tokenDue(1_700, stamp))
        assertTrue(tokenDue(900, stamp))
    }

    @Test
    fun renewsDeviceTokenAndStoresTheReplacement() {
        val store = FakeStore(TokenStamp("old", 0, 1_000))
        val client = FakeClient(result = IssuedToken("new", 2_000))
        val keeper = TokenKeeper("https://relay", store, client) { 700 }

        assertEquals("new", keeper.deviceToken())
        assertEquals("old", client.lastToken)
        assertEquals(TokenStamp("new", 700, 2_000), store.device)
    }

    @Test
    fun keepsDeviceTokenBeforeThreshold() {
        val store = FakeStore(TokenStamp("old", 0, 1_000))
        val client = FakeClient(result = IssuedToken("new", 2_000))
        val keeper = TokenKeeper("https://relay", store, client) { 600 }

        assertEquals("old", keeper.deviceToken())
        assertEquals(0, client.calls)
    }

    @Test
    fun expiredTokenCannotBeRenewed() {
        val store = FakeStore(TokenStamp("old", 0, 1_000))
        val client = FakeClient(error = MscHttpException(401, "token_expired"))
        val keeper = TokenKeeper("https://relay", store, client) { 700 }

        assertNull(keeper.deviceToken())
    }

    @Test
    fun transientFailureKeepsTheLiveToken() {
        val store = FakeStore(TokenStamp("old", 0, 1_000))
        val client = FakeClient(error = IOException("offline"))
        val keeper = TokenKeeper("https://relay", store, client) { 700 }

        assertEquals("old", keeper.deviceToken())
    }

    @Test
    fun renewsSessionToken() {
        val store = FakeStore()
        store.sessions["s1"] = TokenStamp("old", 0, 1_000)
        val client = FakeClient(result = IssuedToken("new", 2_000))
        val keeper = TokenKeeper("https://relay", store, client) { 700 }

        assertEquals("new", keeper.sessionToken("s1"))
        assertEquals(TokenStamp("new", 700, 2_000), store.sessions["s1"])
        assertNull(keeper.sessionToken("missing"))
    }
}
