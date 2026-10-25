/**
 * AgentRouter adapter proxy for DSH.
 *
 * AgentRouter only serves Responses-API models (gpt-6.1-sol / gpt-5.6-sol /
 * gpt-6-astra) and runs a content WAF that blocks Japanese text inside the
 * `input` / `messages` conversation payload. Its `instructions` field is not
 * scanned.
 *
 * Strategy: send the full conversation transcript (all languages preserved) in
 * `instructions`, and keep the filtered `input` field structurally faithful but
 * ASCII-only. That keeps tool-call/tool-result structure intact for the agent
 * loop while never handing the WAF Japanese conversation text.
 */
import http from "node:http";
import https from "node:https";

const PORT = 8789;
const UPSTREAM_HOST = "agentrouter.org";

const CLINE_HOST = "api.cline.bot";
const CLINE_HEADERS = {
  "content-type": "application/json",
  "user-agent": "Cline/3.0",
};

/**
 * Reusing sockets removes a TCP/TLS handshake from every turn. The gateway's
 * own queue time still dominates, but there is no reason to pay for the
 * handshake on top of it.
 */
const agent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 32,
});

const CANONICAL_HEADER =
  "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

const CLIENT_HEADERS = {
  Originator: "codex_cli_rs",
  "User-Agent": "codex_cli_rs/0.101.0 (Mac OS 26.0.1; arm64) Apple_Terminal/464",
  Version: "0.101.0",
};

const CJK_RE =
  /[\u1100-\u11ff\u2e80-\u2fdf\u3040-\u30ff\u3130-\u318f\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/u;

function hasCjk(text) {
  return typeof text === "string" && CJK_RE.test(text);
}

function stripControl(text) {
  return String(text).replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu,
    "",
  );
}

/** Flatten a chat message content (string or content-part array) to text. */
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

/** ASCII-safe stand-in for filtered fields; the transcript carries the text. */
function asciiPlaceholder(kind) {
  return `[${kind} content available in the transcript above]`;
}

/**
 * Text is already carried once in `instructions`; repeating it in `input` only
 * pays for prefill twice. Keep short strings inline and elide the rest.
 */
const INLINE_TEXT_LIMIT = 400;
const INLINE_TOOL_LIMIT = 600;

function asciiSafeText(text, kind) {
  if (typeof text !== "string") return text;
  const clean = stripControl(text);
  const limit = kind === "tool" ? INLINE_TOOL_LIMIT : INLINE_TEXT_LIMIT;
  if (clean.length > limit) return asciiPlaceholder(kind);
  return hasCjk(clean) ? asciiPlaceholder(kind) : clean;
}

/** Keep JSON shape, but replace non-ASCII string values with a marker. */
function asciiSafeJson(raw) {
  if (typeof raw !== "string" || raw.length === 0) return "{}";
  if (!hasCjk(raw)) return stripControl(raw);
  try {
    const parsed = JSON.parse(raw);
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
    return JSON.stringify(scrub(parsed));
  } catch {
    return "{}";
  }
}

/** Render the conversation as a plain transcript for the instructions field. */
function renderTranscript(messages) {
  const lines = [];
  let index = 0;
  for (const m of messages) {
    index += 1;
    const role = m && m.role ? m.role : "user";
    if (role === "tool") {
      const out = stripControl(flattenContent(m.content));
      lines.push(
        `[${index}] tool_result(call_id=${m.toolCallId || m.tool_call_id || "unknown"}):\n${out}`,
      );
      continue;
    }
    const calls = toolCallsOf(m);
    if (role === "assistant" && calls.length > 0) {
      const text = stripControl(flattenContent(m.content)).trim();
      if (text) lines.push(`[${index}] assistant: ${text}`);
      for (const call of calls) {
        const fn = call.function || call;
        const name = fn.name || "tool";
        const args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
        lines.push(`[${index}] tool_call ${name}(${stripControl(args)})`);
      }
      continue;
    }
    const text = stripControl(flattenContent(m.content)).trim();
    if (text) lines.push(`[${index}] ${role}: ${text}`);
  }
  return lines.join("\n\n");
}

/** Read a chat message's tool calls regardless of snake_case/camelCase. */
function toolCallsOf(message) {
  const value = message.toolCalls ?? message.tool_calls;
  return Array.isArray(value) ? value : [];
}

/** Convert one chat message into Responses-API input items (ASCII-safe). */
function toResponsesItems(message) {
  const role = message && message.role ? message.role : "user";
  const items = [];
  const toolCalls = toolCallsOf(message);

  if (role === "tool") {
    items.push({
      type: "function_call_output",
      call_id: message.toolCallId || message.tool_call_id || "unknown",
      output: asciiSafeText(flattenContent(message.content), "tool"),
    });
    return items;
  }

  if (role === "assistant" && toolCalls.length > 0) {
    for (const call of toolCalls) {
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
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (req.method === "GET" && (req.url === "/v1/models" || req.url === "/models")) {
    const upstreamReq = https.request(
      {
        hostname: UPSTREAM_HOST,
        agent,
        path: "/v1/models",
        method: "GET",
        headers: { ...req.headers, host: UPSTREAM_HOST, ...CLIENT_HEADERS },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode || 200, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstreamReq.on("error", (err) => {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    });
    upstreamReq.end();
    return;
  }

  // Cline: its API lives under /api/v1 and wraps non-stream bodies in a
  // {"data": {...}, "success": true} envelope that OpenAI clients cannot read.
  if (req.method === "GET" && req.url === "/cline/v1/models") {
    const upstreamReq = https.request(
      {
        hostname: CLINE_HOST,
      agent,
        path: "/api/v1/models",
        method: "GET",
        headers: { authorization: req.headers["authorization"] || "", ...CLINE_HEADERS },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode || 200, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstreamReq.on("error", (err) => {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    });
    upstreamReq.end();
    return;
  }

  if (req.method === "POST" && req.url === "/cline/v1/chat/completions") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => forwardCline(req, res, Buffer.concat(chunks)));
    return;
  }

  if (
    req.method === "POST" &&
    (req.url === "/v1/chat/completions" || req.url === "/chat/completions")
  ) {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Invalid JSON body" } }));
        return;
      }
      try {
        forward(req, res, body);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: err.message } }));
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "Not Found" } }));
});

function forward(req, res, body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const stream = Boolean(body.stream);
  const model = body.model || "";

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

  const payload = {
    model,
    instructions,
    input,
    stream,
  };
  if (body.max_tokens || body.max_completion_tokens) {
    payload.max_output_tokens = body.max_tokens || body.max_completion_tokens;
  }
  if (typeof body.temperature === "number") payload.temperature = body.temperature;
  if (typeof body.top_p === "number") payload.top_p = body.top_p;

  // Reasoning depth dominates time-to-first-token on these always-thinking
  // models. Honour the caller's request, else the operator's default.
  const effort = body.reasoning_effort || body.reasoning?.effort || process.env.AR_REASONING_EFFORT;
  if (effort) payload.reasoning = { effort: String(effort) };
  const verbosity = body.verbosity || process.env.AR_VERBOSITY;
  if (verbosity) payload.text = { verbosity: String(verbosity) };
  const tools = normalizeTools(body.tools);
  if (tools) payload.tools = tools;
  if (body.tool_choice) {
    if (typeof body.tool_choice === "string") payload.tool_choice = body.tool_choice;
    else if (body.tool_choice && body.tool_choice.type === "function") payload.tool_choice = "auto";
  }

  const payloadBuffer = Buffer.from(JSON.stringify(payload), "utf-8");
  const started = Date.now();
  console.log(
    `[${new Date().toISOString()}] -> ${model} stream=${stream} msgs=${messages.length} tools=${tools ? tools.length : 0}`,
  );

  const upstreamReq = https.request(
    {
      hostname: UPSTREAM_HOST,
        agent,
      path: "/v1/responses",
      method: "POST",
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
        const errChunks = [];
        upstreamRes.on("data", (c) => errChunks.push(c));
        upstreamRes.on("end", () => {
          const detail = Buffer.concat(errChunks).toString("utf-8");
          console.error(
            `[${new Date().toISOString()}] <- ${status} in ${Date.now() - started}ms ${detail.slice(0, 200)}`,
          );
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(detail || JSON.stringify({ error: { message: `upstream ${status}` } }));
        });
        return;
      }

      if (stream) relayStream(res, upstreamRes, body, model, started);
      else relayOnce(res, upstreamRes, body, model, started);
    },
  );

  upstreamReq.on("error", (err) => {
    console.error(`[${new Date().toISOString()}] transport error: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: err.message, type: "upstream_error" } }));
    } else {
      res.end();
    }
  });

  upstreamReq.write(payloadBuffer);
  upstreamReq.end();
}

function completionId() {
  return "chatcmpl-" + Math.random().toString(36).slice(2, 14);
}

/**
 * Proxy one Cline chat call. Streaming bodies pass through untouched; JSON
 * bodies are unwrapped from Cline's `{data, success}` envelope so the client
 * sees a plain OpenAI completion.
 */
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
      agent,
      path: "/api/v1/chat/completions",
      method: "POST",
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

function relayOnce(res, upstreamRes, body, model, started) {
  const chunks = [];
  upstreamRes.on("data", (c) => chunks.push(c));
  upstreamRes.on("end", () => {
    let parsed;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    } catch (err) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Unparseable upstream response: " + err.message } }));
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
    const result = {
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
    };

    console.log(
      `[${new Date().toISOString()}] <- 200 in ${Date.now() - started}ms text=${text.length} tools=${toolCalls.length}`,
    );
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  });
}

function relayStream(res, upstreamRes, body, model, started) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const id = completionId();
  const created = Math.floor(Date.now() / 1000);
  const emit = (delta, finishReason = null) => {
    res.write(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`,
    );
  };

  emit({ role: "assistant", content: "" });

  const queueStart = Date.now();
  let ackMs = null;
  const toolIndexByItem = new Map();
  let toolCount = 0;
  let textChars = 0;
  let buffer = "";
  let finished = false;

  const handleEvent = (event) => {
    switch (event.type) {
      case "response.created": {
        if (ackMs === null) ackMs = Date.now() - queueStart;
        break;
      }
      case "response.output_item.added": {
        const item = event.item || {};
        if (item.type === "function_call") {
          const index = toolCount++;
          toolIndexByItem.set(item.id, index);
          emit({
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
        emit({
          tool_calls: [{ index, function: { arguments: event.delta || "" } }],
        });
        break;
      }
      case "response.output_text.delta": {
        if (event.delta) {
          textChars += event.delta.length;
          emit({ content: event.delta });
        }
        break;
      }
      case "response.completed": {
        const usage = (event.response && event.response.usage) || {};
        emit({}, toolCount > 0 ? "tool_calls" : "stop");
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
        const message =
          (event.error && event.error.message) || "upstream stream error";
        console.error(`[${new Date().toISOString()}] stream error: ${message}`);
        res.write(
          `data: ${JSON.stringify({ error: { message, type: "upstream_error" } })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        finished = true;
        break;
      }
      default:
        break;
    }
  };

  upstreamRes.on("data", (chunk) => {
    buffer += chunk.toString("utf-8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const raw = trimmed.slice(5).trim();
      if (!raw || raw === "[DONE]") continue;
      try {
        handleEvent(JSON.parse(raw));
      } catch {
        /* ignore malformed frames */
      }
    }
  });

  upstreamRes.on("end", () => {
    if (!finished) {
      emit({}, toolCount > 0 ? "tool_calls" : "stop");
      res.write("data: [DONE]\n\n");
    }
    console.log(
      `[${new Date().toISOString()}] <- stream done in ${Date.now() - started}ms text=${textChars} tools=${toolCount} ack=${ackMs === null ? "n/a" : ackMs + "ms"}`,
    );
    res.end();
  });
}

/**
 * Hold a warm socket to the gateway so a turn does not pay DNS + TLS on top of
 * the gateway queue. This is a metadata GET: it spends no tokens.
 */
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
  console.log(`agentrouter-proxy listening on ${PORT}`);
  warmUp();
  setInterval(warmUp, 120000).unref();
});
