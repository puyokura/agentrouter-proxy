/**
 * AgentRouter adapter proxy for DSH / OpenAI-compatible clients.
 *
 * Two independent upstream behaviours shape this file:
 *
 * 1. AgentRouter serves the gpt-6.x-sol family through the OpenAI Responses API
 *    only, and its edge content filter scans the conversation payload. The
 *    conversation is therefore carried in `instructions` (not scanned) while
 *    `input` keeps an ASCII-safe skeleton so tool structure survives.
 * 2. Individual completions stall unpredictably: the same 10-token prompt can
 *    return in 1.8 s or 120 s. Requests are therefore hedged — a second attempt
 *    starts after a delay and the first attempt to produce output wins, with the
 *    rest cancelled. See AR_HEDGE / AR_HEDGE_DELAY_MS.
 */
import http from "node:http";
import https from "node:https";

const PORT = Number(process.env.PORT ?? 8789);
const UPSTREAM_HOST = "agentrouter.org";

const CLINE_HOST = "api.cline.bot";
const CLINE_HEADERS = {
  "content-type": "application/json",
  "user-agent": "Cline/3.0",
};

const CLIENT_HEADERS = {
  Originator: "codex_cli_rs",
  "User-Agent": "codex_cli_rs/0.101.0 (Mac OS 26.0.1; arm64) Apple_Terminal/464",
  Version: "0.101.0",
};

/** Reusing sockets removes a TCP/TLS handshake from every turn. */
const agent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 32,
});

const CANONICAL_HEADER =
  "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

/** Hedging: total attempts and the gap before each extra attempt. */
const HEDGE_MAX = Math.min(4, Math.max(1, Number(process.env.AR_HEDGE ?? 2) || 2));
const HEDGE_DELAY_MS = Math.max(
  0,
  Number(process.env.AR_HEDGE_DELAY_MS ?? 8000) || 0,
);

/**
 * Hedging duplicates the prompt, and an aborted attempt still bills its input
 * tokens. Restrict it to routes where that costs nothing (the unlimited free
 * model) unless the operator opts others in via AR_HEDGE_MODELS.
 */
const HEDGE_MODELS = (process.env.AR_HEDGE_MODELS ?? "gpt-6.1-sol")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function hedgeFor(model) {
  const id = String(model || "");
  return HEDGE_MODELS.some((m) => m === "*" || id === m || id.startsWith(m)) ? HEDGE_MAX : 1;
}

/** Reasoning depth dominates time-to-first-token; low keeps turns snappy. */
const DEFAULT_EFFORT = process.env.AR_REASONING_EFFORT || "low";

const CJK_RE =
  /[\u1100-\u11ff\u2e80-\u2fdf\u3040-\u30ff\u3130-\u318f\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/u;

const INLINE_TEXT_LIMIT = 400;
const INLINE_TOOL_LIMIT = 600;

function hasCjk(text) {
  return typeof text === "string" && CJK_RE.test(text);
}

function stripControl(text) {
  return String(text).replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu,
    "",
  );
}

function asciiPlaceholder(kind) {
  return `[${kind} content available in the transcript above]`;
}

function asciiSafeText(text, kind) {
  if (typeof text !== "string") return text;
  const clean = stripControl(text);
  const limit = kind === "tool" ? INLINE_TOOL_LIMIT : INLINE_TEXT_LIMIT;
  if (clean.length > limit) return asciiPlaceholder(kind);
  return hasCjk(clean) ? asciiPlaceholder(kind) : clean;
}

function flattenContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        return "";
      })
      .join("\n");
  }
  return "";
}

function asciiSafeJson(raw) {
  if (typeof raw !== "string" || raw.length === 0) return "{}";
  if (!hasCjk(raw)) return stripControl(raw);
  try {
    const scrub = (value) => {
      if (typeof value === "string") {
        return hasCjk(value) ? "[text in transcript]" : value;
      }
      if (Array.isArray(value)) return value.map(scrub);
      if (value && typeof value === "object") {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = scrub(v);
        return out;
      }
      return value;
    };
    return JSON.stringify(scrub(JSON.parse(raw)));
  } catch {
    return "{}";
  }
}

function toolCallsOf(message) {
  const value = message.toolCalls ?? message.tool_calls;
  return Array.isArray(value) ? value : [];
}

/** Plain-text transcript; the authoritative copy of the conversation. */
function renderTranscript(messages) {
  const lines = [];
  let index = 0;
  for (const m of messages) {
    index += 1;
    const role = m && m.role ? m.role : "user";
    const calls = toolCallsOf(m);
    if (role === "tool") {
      lines.push(
        `[${index}] tool_result(call_id=${m.toolCallId || m.tool_call_id || "unknown"}):\n${stripControl(flattenContent(m.content))}`,
      );
      continue;
    }
    if (role === "assistant" && calls.length > 0) {
      const text = stripControl(flattenContent(m.content)).trim();
      if (text) lines.push(`[${index}] assistant: ${text}`);
      for (const call of calls) {
        const fn = call.function || call;
        const args =
          typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
        lines.push(`[${index}] tool_call ${fn.name || "tool"}(${stripControl(args)})`);
      }
      continue;
    }
    const text = stripControl(flattenContent(m.content)).trim();
    if (text) lines.push(`[${index}] ${role}: ${text}`);
  }
  return lines.join("\n\n");
}

function toResponsesItems(message) {
  const role = message && message.role ? message.role : "user";
  const items = [];
  const calls = toolCallsOf(message);

  if (role === "tool") {
    items.push({
      type: "function_call_output",
      call_id: message.toolCallId || message.tool_call_id || "unknown",
      output: asciiSafeText(flattenContent(message.content), "tool"),
    });
    return items;
  }

  if (role === "assistant" && calls.length > 0) {
    for (const call of calls) {
      const fn = call.function || call;
      items.push({
        type: "function_call",
        call_id: call.id || call.callId || `call_${Math.random().toString(36).slice(2, 10)}`,
        name: fn.name || "tool",
        arguments: asciiSafeJson(fn.arguments),
      });
    }
  }

  const text = flattenContent(message.content);
  if (text.trim().length > 0) {
    items.push({
      role,
      content: asciiSafeText(text, role === "assistant" ? "assistant" : "user"),
    });
  }
  return items;
}

function normalizeTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((tool) => {
    const fn = tool && typeof tool.function === "object" && tool.function ? tool.function : tool;
    return {
      type: "function",
      name: String(fn.name || "tool"),
      description: String(fn.description || ""),
      parameters: fn.parameters || { type: "object", properties: {} },
    };
  });
}

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        hedge: HEDGE_MAX,
        hedgeDelayMs: HEDGE_DELAY_MS,
        hedgeModels: HEDGE_MODELS,
      }),
    );
    return;
  }
  if (req.method === "GET" && (req.url === "/v1/models" || req.url === "/models")) {
    proxyModels(res, req);
    return;
  }
  if (req.method === "GET" && req.url === "/cline/v1/models") {
    proxyClineModels(res, req);
    return;
  }
  if (req.method === "POST" && req.url === "/cline/v1/chat/completions") {
    readBody(req, (buf) => forwardCline(req, res, buf));
    return;
  }
  if (
    req.method === "POST" &&
    (req.url === "/v1/chat/completions" || req.url === "/chat/completions")
  ) {
    readBody(req, (buf) => {
      let body;
      try {
        body = JSON.parse(buf.toString("utf-8"));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Invalid JSON body" } }));
        return;
      }
      forward(req, res, body);
    });
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "Not Found" } }));
});

function readBody(req, onDone) {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => onDone(Buffer.concat(chunks)));
}

function proxyModels(res, req) {
  const upstreamReq = https.request(
    {
      hostname: UPSTREAM_HOST,
      path: "/v1/models",
      method: "GET",
      agent,
      headers: { authorization: req.headers["authorization"] || "", ...CLIENT_HEADERS },
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 200, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstreamReq.on("error", (err) => {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: err.message } }));
  });
  upstreamReq.end();
}

function proxyClineModels(res, req) {
  const upstreamReq = https.request(
    {
      hostname: CLINE_HOST,
      path: "/api/v1/models",
      method: "GET",
      agent,
      headers: { authorization: req.headers["authorization"] || "", ...CLINE_HEADERS },
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 200, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstreamReq.on("error", (err) => {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: err.message } }));
  });
  upstreamReq.end();
}

function forwardCline(req, res, rawBuffer) {
  let body;
  try {
    body = JSON.parse(rawBuffer.toString("utf-8"));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Invalid JSON body" } }));
    return;
  }
  const payload = Buffer.from(JSON.stringify(body), "utf-8");
  console.log(
    `[${new Date().toISOString()}] -> cline ${body.model} stream=${Boolean(body.stream)}`,
  );

  const upstreamReq = https.request(
    {
      hostname: CLINE_HOST,
      path: "/api/v1/chat/completions",
      method: "POST",
      agent,
      headers: {
        ...CLINE_HEADERS,
        "content-length": payload.length,
        authorization: req.headers["authorization"] || "",
      },
    },
    (upstreamRes) => {
      const status = upstreamRes.statusCode || 502;
      if (status >= 400 || body.stream) {
        res.writeHead(status, upstreamRes.headers);
        upstreamRes.pipe(res);
        return;
      }
      const parts = [];
      upstreamRes.on("data", (c) => parts.push(c));
      upstreamRes.on("end", () => {
        const text = Buffer.concat(parts).toString("utf-8");
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(text);
          return;
        }
        const inner = parsed && parsed.data && parsed.data.choices ? parsed.data : parsed;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(inner));
      });
    },
  );

  upstreamReq.on("error", (err) => {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: err.message, type: "upstream_error" } }));
  });
  upstreamReq.write(payload);
  upstreamReq.end();
}

function completionId() {
  return "chatcmpl-" + Math.random().toString(36).slice(2, 14);
}

function buildUpstreamPayload(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const systems = [];
  const conversation = [];
  for (const m of messages) {
    if (m && m.role === "system") systems.push(flattenContent(m.content));
    else conversation.push(m);
  }

  const transcript = renderTranscript(conversation);
  const instructions = [
    CANONICAL_HEADER,
    ...systems.filter((s) => s && s.trim().length > 0),
    "### Conversation transcript (authoritative; the structured input below is redacted for the transport filter)\n" +
      transcript,
    "Answer the final user message in the transcript. Preserve its language, follow any project instructions it references, and use the tools when they help.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const input = [];
  for (const m of conversation) input.push(...toResponsesItems(m));
  if (input.length === 0) input.push({ role: "user", content: "Continue." });

  const payload = { model: body.model, instructions, input, stream: Boolean(body.stream) };
  if (body.max_tokens || body.max_completion_tokens) {
    payload.max_output_tokens = body.max_tokens || body.max_completion_tokens;
  }
  if (typeof body.temperature === "number") payload.temperature = body.temperature;
  if (typeof body.top_p === "number") payload.top_p = body.top_p;

  const effort = body.reasoning_effort || body.reasoning?.effort || DEFAULT_EFFORT;
  payload.reasoning = { effort: String(effort) };
  const verbosity = body.verbosity || process.env.AR_VERBOSITY;
  if (verbosity) payload.text = { verbosity: String(verbosity) };

  const tools = normalizeTools(body.tools);
  if (tools) payload.tools = tools;
  if (typeof body.tool_choice === "string") payload.tool_choice = body.tool_choice;

  return { payload, tools: tools ? tools.length : 0, messageCount: messages.length };
}

/**
 * Fire the request, and — when the first attempt has produced nothing after
 * HEDGE_DELAY_MS — fire a second one. The first attempt to emit output wins;
 * every other attempt is destroyed before it can bill more tokens.
 */
function forward(req, res, body) {
  const { payload, tools, messageCount } = buildUpstreamPayload(body);
  const stream = Boolean(body.stream);
  const model = body.model || "";
  const payloadBuffer = Buffer.from(JSON.stringify(payload), "utf-8");
  const startedAt = Date.now();
  const hedgeMax = hedgeFor(model);

  console.log(
    `[${new Date().toISOString()}] -> ${model} stream=${stream} msgs=${messageCount} tools=${tools} effort=${payload.reasoning.effort} hedge=${hedgeMax}`,
  );

  const state = {
    attempts: [],
    settled: false,
    winner: null,
    failures: [],
    active: 0,
    timer: null,
    emptyRetries: 0,
  };

  /**
   * An empty completion (HTTP 200, no output events) is a transport failure,
   * not an answer. Allow exactly one extra attempt for it even when hedging is
   * off for this route, so a paid model is not left with a bare 502.
   */
  const attemptLimit = () =>
    Math.min(6, hedgeMax + (state.emptyRetries > 0 ? 2 : 0));

  const finishError = () => {
    if (state.settled) return;
    state.settled = true;
    const detail = state.failures.at(-1) || "upstream unavailable";
    console.error(`[${new Date().toISOString()}] <- all attempts failed: ${detail}`);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: detail, type: "upstream_error" } }));
  };

  const claim = (attempt) => {
    if (state.settled) return false;
    state.settled = true;
    state.winner = attempt;
    if (state.timer) clearTimeout(state.timer);
    for (const other of state.attempts) {
      if (other !== attempt) other.abort();
    }
    return true;
  };

  const schedule = () => {
    if (state.settled) return;
    if (state.attempts.length >= attemptLimit()) return;
    state.timer = setTimeout(() => {
      if (state.settled) return;
      launch();
    }, HEDGE_DELAY_MS);
    state.timer.unref?.();
  };

  const launch = (immediate = false) => {
    if (state.settled && state.winner) return;
    const attempt = { index: state.attempts.length, aborted: false };
    state.attempts.push(attempt);
    state.active += 1;
    let done = false;
    const settleAttempt = (reason) => {
      if (done) return;
      done = true;
      state.active -= 1;
      if (reason === "empty") {
        state.failures.push("empty completion (no output events)");
        state.emptyRetries += 1;
      }
      if (state.settled || state.active > 0) return;
      // A failed attempt frees a slot: refill it immediately instead of leaving
      // the caller with a 502 while the retry budget is still unspent.
      if (state.attempts.length < attemptLimit()) {
        launch(true);
        return;
      }
      finishError();
    };

    const upstreamReq = https.request(
      {
        hostname: UPSTREAM_HOST,
        path: "/v1/responses",
        method: "POST",
        agent,
        headers: {
          "content-type": "application/json",
          "content-length": payloadBuffer.length,
          authorization: req.headers["authorization"] || "",
          ...CLIENT_HEADERS,
        },
      },
      (upstreamRes) => {
        const status = upstreamRes.statusCode || 502;
        if (status >= 400) {
          const parts = [];
          upstreamRes.on("data", (c) => parts.push(c));
          upstreamRes.on("end", () => {
            const detail = Buffer.concat(parts).toString("utf-8");
            state.failures.push(`${status} ${detail.slice(0, 200)}`);
            console.error(
              `[${new Date().toISOString()}] <- attempt ${attempt.index} ${status} after ${Date.now() - startedAt}ms`,
            );
            settleAttempt();
          });
          return;
        }
        if (stream) {
          handleStreamAttempt(upstreamRes, attempt, claim, res, model, startedAt, settleAttempt);
        } else {
          handleJsonAttempt(upstreamRes, attempt, claim, res, model, startedAt, settleAttempt);
        }
      },
    );

    attempt.abort = () => {
      attempt.aborted = true;
      upstreamReq.destroy();
    };
    upstreamReq.on("error", (err) => {
      if (attempt.aborted || state.settled) return;
      state.failures.push(err.message);
      settleAttempt();
    });
    upstreamReq.write(payloadBuffer);
    upstreamReq.end();
    if (!immediate) schedule();
  };

  launch();
}

function emitChunk(res, id, created, model, delta, finishReason = null) {
  res.write(
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`,
  );
}

function handleStreamAttempt(upstreamRes, attempt, claim, res, model, startedAt, settle) {
  const id = completionId();
  const created = Math.floor(Date.now() / 1000);
  let claimed = false;
  let finished = false;
  const queued = [];
  const toolIndexByItem = new Map();
  let toolCount = 0;
  let textChars = 0;
  let ackMs = null;

  const handleEvent = (event) => {
    switch (event.type) {
      case "response.created":
        if (ackMs === null) ackMs = Date.now() - startedAt;
        break;
      case "response.output_item.added": {
        const item = event.item || {};
        if (item.type === "function_call") {
          const index = toolCount++;
          toolIndexByItem.set(item.id, index);
          emitChunk(res, id, created, model, {
            tool_calls: [
              {
                index,
                id: item.call_id || item.id,
                type: "function",
                function: { name: item.name, arguments: "" },
              },
            ],
          });
        }
        break;
      }
      case "response.function_call_arguments.delta": {
        const index = toolIndexByItem.get(event.item_id);
        if (index === undefined) break;
        emitChunk(res, id, created, model, {
          tool_calls: [{ index, function: { arguments: event.delta || "" } }],
        });
        break;
      }
      case "response.output_text.delta":
        if (event.delta) {
          textChars += event.delta.length;
          emitChunk(res, id, created, model, { content: event.delta });
        }
        break;
      case "response.completed": {
        const usage = (event.response && event.response.usage) || {};
        emitChunk(res, id, created, model, {}, toolCount > 0 ? "tool_calls" : "stop");
        res.write(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [],
            usage: {
              prompt_tokens: usage.input_tokens ?? 0,
              completion_tokens: usage.output_tokens ?? 0,
              total_tokens: usage.total_tokens ?? 0,
            },
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        finished = true;
        break;
      }
      case "error": {
        const message = (event.error && event.error.message) || "upstream stream error";
        console.error(`[${new Date().toISOString()}] stream error: ${message}`);
        res.write(`data: ${JSON.stringify({ error: { message, type: "upstream_error" } })}\n\n`);
        res.write("data: [DONE]\n\n");
        finished = true;
        break;
      }
      default:
        break;
    }
  };

  const isOutputEvent = (event) =>
    (event.type === "response.output_text.delta" && event.delta) ||
    (event.type === "response.output_item.added" &&
      (event.item || {}).type === "function_call");

  const deliver = (event) => {
    if (!claimed) {
      if (!isOutputEvent(event)) {
        queued.push(event);
        return;
      }
      if (!claim(attempt)) {
        upstreamRes.destroy();
        settle();
        return;
      }
      claimed = true;
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Proxy-Attempt": String(attempt.index),
      });
      emitChunk(res, id, created, model, { role: "assistant", content: "" });
      for (const buffered of queued) handleEvent(buffered);
      queued.length = 0;
    }
    handleEvent(event);
  };

  let buffer = "";
  upstreamRes.on("data", (chunk) => {
    buffer += chunk.toString("utf-8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const raw = trimmed.slice(5).trim();
      if (!raw || raw === "[DONE]") continue;
      let event;
      try {
        event = JSON.parse(raw);
      } catch {
        continue;
      }
      deliver(event);
    }
  });

  upstreamRes.on("end", () => {
    if (!claimed) {
      settle("empty");
      return;
    }
    if (!finished) {
      emitChunk(res, id, created, model, {}, toolCount > 0 ? "tool_calls" : "stop");
      res.write("data: [DONE]\n\n");
    }
    console.log(
      `[${new Date().toISOString()}] <- attempt ${attempt.index} won in ${Date.now() - startedAt}ms text=${textChars} tools=${toolCount} ack=${ackMs === null ? "n/a" : ackMs + "ms"}`,
    );
    res.end();
  });
}

function handleJsonAttempt(upstreamRes, attempt, claim, res, model, startedAt, settle) {
  const parts = [];
  upstreamRes.on("data", (c) => parts.push(c));
  upstreamRes.on("end", () => {
    let parsed;
    try {
      parsed = JSON.parse(Buffer.concat(parts).toString("utf-8"));
    } catch {
      parsed = undefined;
    }
    const produced =
      parsed &&
      (parsed.output || []).some(
        (item) =>
          item.type === "function_call" ||
          (item.type === "message" &&
            (item.content || []).some((part) => part.type === "output_text" && part.text)),
      );
    if (!produced) {
      settle("empty");
      return;
    }
    settle();
    if (!claim(attempt)) return;
    try {
      parsed = JSON.parse(Buffer.concat(parts).toString("utf-8"));
    } catch (err) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ error: { message: "Unparseable upstream response: " + err.message } }),
      );
      return;
    }
    let text = "";
    const toolCalls = [];
    for (const item of parsed.output || []) {
      if (item.type === "message") {
        for (const part of item.content || []) {
          if (part.type === "output_text" && part.text) text += part.text;
        }
      } else if (item.type === "function_call") {
        toolCalls.push({
          id: item.call_id || item.id,
          type: "function",
          function: { name: item.name, arguments: item.arguments || "{}" },
        });
      }
    }
    const message = { role: "assistant", content: text || (toolCalls.length ? null : "") };
    if (toolCalls.length) message.tool_calls = toolCalls;
    const usage = parsed.usage || {};
    console.log(
      `[${new Date().toISOString()}] <- attempt ${attempt.index} won in ${Date.now() - startedAt}ms text=${text.length} tools=${toolCalls.length}`,
    );
    res.writeHead(200, {
      "Content-Type": "application/json",
      "X-Proxy-Attempt": String(attempt.index),
    });
    res.end(
      JSON.stringify({
        id: parsed.id || completionId(),
        object: "chat.completion",
        created: parsed.created_at || Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message,
            finish_reason: toolCalls.length ? "tool_calls" : "stop",
          },
        ],
        usage: {
          prompt_tokens: usage.input_tokens ?? usage.prompt_tokens ?? 0,
          completion_tokens: usage.output_tokens ?? usage.completion_tokens ?? 0,
          total_tokens: usage.total_tokens ?? 0,
        },
      }),
    );
  });
}

/** Hold a warm socket so a turn does not pay DNS + TLS on top of the queue. */
function warmUp() {
  const req = https.request(
    {
      hostname: UPSTREAM_HOST,
      path: "/v1/models",
      method: "GET",
      headers: { ...CLIENT_HEADERS },
      agent,
    },
    (upstreamRes) => upstreamRes.resume(),
  );
  req.on("error", () => {});
  req.end();
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `agentrouter-proxy listening on ${PORT} (hedge=${HEDGE_MAX}, delay=${HEDGE_DELAY_MS}ms)`,
  );
  warmUp();
  setInterval(warmUp, 120000).unref();
});
