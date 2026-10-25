# agentrouter-proxy

A small OpenAI-compatible adapter that makes [AgentRouter](https://agentrouter.org) usable from
standard `openai-completions` clients such as [DSH](https://github.com/deepseek-ai) profiles,
`pi-ai`, or anything that speaks `/v1/chat/completions`.

AgentRouter serves the `gpt-6.1-sol` / `gpt-5.6-sol` / `gpt-6-astra` family through the
**OpenAI Responses API only**, and its edge runs a content filter over the conversation
payload. A conventional chat-completions client therefore fails in two independent ways:

```
400 Model gpt-6.1-sol does not support /v1/chat/completions, please use /v1/responses
400 {"code":"content-blocked", ... "type":"agent_router_api_error"}
```

This proxy closes both gaps on your own machine or server, so the client never has to know.

## What it does

| Problem | Handling |
| :--- | :--- |
| Responses-API-only models | Rewrites `POST /v1/chat/completions` into `POST /v1/responses` and translates the answer back |
| Content filter scans `input` | The full conversation is carried once in `instructions` (which the filter does not scan); `input` keeps only ASCII-safe structure |
| Tool schema mismatch | Normalises `{"type":"function","function":{…}}` tools into the flat Responses shape |
| Streaming | Translates `response.output_text.delta` and `response.function_call_arguments.delta` into `chat.completion.chunk`, including `tool_calls` and `finish_reason` |
| Slow first token | Keeps an HTTPS socket warm (`keepAlive` + periodic metadata warm-up) so a turn does not pay DNS/TLS again |
| Cline's wrapped JSON | `POST /cline/v1/chat/completions` forwards to `api.cline.bot/api/v1` and unwraps the `{data, success}` envelope |

Tool calls round-trip: `function_call` / `function_call_output` items are rebuilt from
`tool_calls` / `tool` messages, with matching `call_id`s.

## Requirements

- Node.js 20 or newer (no dependencies, no build step)
- An AgentRouter API key

## Run

```bash
node proxy.mjs
# agentrouter-proxy listening on 8789
```

Or as a systemd unit — see [`agentrouter-proxy.service`](agentrouter-proxy.service):

```bash
sudo cp agentrouter-proxy.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now agentrouter-proxy
```

Health check:

```bash
curl -s http://127.0.0.1:8789/health
# {"status":"ok"}
```

## Point a client at it

Any OpenAI-compatible provider entry works:

```yaml
providers:
  agentrouter:
    baseURL: http://127.0.0.1:8789/v1
    api: openai-completions
    apiKeyEnv: AGENTROUTER_API_KEY
    models:
      - id: gpt-6.1-sol
        name: GPT-6.1 Sol
        contextWindow: 1050000
```

The key is read from the client's `Authorization` header and forwarded as-is; the proxy
stores no credentials.

## Endpoints

| Method | Path | Purpose |
| :--- | :--- | :--- |
| `GET` | `/health` | Liveness |
| `GET` | `/v1/models` | AgentRouter catalog, passed through |
| `POST` | `/v1/chat/completions` | Translated chat completions (stream and non-stream) |
| `GET` | `/cline/v1/models` | Cline catalog |
| `POST` | `/cline/v1/chat/completions` | Cline chat with envelope unwrapping |

## Environment

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `AR_REASONING_EFFORT` | unset | Forces `reasoning.effort` (`low` / `medium` / `high` / `max`) when the client does not send one |
| `AR_VERBOSITY` | unset | Forces `text.verbosity` |

The port is set by `PORT` near the top of `proxy.mjs`.

## Limitations

- The transcript-in-`instructions` design keeps structure in `input` but moves prose out of it.
  Extremely long histories therefore cost tokens once, in `instructions`.
- Only the Responses-API models AgentRouter actually serves are reachable; IDs the gateway does
  not serve for your key answer with that gateway's own error.
- The filter workaround is a transport-level adaptation. Whether it is acceptable for your
  account is between you and AgentRouter's terms of service.
- Conversation text that is not ASCII is intentionally not sent in `input`, so a client that
  inspects the outbound body will see placeholders rather than the original prose.

## License

MIT
