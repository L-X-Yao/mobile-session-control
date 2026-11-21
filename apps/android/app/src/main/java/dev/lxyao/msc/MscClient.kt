package dev.lxyao.msc

import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets

data class Provider(
    val id: String,
    val label: String,
    val model: String,
    val effort: String,
    val transport: String,
    val enabled: Boolean,
)

data class SessionInfo(
    val sessionId: String,
    val providerId: String,
    val providerLabel: String,
    val closed: Boolean,
    val pendingKind: String?,
    val eventCount: Int,
)

data class MscEvent(
    val seq: Long,
    val type: String,
    val content: String? = null,
    val tool: String? = null,
    val detail: String? = null,
    val requestId: String? = null,
    val status: String? = null,
    val error: String? = null,
    val questions: JSONArray? = null,
)

class MscHttpException(val status: Int, message: String) : Exception(message)

class MscClient {
    fun pair(baseUrl: String, code: String): String {
        val body = JSONObject().put("code", code)
        val response = request(baseUrl, "/v1/pair", null, "POST", body)
        return response.optString("token").ifEmpty { error("invalid_pair_response") }
    }

    fun providers(baseUrl: String, token: String): List<Provider> {
        val response = request(baseUrl, "/v1/providers", token, "GET", null)
        val array = response.optJSONArray("providers") ?: JSONArray()
        return (0 until array.length()).map { index ->
            val item = array.getJSONObject(index)
            Provider(
                id = item.optString("id"),
                label = item.optString("label"),
                model = item.optString("model"),
                effort = item.optString("effort"),
                transport = item.optString("transport"),
                enabled = item.optBoolean("enabled", true),
            )
        }
    }

    fun sessions(baseUrl: String, token: String): List<SessionInfo> {
        val response = request(baseUrl, "/v1/sessions", token, "GET", null)
        val array = response.optJSONArray("sessions") ?: JSONArray()
        return (0 until array.length()).map { index ->
            val item = array.getJSONObject(index)
            val provider = item.optJSONObject("provider")
            SessionInfo(
                sessionId = item.optString("sessionId"),
                providerId = provider?.optString("id") ?: "unknown",
                providerLabel = provider?.optString("id") ?: "unknown",
                closed = item.optBoolean("closed", false),
                pendingKind = item.optString("pendingKind").ifEmpty { null },
                eventCount = item.optInt("eventCount", 0),
            )
        }
    }

    fun createSession(
        baseUrl: String,
        token: String,
        provider: Provider,
    ): Pair<String, String> {
        val body = JSONObject().put(
            "provider",
            JSONObject()
                .put("id", provider.id)
                .put("model", provider.model)
                .put("effort", provider.effort)
                .put("transport", provider.transport),
        )
        val response = request(baseUrl, "/v1/sessions", token, "POST", body)
        val sessionId = response.optString("sessionId")
        val clientToken = response.optString("clientToken")
        if (sessionId.isEmpty() || clientToken.isEmpty()) error("invalid_session_response")
        return sessionId to clientToken
    }

    fun events(
        baseUrl: String,
        token: String,
        sessionId: String,
        after: Long,
    ): List<MscEvent> {
        val response = request(
            baseUrl,
            "/v1/sessions/$sessionId/events?after=$after&limit=500",
            token,
            "GET",
            null,
        )
        val array = response.optJSONArray("events") ?: JSONArray()
        return (0 until array.length()).map { index ->
            val item = array.getJSONObject(index)
            MscEvent(
                seq = item.optLong("seq", 0),
                type = item.optString("type"),
                content = item.optString("content").ifEmpty { null },
                tool = item.optString("tool").ifEmpty { null },
                detail = item.optString("detail").ifEmpty { null },
                requestId = item.optString("requestId").ifEmpty { null },
                status = item.optString("status").ifEmpty { null },
                error = item.optString("error").ifEmpty { null },
                questions = item.optJSONArray("questions"),
            )
        }
    }

    fun sendMessage(baseUrl: String, token: String, sessionId: String, content: String) {
        request(
            baseUrl,
            "/v1/sessions/$sessionId/messages",
            token,
            "POST",
            JSONObject().put("content", content),
        )
    }

    fun permissionDecision(
        baseUrl: String,
        token: String,
        sessionId: String,
        requestId: String,
        decision: String,
    ) {
        request(
            baseUrl,
            "/v1/sessions/$sessionId/commands",
            token,
            "POST",
            JSONObject()
                .put("type", "permission-decision")
                .put("requestId", requestId)
                .put("decision", decision),
        )
    }

    fun registerPush(baseUrl: String, token: String, endpoint: String) {
        request(
            baseUrl,
            "/v1/push/register",
            token,
            "POST",
            JSONObject().put("endpoint", endpoint),
        )
    }

    fun unregisterPush(baseUrl: String, token: String, endpoint: String) {
        request(
            baseUrl,
            "/v1/push/unregister",
            token,
            "POST",
            JSONObject().put("endpoint", endpoint),
        )
    }

    fun questionAnswer(
        baseUrl: String,
        token: String,
        sessionId: String,
        requestId: String,
        answers: JSONObject,
    ) {
        request(
            baseUrl,
            "/v1/sessions/$sessionId/commands",
            token,
            "POST",
            JSONObject()
                .put("type", "question-answer")
                .put("requestId", requestId)
                .put("answers", answers),
        )
    }

    fun stop(baseUrl: String, token: String, sessionId: String) {
        request(
            baseUrl,
            "/v1/sessions/$sessionId/commands",
            token,
            "POST",
            JSONObject().put("type", "stop"),
        )
    }

    fun close(baseUrl: String, token: String, sessionId: String) {
        request(baseUrl, "/v1/sessions/$sessionId/close", token, "POST", null)
    }

    private fun request(
        baseUrl: String,
        path: String,
        token: String?,
        method: String,
        body: JSONObject?,
    ): JSONObject {
        val root = baseUrl.trim().trimEnd('/')
        require(root.startsWith("https://") || root.startsWith("http://127.0.0.1")
            || root.startsWith("http://localhost")) { "relay URL must be HTTPS or loopback" }
        val connection = (URL("$root$path").openConnection() as HttpURLConnection).apply {
            requestMethod = method
            instanceFollowRedirects = false
            connectTimeout = 10_000
            readTimeout = 15_000
            setRequestProperty("accept", "application/json")
            if (token != null) setRequestProperty("authorization", "Bearer $token")
            if (body != null) {
                doOutput = true
                setRequestProperty("content-type", "application/json")
            }
        }
        try {
            if (body != null) {
                connection.outputStream.use { it.write(body.toString().toByteArray(StandardCharsets.UTF_8)) }
            }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.use { input ->
                BufferedReader(InputStreamReader(input, StandardCharsets.UTF_8)).readText()
            }.orEmpty()
            val json = if (text.isBlank()) JSONObject() else JSONObject(text)
            if (status !in 200..299) {
                throw MscHttpException(status, json.optString("error", "HTTP_$status"))
            }
            return json
        } finally {
            connection.disconnect()
        }
    }
}
