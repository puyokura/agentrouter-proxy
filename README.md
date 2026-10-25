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
| Unpredictable stalls | Hedges each request: a second (and third) attempt starts after a delay, first to answer wins, the rest are cancelled |
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

## Latency

Two separate delays show up on this gateway, and only one of them is fixable here.

1. **Connection setup** — measured before the keep-alive/warm-up work: the `response.created`
   acknowledgement alone took 5.6–7.3 s on a fresh socket. A warm socket puts that at 0–280 ms.
2. **Completion stalls** — the gateway acknowledges in milliseconds, then sometimes takes a very
   long time to produce tokens. The same ten-token prompt measured 1.8 s, 22.9 s, 39.1 s and 77.2 s
   in one back-to-back run, with the acknowledgement at 30–283 ms every time. The delay is
   upstream generation, not admission control, not payload size, and not the proxy.

`reasoning.effort` moves it a lot when the gateway is healthy (the same payload measured 46–52 s
at `max` against 2–4 s at `low`), so the default is `low`. Raise it per request with the
`reasoning_effort` field, or for the whole process with `AR_REASONING_EFFORT`.

Because individual stalls are unpredictable, requests are **hedged**: a second attempt starts
after `AR_HEDGE_DELAY_MS` and a third after the same gap again. The first attempt to emit text or
a tool call wins; the rest are destroyed, and only the winner's bytes reach the client. This
bounds the tail rather than the median — a run measured at 114 s without a second attempt landed
at 21 s worst case with three. It cannot beat a gateway that is broadly stalled, and every extra
attempt spends prompt tokens on requests that are cancelled, so set `AR_HEDGE=1` if you pay per
token and prefer waiting to duplicate work.

## Environment

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `AR_REASONING_EFFORT` | `low` | `reasoning.effort` used when the client sends none (`low` / `medium` / `high` / `max`) |
| `AR_VERBOSITY` | unset | Forces `text.verbosity` |
| `AR_HEDGE` | `2` | Concurrent attempts per request (1 disables hedging) |
| `AR_HEDGE_DELAY_MS` | `8000` | Gap before each extra attempt |
| `PORT` | `8789` | Listen port |

`/health` reports the effective hedging settings.

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
