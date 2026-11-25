package dev.lxyao.msc

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

enum class Screen { Pair, Sessions, Chat }

data class UiState(
    val screen: Screen = Screen.Pair,
    val baseUrl: String = "",
    val code: String = "",
    val input: String = "",
    val busy: Boolean = false,
    val error: String? = null,
    val status: String = "",
    val providers: List<Provider> = emptyList(),
    val selectedProviderId: String? = null,
    val sessions: List<SessionInfo> = emptyList(),
    val active: SessionInfo? = null,
    val events: List<MscEvent> = emptyList(),
    val questionSelections: Map<String, Set<String>> = emptyMap(),
    val decidedRequests: Set<String> = emptySet(),
)

class MscViewModel(application: Application) : AndroidViewModel(application) {
    private val store = MscStore(application)
    private val client = MscClient()
    private val _state = MutableStateFlow(
        UiState(
            baseUrl = store.baseUrl ?: "",
            screen = if (store.deviceToken != null) Screen.Sessions else Screen.Pair,
            status = if (store.deviceToken != null) "已配对" else "等待配对",
        ),
    )
    val state = _state.asStateFlow()
    private var pollJob: Job? = null
    private var keeper: TokenKeeper? = null
    private var keeperBase: String? = null

    init {
        if (store.deviceToken != null) {
            loadSessions()
            registerStoredPush()
        }
    }

    fun setBaseUrl(value: String) = _state.update { it.copy(baseUrl = value) }
    fun setCode(value: String) = _state.update { it.copy(code = value) }
    fun setInput(value: String) = _state.update { it.copy(input = value) }
    fun clearError() = _state.update { it.copy(error = null) }

    fun pair() {
        val current = _state.value
        val base = current.baseUrl.trim().trimEnd('/')
        val code = current.code.trim()
        if (base.isEmpty() || code.isEmpty()) {
            _state.update { it.copy(error = "请输入 relay URL 和配对码") }
            return
        }
        _state.update { it.copy(busy = true, error = null, status = "配对中") }
        viewModelScope.launch(Dispatchers.IO) {
            try {
                val issued = client.pair(base, code)
                store.baseUrl = base
                store.saveDeviceToken(issued.token, issued.ttlMs, System.currentTimeMillis())
                _state.update {
                    it.copy(busy = false, screen = Screen.Sessions, code = "", status = "已配对")
                }
                loadSessions()
                registerStoredPush()
            } catch (error: Exception) {
                _state.update {
                    it.copy(busy = false, error = pairError(error), status = "未配对")
                }
            }
        }
    }

    private fun registerStoredPush() {
        val endpoint = store.pushEndpoint ?: return
        val base = store.baseUrl ?: return
        viewModelScope.launch(Dispatchers.IO) {
            val token = tokens(base).deviceToken() ?: return@launch
            runCatching { client.registerPush(base, token, endpoint) }
        }
    }

    fun loadSessions() {
        val base = store.baseUrl ?: return
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch(Dispatchers.IO) {
            try {
                val token = tokens(base).deviceToken()
                    ?: throw IllegalStateException("token 失效，请重新配对")
                val catalog = client.providers(base, token)
                val sessions = client.sessions(base, token)
                _state.update {
                    it.copy(
                        busy = false,
                        providers = catalog.providers,
                        selectedProviderId = retainedProviderId(
                            it.selectedProviderId,
                            catalog.providers,
                        ),
                        sessions = sessions,
                        status = "已配对 · ${sessions.size} 个会话",
                    )
                }
            } catch (error: Exception) {
                _state.update { it.copy(busy = false, error = error.message, status = "加载失败") }
            }
        }
    }

    fun selectProvider(id: String) = _state.update { it.copy(selectedProviderId = id) }

    fun createSession() {
        val base = store.baseUrl ?: return
        val selectedId = _state.value.selectedProviderId
        if (selectedId == null) {
            _state.update { it.copy(error = "请先选择 Provider") }
            return
        }
        val provider = _state.value.providers.firstOrNull {
            it.id == selectedId && it.enabled
        } ?: run {
            _state.update { it.copy(error = "Provider 不可用") }
            return
        }
        _state.update { it.copy(busy = true, error = null, status = "创建会话中") }
        viewModelScope.launch(Dispatchers.IO) {
            try {
                val token = tokens(base).deviceToken()
                    ?: throw IllegalStateException("token 失效，请重新配对")
                val (sessionId, clientToken) = client.createSession(base, token, provider)
                store.saveSessionToken(
                    sessionId,
                    clientToken,
                    store.deviceStamp()?.ttlMs ?: 0L,
                    System.currentTimeMillis(),
                )
                _state.update { it.copy(busy = false, status = "会话已创建") }
                loadSessions()
                openSession(
                    SessionInfo(
                        sessionId = sessionId,
                        providerId = provider.id,
                        providerLabel = provider.label,
                        closed = false,
                        pendingKind = null,
                        eventCount = 0,
                    ),
                )
            } catch (error: Exception) {
                _state.update { it.copy(busy = false, error = error.message, status = "创建失败") }
            }
        }
    }

    fun openSession(session: SessionInfo) {
        if (session.closed) {
            _state.update { it.copy(error = "会话已关闭") }
            return
        }
        if (store.sessionToken(session.sessionId) == null) {
            _state.update { it.copy(error = "此会话缺少 client token，请从创建它的客户端打开") }
            return
        }
        pollJob?.cancel()
        _state.update {
            it.copy(
                screen = Screen.Chat,
                active = session,
                events = emptyList(),
                decidedRequests = emptySet(),
                error = null,
                status = "运行中",
            )
        }
        pollJob = viewModelScope.launch(Dispatchers.IO) { poll(session.sessionId) }
    }

    private suspend fun poll(sessionId: String) {
        val base = store.baseUrl ?: return
        var lastSeq = 0L
        while (_state.value.screen == Screen.Chat && _state.value.active?.sessionId == sessionId) {
            try {
                val token = tokens(base).sessionToken(sessionId)
                if (token == null) {
                    _state.update {
                        it.copy(status = "token 失效，请重新配对", error = "token 失效，请重新配对")
                    }
                    return
                }
                val events = client.events(base, token, sessionId, lastSeq)
                if (events.isNotEmpty()) {
                    lastSeq = maxOf(lastSeq, events.maxOf { it.seq })
                    val status = when (val last = events.lastOrNull()) {
                        null -> _state.value.status
                        else -> when (last.type) {
                            "permission-request" -> "等待审批"
                            "question-request" -> "等待回答"
                            "turn-end" -> when (last.status) {
                                "completed" -> "已完成"
                                "cancelled" -> "已停止"
                                else -> "失败"
                            }
                            else -> "运行中"
                        }
                    }
                    _state.update { it.copy(events = it.events + events, status = status) }
                }
            } catch (error: MscHttpException) {
                if (error.status == 401 || error.status == 403) {
                    _state.update { it.copy(status = "token 失效，请重新配对", error = error.message) }
                    return
                }
                _state.update { it.copy(status = "连接失败：${error.message}") }
            } catch (error: Exception) {
                _state.update { it.copy(status = "连接失败：${error.message}") }
            }
            delay(700)
        }
    }

    fun backToSessions() {
        pollJob?.cancel()
        pollJob = null
        _state.update { it.copy(screen = Screen.Sessions, active = null, events = emptyList()) }
        loadSessions()
    }

    fun send() {
        val current = _state.value
        val session = current.active ?: return
        val base = store.baseUrl ?: return
        val text = current.input.trim()
        if (text.isEmpty()) return
        _state.update {
            it.copy(
                input = "",
                events = it.events + MscEvent(
                    seq = Long.MAX_VALUE,
                    type = "local-user-message",
                    content = text,
                ),
                status = "等待回复",
            )
        }
        viewModelScope.launch(Dispatchers.IO) {
            try {
                val token = tokens(base).sessionToken(session.sessionId)
                    ?: throw IllegalStateException("token 失效，请重新配对")
                client.sendMessage(base, token, session.sessionId, text)
            } catch (error: Exception) {
                _state.update { it.copy(status = "发送失败：${error.message}") }
            }
        }
    }

    fun decide(event: MscEvent, decision: String) {
        val session = _state.value.active ?: return
        val base = store.baseUrl ?: return
        val requestId = event.requestId ?: return
        viewModelScope.launch(Dispatchers.IO) {
            try {
                val token = tokens(base).sessionToken(session.sessionId)
                    ?: throw IllegalStateException("token 失效，请重新配对")
                client.permissionDecision(base, token, session.sessionId, requestId, decision)
                _state.update {
                    it.copy(
                        status = if (decision == "allow") "已允许" else "已拒绝",
                        decidedRequests = it.decidedRequests + requestId,
                    )
                }
            } catch (error: Exception) {
                _state.update { it.copy(error = error.message) }
            }
        }
    }

    fun toggleQuestionOption(question: String, option: String, multi: Boolean) {
        _state.update { current ->
            val existing = current.questionSelections[question].orEmpty()
            val next = if (multi) {
                if (option in existing) existing - option else existing + option
            } else {
                setOf(option)
            }
            current.copy(questionSelections = current.questionSelections + (question to next))
        }
    }

    fun submitQuestion(event: MscEvent) {
        val session = _state.value.active ?: return
        val base = store.baseUrl ?: return
        val questions = event.questions ?: return
        val requestId = event.requestId ?: return
        val answers = JSONObject()
        for (index in 0 until questions.length()) {
            val question = questions.getJSONObject(index)
            val text = question.optString("question")
            val selected = _state.value.questionSelections[text].orEmpty()
            if (selected.isEmpty()) {
                _state.update { it.copy(error = "每个问题至少选择一个选项") }
                return
            }
            if (selected.size == 1) answers.put(text, selected.first())
            else answers.put(text, JSONArray(selected.toList()))
        }
        viewModelScope.launch(Dispatchers.IO) {
            try {
                val token = tokens(base).sessionToken(session.sessionId)
                    ?: throw IllegalStateException("token 失效，请重新配对")
                client.questionAnswer(base, token, session.sessionId, requestId, answers)
                _state.update {
                    it.copy(
                        status = "已提交回答",
                        questionSelections = emptyMap(),
                        decidedRequests = it.decidedRequests + requestId,
                    )
                }
            } catch (error: Exception) {
                _state.update { it.copy(error = error.message) }
            }
        }
    }

    fun stop() {
        val session = _state.value.active ?: return
        val base = store.baseUrl ?: return
        viewModelScope.launch(Dispatchers.IO) {
            try {
                val token = tokens(base).sessionToken(session.sessionId)
                    ?: throw IllegalStateException("token 失效，请重新配对")
                client.stop(base, token, session.sessionId)
                _state.update { it.copy(status = "已发送 Stop") }
            } catch (error: Exception) {
                _state.update { it.copy(error = error.message) }
            }
        }
    }

    fun close() {
        val session = _state.value.active ?: return
        val base = store.baseUrl ?: return
        viewModelScope.launch(Dispatchers.IO) {
            try {
                val token = tokens(base).sessionToken(session.sessionId)
                    ?: throw IllegalStateException("token 失效，请重新配对")
                client.close(base, token, session.sessionId)
                backToSessions()
            } catch (error: Exception) {
                _state.update { it.copy(error = error.message) }
            }
        }
    }

    private fun tokens(base: String): TokenKeeper {
        val current = keeper
        if (current != null && keeperBase == base) return current
        return TokenKeeper(base, store, client).also {
            keeper = it
            keeperBase = base
        }
    }

    private fun pairError(error: Exception): String = when ((error as? MscHttpException)?.status) {
        401 -> "配对码无效或已使用"
        else -> error.message ?: "配对失败"
    }
}

private fun MutableStateFlow<UiState>.update(transform: (UiState) -> UiState) {
    value = transform(value)
}
