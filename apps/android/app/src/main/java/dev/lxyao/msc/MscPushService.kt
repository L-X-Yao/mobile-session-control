package dev.lxyao.msc

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONObject
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage
import java.nio.charset.StandardCharsets

class MscPushService : PushService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onCreate() {
        super.onCreate()
        Log.d(TAG, "created")
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL,
                "审批通知",
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = "Claude 等待审批或回答"
            },
        )
    }

    override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
        Log.d(TAG, "endpoint received")
        val store = MscStore(this)
        store.pushEndpoint = endpoint.url
        register(endpoint.url, store)
    }

    override fun onMessage(message: PushMessage, instance: String) {
        Log.d(TAG, "message received (decrypted=${message.decrypted})")
        val payload = runCatching {
            JSONObject(String(message.content, StandardCharsets.UTF_8))
        }.getOrNull() ?: return
        val requestId = payload.optString("requestId")
        val kind = payload.optString("kind", "permission")
        val text = if (kind == "question") "Claude 等待回答" else "Claude 等待审批"
        val intent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("Mobile Session Control")
            .setContentText(text)
            .setContentIntent(intent)
            .setAutoCancel(true)
            .build()
        runCatching {
            getSystemService(NotificationManager::class.java)
                .notify(requestId.hashCode(), notification)
        }.onFailure { Log.w(TAG, "notify failed: ${it.message}") }
    }

    override fun onRegistrationFailed(reason: FailedReason, instance: String) {
        // The distributor may retry; the app remains usable without push.
    }

    override fun onUnregistered(instance: String) {
        val store = MscStore(this)
        val endpoint = store.pushEndpoint
        store.pushEndpoint = null
        val base = store.baseUrl
        if (endpoint != null && base != null) {
            scope.launch {
                val client = MscClient()
                val token = TokenKeeper(base, store, client).deviceToken() ?: return@launch
                runCatching { client.unregisterPush(base, token, endpoint) }
            }
        }
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun register(endpoint: String, store: MscStore) {
        val base = store.baseUrl ?: return
        scope.launch {
            val client = MscClient()
            val token = TokenKeeper(base, store, client).deviceToken() ?: return@launch
            runCatching { client.registerPush(base, token, endpoint) }
                .onSuccess { Log.d(TAG, "endpoint registered") }
                .onFailure { Log.w(TAG, "endpoint registration failed: ${it.javaClass.simpleName}") }
        }
    }

    private companion object {
        const val TAG = "MscPushService"
        const val CHANNEL = "msc_approvals"
    }
}
