# Provider compatibility matrix

Status: **document review, not live verification.** The table is based on a
read-only review by the GLM session (2026-11-16) of `api-docs.deepseek.com`,
`platform.kimi.ai` and `docs.bigmodel.cn`. No real HTTP request, credential or
provider-side attestation was used. Re-check the official documentation before
relying on an endpoint or model name.

## Endpoints and authentication

| Dimension | DeepSeek | Kimi | GLM |
|---|---|---|---|
| OpenAI-compatible base | `https://api.deepseek.com` | `https://api.moonshot.ai/v1` (`api.moonshot.cn` variant: `NO_DATA`) | `https://open.bigmodel.cn/api/paas/v4` |
| Anthropic-compatible base | `https://api.deepseek.com/anthropic` | `https://api.moonshot.ai/anthropic` | `https://open.bigmodel.cn/api/anthropic` |
| Credential env | `DEEPSEEK_API_KEY` (official examples use this name) | `MOONSHOT_API_KEY` (official examples use this name) | `ZHIPUAI_API_KEY` (project convention; official name `NO_DATA`) |
| SSE streaming | Reported supported | Reported supported | Reported supported |
| Stop / abort | `stop_sequences` reported supported (Anthropic format) | SSE interruption described; abort details `NO_DATA` | `NO_DATA` |
| Current model examples | `deepseek-flash`, `deepseek-v4-pro` (document review; `deepseek-chat` not listed) | `kimi-k3.1-pro`, `kimi-k3.1-pro-highspeed` (document review) | `glm-5.3` (document example; full list not captured) |

The profile examples use `anthropic-compatible-sse` because the product target is
a Claude Code-compatible executable. `openai-compatible-sse` remains supported
for adapters and direct OpenAI-compatible clients.

## Known differences and open items

| Provider | Note | Status |
|---|---|---|
| DeepSeek | Image/document input unsupported; `cache_control` ignored; thinking `budget_tokens` ignored; `claude-*` model names may be auto-mapped | Document review |
| Kimi | PDF/document support reported missing in community issues, not official docs; partial message-level fields | `NO_DATA` |
| GLM | Coding-plan key and standard API key are managed separately; key type affects authentication | Document review |

## Findings from the review

| Finding | Disposition |
|---|---|
| `deepseek-chat` may be stale | Replaced with `REPLACE_WITH_DEEPSEEK_MODEL` placeholder; re-verify model list |
| Kimi `.cn` endpoint unconfirmed | Examples use `.ai`; `.cn` remains `NO_DATA` |
| Profile transport did not match Claude Code's Anthropic protocol | Added `anthropic-compatible-sse`; examples now use Anthropic endpoints |
| Placeholder model could reach a launcher | `assertRunnableProfile()` and the launcher policy reject `REPLACE_WITH_*` |
| GLM key type ambiguity | Documented; real runs must confirm key type |

## Boundary

- No real provider request was made.
- No API key, credential or provider-side response is stored in this repository.
- Real HTTP counts, provider-side completion and attestation remain `NO_DATA`.
- A live compatibility check requires a separate explicit authorization, a
  provider account and a new run binding.
