# AI Fix Suggestions

**a11y DevTools v2.1.0** uses AI to generate accessibility fix suggestions for axe-core findings.

---

## Supported Providers

| Provider | Type | Requires Key |
|---|---|---|
| **Chrome Built-in AI** | Local (on-device, Gemini Nano) | No |
| **a11y DevTools API** | Remote (backend connection) | Connection ID + model |

---

## Fallback Modes

| Mode | Behavior |
|---|---|
| `builtin_only` | Only Chrome Built-in AI (default) |
| `remote_only` | Only the a11y DevTools API backend |
| `builtin_then_remote` | Try Built-in AI first; fall back to backend on failure or unavailability |

---

## Configuration

Open the **AI Settings** panel inside the extension to configure:

- Enable/disable AI suggestions globally
- Select provider and fallback mode
- Adjust request timeout (5 s – 60 s, default 20 s)
- Sign in to the a11y DevTools API and select a backend connection + model
- Test the connection before saving

---

## a11y DevTools API

The backend proxies AI requests through user-managed connections.

**Auth flow:**
1. Click **Sign in** in AI Settings — opens `https://a11y.eliasrm.dev` in a new tab
2. Complete sign-in; the page redirects with a token via `chrome.runtime.sendMessageExternal`
3. Token is stored locally and auto-refreshed 60 s before expiry

**After sign-in:**
- Create a **connection** (stores provider credentials on the backend)
- Select a connection and enter a **model name**
- Click **Test** to verify

---

## AI Response Format

Providers return a JSON object:

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

Chrome Built-in AI requires **Chrome 127+** with the experimental `LanguageModel` API enabled. If the model is not yet downloaded, the extension triggers an automatic download and shows progress. Status values: `available`, `downloadable`, `unavailable`.

To check availability: `chrome://flags/#prompt-api-for-gemini-nano`

---

## Security & Privacy

- Backend tokens are stored in `chrome.storage.local` — never synced to the cloud.
- API keys are masked in the UI (`abc••••wxyz`) and **never** appear in logs or error messages (secrets are redacted automatically).
- Chrome Built-in AI runs entirely on-device; no data leaves the browser.
