# AI Fix Suggestions — Bring Your Own Key (BYOK)

**a11y DevTools v2.0.2** uses AI to generate accessibility fix suggestions for axe-core findings. No AI service is bundled — you choose and configure the provider.

---

## Supported Providers

| Provider | Type | Default Model | Requires Key |
|---|---|---|---|
| **Chrome Built-in AI** | Local (on-device) | — | No |
| **OpenAI** | Remote | `gpt-4.1-mini` | Yes |
| **Anthropic** | Remote | `claude-3-5-haiku-latest` | Yes |
| **OpenRouter** | Remote | `openai/gpt-4.1-mini` | Yes |
| **Custom (OpenAI-compatible)** | Remote | User-defined | Yes |

---

## Fallback Modes

| Mode | Behavior |
|---|---|
| `builtin_only` | Only Chrome Built-in AI (default) |
| `remote_only` | Only the selected remote provider |
| `builtin_then_remote` | Try Built-in AI first; fall back to remote on failure or unavailability |

---

## Configuration

Open the **AI Settings** panel inside the extension to configure:

- Enable/disable AI suggestions globally
- Select provider and fallback mode
- Enter API key (stored locally, never transmitted except to the chosen provider)
- Set a custom model name
- Set a custom base URL (Custom provider only)
- Adjust request timeout (5 s – 60 s, default 20 s)
- Test the connection before saving

---

## API Endpoints

| Provider | Endpoint |
|---|---|
| OpenAI | `https://api.openai.com/v1/chat/completions` |
| Anthropic | `https://api.anthropic.com/v1/messages` |
| OpenRouter | `https://openrouter.ai/api/v1/chat/completions` |
| Custom | `{baseUrl}/chat/completions` |

**Anthropic** uses `anthropic-version: 2023-06-01` and `max_tokens: 900`.  
All other remote providers use the OpenAI Chat Completions schema with `temperature: 0.2`.

---

## Security & Privacy

- API keys are stored in `chrome.storage.local` — never synced to the cloud.
- Keys are masked in the UI (`abc••••wxyz`) and **never** appear in logs or error messages (secrets are redacted automatically).
- Requests go directly from the extension background service worker to the provider — no proxy, no third-party server.
- Chrome Built-in AI runs entirely on-device; no data leaves the browser.

---

## AI Response Format

The extension expects providers to return a JSON object:

```json
{
  "shortExplanation": "One-sentence summary of the issue.",
  "userImpact": "How this affects users with disabilities.",
  "recommendedFix": "Step-by-step remediation guidance.",
  "codeExample": "<button aria-label=\"Submit form\">Submit</button>",
  "confidence": "low | medium | high",
  "warnings": ["Optional caveats or limitations."]
}
```

If the response is Markdown instead of JSON, the parser extracts sections by heading label. Raw text is preserved as a fallback.

---

## Chrome Built-in AI Notes

Chrome Built-in AI requires **Chrome 127+** with the experimental `LanguageModel` API enabled. If the model is not yet downloaded, the extension will trigger an automatic download and show progress. Status values: `available`, `downloadable`, `unavailable`.

To check availability: `chrome://flags/#prompt-api-for-gemini-nano`

---

## Custom OpenAI-Compatible Providers

Any server that implements the OpenAI Chat Completions API can be used. Set:

- **Base URL** — e.g., `http://localhost:11434/v1` (Ollama), `https://my-llm-proxy.example.com/v1`
- **Model** — model ID as recognized by the server
- **API Key** — required by the extension (use any non-empty value if your server does not enforce keys)

The extension appends `/chat/completions` to the base URL automatically.

---

## Obtaining API Keys

- **OpenAI** — [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
- **Anthropic** — [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
- **OpenRouter** — [openrouter.ai/keys](https://openrouter.ai/keys)
