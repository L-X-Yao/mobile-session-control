# Provider profile examples

These files are templates, not credentials. They contain no keys and make no
network request.

The profiles use Anthropic-compatible endpoints because the product target is a
Claude Code-compatible executable. OpenAI-compatible endpoints are documented in
`docs/PROVIDER-MATRIX.md` as alternatives; the schema accepts both transport
types.

| Profile | Anthropic-compatible base URL | Credential environment variable |
|---|---|---|
| `deepseek.json` | `https://api.deepseek.com/anthropic` | `DEEPSEEK_API_KEY` |
| `kimi.json` | `https://api.moonshot.ai/anthropic` | `MOONSHOT_API_KEY` |
| `glm.json` | `https://open.bigmodel.cn/api/anthropic` | `ZHIPUAI_API_KEY` |

All model fields are `REPLACE_WITH_*` placeholders. Replace them with the current
model identifier from the provider's official documentation before use.
Template profiles pass schema validation but are rejected by
`assertRunnableProfile()` and by the launcher policy.

GLM note: the coding-plan key and the standard API key are managed separately.
Confirm which key type the selected endpoint expects before use.

Validate without contacting a provider:

```sh
npm run validate:profiles
```

Rules:

- Never put a secret value in a profile. Use `credential.source = "env"` or
  `"wrapper"`.
- `permissionMode` must be explicit `default`.
- `baseUrl` must be HTTPS, or HTTP only for a loopback fake provider.
- Development and tests use a fake provider and fresh isolated state.
- Endpoint and model correctness is a document-review result, not a live
  compatibility guarantee. See `docs/PROVIDER-MATRIX.md`.
