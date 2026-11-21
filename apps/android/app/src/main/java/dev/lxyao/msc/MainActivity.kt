package dev.lxyao.msc

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import org.json.JSONArray
import org.json.JSONObject

private val DarkColors = darkColorScheme(
    primary = Color(0xFF4FD1C5),
    onPrimary = Color(0xFF071312),
    background = Color(0xFF101418),
    surface = Color(0xFF171C22),
    surfaceVariant = Color(0xFF202730),
    onSurface = Color(0xFFE6EDF3),
    onSurfaceVariant = Color(0xFF9BA7B4),
    error = Color(0xFFFF7B72),
)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme(colorScheme = DarkColors) {
                val model: MscViewModel = viewModel()
                val state by model.state.collectAsState()
                Surface(color = MaterialTheme.colorScheme.background, modifier = Modifier.fillMaxSize()) {
                    when (state.screen) {
                        Screen.Pair -> PairScreen(state, model)
                        Screen.Sessions -> SessionsScreen(state, model)
                        Screen.Chat -> ChatScreen(state, model)
                    }
                }
            }
        }
    }
}

@Composable
private fun PairScreen(state: UiState, model: MscViewModel) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Text("Mobile Session Control", style = MaterialTheme.typography.headlineSmall)
        Spacer(Modifier.height(8.dp))
        Text(
            "输入电脑端 relay URL 与一次性配对码",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(24.dp))
        OutlinedTextField(
            value = state.baseUrl,
            onValueChange = model::setBaseUrl,
            label = { Text("Relay URL") },
            placeholder = { Text("https://your-private-host") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = state.code,
            onValueChange = model::setCode,
            label = { Text("配对码") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(16.dp))
        Button(
            onClick = model::pair,
            enabled = !state.busy,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(if (state.busy) "配对中…" else "配对")
        }
        state.error?.let {
            Spacer(Modifier.height(12.dp))
            Text(it, color = MaterialTheme.colorScheme.error)
        }
        Spacer(Modifier.height(8.dp))
        Text(state.status, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SessionsScreen(state: UiState, model: MscViewModel) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("会话") },
                actions = {
                    TextButton(onClick = model::loadSessions) { Text("刷新") }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(16.dp),
        ) {
            Text(state.status, color = MaterialTheme.colorScheme.onSurfaceVariant)
            state.error?.let {
                Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 8.dp))
            }
            Spacer(Modifier.height(12.dp))
            ProviderPicker(state, model)
            Spacer(Modifier.height(12.dp))
            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(state.sessions, key = { it.sessionId }) { session ->
                    SessionCard(session, state, model)
                }
            }
        }
    }
}

@Composable
private fun ProviderPicker(state: UiState, model: MscViewModel) {
    var open by remember { mutableStateOf(false) }
    val selected = state.providers.firstOrNull { it.id == state.selectedProviderId }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(modifier = Modifier.weight(1f)) {
            Button(
                onClick = { open = true },
                colors = ButtonDefaults.buttonColors(
                    containerColor = MaterialTheme.colorScheme.surfaceVariant,
                    contentColor = MaterialTheme.colorScheme.onSurface,
                ),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    selected?.label ?: "选择 Provider",
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                state.providers.filter { it.enabled }.forEach { provider ->
                    DropdownMenuItem(
                        text = { Text(provider.label, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                        onClick = {
                            model.selectProvider(provider.id)
                            open = false
                        },
                    )
                }
            }
        }
        Spacer(Modifier.width(8.dp))
        Button(onClick = model::createSession, enabled = !state.busy) {
            Text("新建")
        }
    }
}

@Composable
private fun SessionCard(session: SessionInfo, state: UiState, model: MscViewModel) {
    val provider = state.providers.firstOrNull { it.id == session.providerId }
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier.padding(14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    provider?.label ?: session.providerId,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    "${session.sessionId.take(12)} · ${session.eventCount} events" +
                        if (session.closed) " · 已关闭" else "",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            Button(onClick = { model.openSession(session) }, enabled = !session.closed) {
                Text("打开")
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChatScreen(state: UiState, model: MscViewModel) {
    val listState = rememberLazyListState()
    LaunchedEffect(state.events.size) {
        if (state.events.isNotEmpty()) listState.animateScrollToItem(state.events.size - 1)
    }
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("对话", maxLines = 1)
                        Text(
                            state.status,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                },
                navigationIcon = { TextButton(onClick = model::backToSessions) { Text("返回") } },
                actions = {
                    TextButton(onClick = model::stop) { Text("Stop") }
                    TextButton(onClick = model::close) { Text("关闭") }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
            )
        },
        bottomBar = {
            Row(
                modifier = Modifier
                    .background(MaterialTheme.colorScheme.surface)
                    .padding(10.dp)
                    .imePadding(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                OutlinedTextField(
                    value = state.input,
                    onValueChange = model::setInput,
                    placeholder = { Text("输入消息") },
                    maxLines = 3,
                    modifier = Modifier.weight(1f),
                )
                Spacer(Modifier.width(8.dp))
                Button(onClick = model::send) { Text("发送") }
            }
        },
    ) { padding ->
        LazyColumn(
            state = listState,
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(state.events) { event ->
                when (event.type) {
                    "local-user-message", "user-message" -> Bubble(event.content.orEmpty(), true)
                    "assistant-message" -> Bubble(event.content.orEmpty(), false)
                    "permission-request" -> ApprovalCard(event, state, model)
                    "question-request" -> QuestionCard(event, state, model)
                    "turn-end" -> Text(
                        "turn-end: ${event.status ?: "unknown"}${event.error?.let { " · $it" } ?: ""}",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        }
    }
}

@Composable
private fun Bubble(text: String, user: Boolean) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (user) Arrangement.End else Arrangement.Start,
    ) {
        Card(
            colors = CardDefaults.cardColors(
                containerColor = if (user) MaterialTheme.colorScheme.primary
                else MaterialTheme.colorScheme.surface,
            ),
            modifier = Modifier.fillMaxWidth(0.86f),
        ) {
            Text(
                text,
                color = if (user) MaterialTheme.colorScheme.onPrimary
                else MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.padding(12.dp),
            )
        }
    }
}

@Composable
private fun ApprovalCard(event: MscEvent, state: UiState, model: MscViewModel) {
    val decided = event.requestId?.let { it in state.decidedRequests } == true
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(modifier = Modifier.padding(14.dp)) {
            Text("需要审批：${event.tool ?: "unknown"}", fontWeight = FontWeight.SemiBold)
            event.detail?.let {
                Spacer(Modifier.height(8.dp))
                Text(it, style = MaterialTheme.typography.bodySmall)
            }
            Spacer(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = { model.decide(event, "allow") },
                    enabled = !decided,
                ) { Text(if (decided) "已处理" else "允许") }
                Button(
                    onClick = { model.decide(event, "deny") },
                    enabled = !decided,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.error,
                    ),
                ) { Text("拒绝") }
            }
        }
    }
}

@Composable
private fun QuestionCard(event: MscEvent, state: UiState, model: MscViewModel) {
    val questions = event.questions ?: JSONArray()
    val decided = event.requestId?.let { it in state.decidedRequests } == true
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(modifier = Modifier.padding(14.dp)) {
            Text("需要回答", fontWeight = FontWeight.SemiBold)
            for (index in 0 until questions.length()) {
                val question = questions.optJSONObject(index) ?: continue
                val text = question.optString("question")
                val multi = question.optBoolean("multiSelect", false)
                Spacer(Modifier.height(8.dp))
                Text(text)
                val selected = state.questionSelections[text].orEmpty()
                val options = question.optJSONArray("options") ?: JSONArray()
                for (optionIndex in 0 until options.length()) {
                    val option = options.optJSONObject(optionIndex) ?: continue
                    val label = option.optString("label")
                    SelectedButton(
                        text = label,
                        selected = label in selected,
                        enabled = !decided,
                        onClick = { model.toggleQuestionOption(text, label, multi) },
                    )
                }
            }
            Spacer(Modifier.height(8.dp))
            Button(onClick = { model.submitQuestion(event) }, enabled = !decided) {
                Text(if (decided) "已提交" else "提交回答")
            }
        }
    }
}

@Composable
private fun SelectedButton(
    text: String,
    selected: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    Button(
        onClick = onClick,
        enabled = enabled,
        colors = ButtonDefaults.buttonColors(
            containerColor = if (selected) MaterialTheme.colorScheme.primary
            else MaterialTheme.colorScheme.surfaceVariant,
            contentColor = if (selected) MaterialTheme.colorScheme.onPrimary
            else MaterialTheme.colorScheme.onSurface,
        ),
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 4.dp),
    ) { Text(text) }
}
