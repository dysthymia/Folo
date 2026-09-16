import { randomBytes, timingSafeEqual } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"
import { createServer } from "node:http"
import { isDeepStrictEqual } from "node:util"

const MAX_BODY_BYTES = 1024 * 1024
const QIANWEN_CHAT_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

type JsonRecord = Record<string, unknown>

export interface QianwenBridgeUsage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
}

export interface QianwenResponsesBridge {
  baseUrl: string
  accessToken: string
  getUsage(): QianwenBridgeUsage | null
  getFailureCode(): string | null
  close(): Promise<void>
}

export interface StartQianwenResponsesBridgeOptions {
  apiKey: string
  model: string
  schema: object
  signal?: AbortSignal
  fetchImpl?: FetchImplementation
}

type ChatRole = "system" | "user" | "assistant"

interface ChatMessage {
  role: ChatRole
  content: string
}

class BridgeRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code)
    this.name = "BridgeRequestError"
  }
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isSafeTokenCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0

const isAuthorized = (header: string | undefined, token: string) => {
  if (!header?.startsWith("Bearer ")) return false
  const candidate = Buffer.from(header.slice("Bearer ".length))
  const expected = Buffer.from(token)
  return candidate.length === expected.length && timingSafeEqual(candidate, expected)
}

const sendError = (response: ServerResponse, status: number, code: string) => {
  if (response.headersSent || response.destroyed) return
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" })
  response.end(JSON.stringify({ error: { type: "bridge_error", code } }))
}

const readRequestBody = async (request: IncomingMessage): Promise<unknown> => {
  const declaredLength = Number(request.headers["content-length"])
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new BridgeRequestError(413, "request_too_large")
  }

  const chunks: Buffer[] = []
  let totalBytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    totalBytes += buffer.byteLength
    if (totalBytes > MAX_BODY_BYTES) throw new BridgeRequestError(413, "request_too_large")
    chunks.push(buffer)
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    throw new BridgeRequestError(400, "invalid_json")
  }
}

const readResponseBody = async (response: Response): Promise<unknown> => {
  const declaredLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new BridgeRequestError(502, "upstream_response_too_large")
  }
  if (!response.body) throw new BridgeRequestError(502, "upstream_invalid_response")

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      totalBytes += result.value.byteLength
      if (totalBytes > MAX_BODY_BYTES) {
        await reader.cancel()
        throw new BridgeRequestError(502, "upstream_response_too_large")
      }
      chunks.push(result.value)
    }
  } finally {
    reader.releaseLock()
  }

  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")
  try {
    return JSON.parse(body)
  } catch {
    throw new BridgeRequestError(502, "upstream_invalid_response")
  }
}

const contentToText = (role: string, content: unknown) => {
  if (typeof content === "string") return content
  if (!Array.isArray(content) || content.length === 0) {
    throw new BridgeRequestError(400, "unsupported_input")
  }

  const expectedType = role === "assistant" ? "output_text" : "input_text"
  return content
    .map((part) => {
      if (!isRecord(part) || part.type !== expectedType || typeof part.text !== "string") {
        throw new BridgeRequestError(400, "unsupported_input")
      }
      return part.text
    })
    .join("\n")
}

const convertInput = (input: unknown, instructions: unknown): ChatMessage[] => {
  const messages: ChatMessage[] = []
  if (instructions !== undefined && typeof instructions !== "string") {
    throw new BridgeRequestError(400, "invalid_instructions")
  }
  if (typeof instructions === "string" && instructions.length > 0) {
    messages.push({ role: "system", content: instructions })
  }

  if (typeof input === "string") {
    if (!input.length) throw new BridgeRequestError(400, "unsupported_input")
    messages.push({ role: "user", content: input })
    return messages
  }
  if (!Array.isArray(input) || input.length === 0) {
    throw new BridgeRequestError(400, "unsupported_input")
  }

  for (const item of input) {
    if (!isRecord(item) || (item.type !== undefined && item.type !== "message")) {
      throw new BridgeRequestError(400, "unsupported_input")
    }
    if (!["system", "developer", "user", "assistant"].includes(String(item.role))) {
      throw new BridgeRequestError(400, "unsupported_input")
    }
    const role = String(item.role)
    const content = contentToText(role, item.content)
    if (!content.length) throw new BridgeRequestError(400, "unsupported_input")
    // 千问 Chat 接口使用 system 承载 Codex 的 developer 指令。
    messages.push({
      role: role === "developer" ? "system" : (role as ChatRole),
      content,
    })
  }
  return messages
}

const validateFormat = (body: JsonRecord, schema: object) => {
  if (!isRecord(body.text) || !isRecord(body.text.format)) {
    throw new BridgeRequestError(400, "invalid_output_schema")
  }
  const format = body.text.format
  if (
    format.type !== "json_schema" ||
    format.name !== "codex_output_schema" ||
    format.strict !== true ||
    !isDeepStrictEqual(format.schema, schema)
  ) {
    throw new BridgeRequestError(400, "invalid_output_schema")
  }
  return "codex_output_schema"
}

const validateToolDeclarations = (body: JsonRecord) => {
  const tools = body.tools
  if (
    tools !== undefined &&
    tools !== null &&
    (!Array.isArray(tools) ||
      tools.some((tool) => !isRecord(tool) || typeof tool.type !== "string" || !tool.type.length))
  ) {
    throw new BridgeRequestError(400, "invalid_tools")
  }
  if (
    body.tool_choice !== undefined &&
    body.tool_choice !== "auto" &&
    body.tool_choice !== "none"
  ) {
    throw new BridgeRequestError(400, "forced_tool_not_supported")
  }
  // Codex 的能力声明不代表发生了工具活动；桥验证后丢弃，绝不转发给千问。
}

const readUsage = (payload: JsonRecord): QianwenBridgeUsage | null => {
  if (!isRecord(payload.usage) || !isRecord(payload.usage.prompt_tokens_details)) return null
  const inputTokens = payload.usage.prompt_tokens
  const outputTokens = payload.usage.completion_tokens
  const totalTokens = payload.usage.total_tokens
  const cachedInputTokens = payload.usage.prompt_tokens_details.cached_tokens
  if (
    !isSafeTokenCount(inputTokens) ||
    !isSafeTokenCount(outputTokens) ||
    !isSafeTokenCount(totalTokens) ||
    !isSafeTokenCount(cachedInputTokens) ||
    totalTokens !== inputTokens + outputTokens
  ) {
    return null
  }
  return { inputTokens, outputTokens, cachedInputTokens }
}

const readCompletion = (payload: unknown) => {
  if (!isRecord(payload) || !Array.isArray(payload.choices) || payload.choices.length !== 1) {
    throw new BridgeRequestError(502, "upstream_invalid_response")
  }
  const choice = payload.choices[0]
  if (!isRecord(choice) || choice.finish_reason !== "stop" || !isRecord(choice.message)) {
    throw new BridgeRequestError(502, "upstream_incomplete_response")
  }
  const message = choice.message
  if (
    message.role !== "assistant" ||
    (message.refusal !== undefined && message.refusal !== null) ||
    (message.tool_calls !== undefined && message.tool_calls !== null) ||
    (message.function_call !== undefined && message.function_call !== null) ||
    typeof message.content !== "string" ||
    message.content.length === 0
  ) {
    throw new BridgeRequestError(502, "upstream_invalid_response")
  }
  try {
    JSON.parse(message.content)
  } catch {
    throw new BridgeRequestError(502, "upstream_invalid_output")
  }
  return { text: message.content }
}

const responseEnvelope = (
  id: string,
  model: string,
  status: "in_progress" | "completed",
  output: unknown[],
  usage: QianwenBridgeUsage | null,
) => ({
  id,
  object: "response",
  created_at: Math.floor(Date.now() / 1000),
  status,
  model,
  output,
  usage:
    usage === null
      ? null
      : {
          input_tokens: usage.inputTokens,
          input_tokens_details: { cached_tokens: usage.cachedInputTokens },
          output_tokens: usage.outputTokens,
          total_tokens: usage.inputTokens + usage.outputTokens,
        },
})

const sendSseResponse = (
  response: ServerResponse,
  model: string,
  text: string,
  usage: QianwenBridgeUsage | null,
) => {
  const responseId = `resp_${randomBytes(16).toString("hex")}`
  const itemId = `msg_${randomBytes(16).toString("hex")}`
  const part = { type: "output_text", text, annotations: [] }
  const pendingItem = {
    id: itemId,
    type: "message",
    status: "in_progress",
    role: "assistant",
    content: [],
  }
  const completedItem = { ...pendingItem, status: "completed", content: [part] }
  const events = [
    {
      type: "response.created",
      response: responseEnvelope(responseId, model, "in_progress", [], null),
    },
    { type: "response.output_item.added", output_index: 0, item: pendingItem },
    {
      type: "response.content_part.added",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_text.done",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      text,
    },
    {
      type: "response.content_part.done",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part,
    },
    { type: "response.output_item.done", output_index: 0, item: completedItem },
    {
      type: "response.completed",
      response: responseEnvelope(responseId, model, "completed", [completedItem], usage),
    },
  ]

  response.writeHead(200, {
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream; charset=utf-8",
  })
  for (const event of events) {
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  }
  response.end()
}

export async function startQianwenResponsesBridge({
  apiKey,
  model,
  schema,
  signal,
  fetchImpl = fetch,
}: StartQianwenResponsesBridgeOptions): Promise<QianwenResponsesBridge> {
  if (!apiKey.trim() || !model.trim() || signal?.aborted) {
    throw new BridgeRequestError(400, "invalid_options")
  }

  const accessToken = randomBytes(32).toString("base64url")
  const upstreamControllers = new Set<AbortController>()
  let latestUsage: QianwenBridgeUsage | null = null
  let latestFailureCode: string | null = null
  let generationStarted = false
  let closing: Promise<void> | undefined

  const server = createServer(async (request, response) => {
    const fail = (status: number, code: string) => {
      // 只保留固定分类，禁止把异常消息、请求正文或凭据带回调用方。
      latestFailureCode = code
      sendError(response, status, code)
    }
    try {
      if (!isAuthorized(request.headers.authorization, accessToken)) {
        fail(401, "unauthorized")
        return
      }
      if (request.method !== "POST") {
        fail(405, "method_not_allowed")
        return
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1")
      if (!["/responses", "/v1/responses"].includes(url.pathname) || url.search) {
        fail(404, "not_found")
        return
      }

      const rawBody = await readRequestBody(request)
      if (!isRecord(rawBody) || rawBody.model !== model) {
        throw new BridgeRequestError(400, "invalid_model")
      }
      validateToolDeclarations(rawBody)
      const schemaName = validateFormat(rawBody, schema)
      const messages = convertInput(rawBody.input, rawBody.instructions)
      if (generationStarted) throw new BridgeRequestError(409, "generation_already_started")
      generationStarted = true
      latestUsage = null

      const upstreamController = new AbortController()
      upstreamControllers.add(upstreamController)
      const abortUpstream = () => upstreamController.abort()
      request.once("aborted", abortUpstream)
      response.once("close", () => {
        if (!response.writableEnded) abortUpstream()
      })

      let completion: ReturnType<typeof readCompletion>
      try {
        const upstreamResponse = await fetchImpl(QIANWEN_CHAT_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            messages,
            response_format: {
              type: "json_schema",
              json_schema: { name: schemaName, strict: true, schema },
            },
            enable_thinking: false,
            stream: false,
          }),
          redirect: "error",
          signal: upstreamController.signal,
        })
        if (!upstreamResponse.ok) throw new BridgeRequestError(502, "upstream_error")
        const payload = await readResponseBody(upstreamResponse)
        latestUsage = isRecord(payload) ? readUsage(payload) : null
        completion = readCompletion(payload)
      } finally {
        request.removeListener("aborted", abortUpstream)
        upstreamControllers.delete(upstreamController)
      }

      sendSseResponse(response, model, completion.text, latestUsage)
    } catch (error) {
      if (error instanceof BridgeRequestError) fail(error.status, error.code)
      else fail(502, "upstream_error")
    }
  })

  const close = () => {
    if (closing) return closing
    closing = new Promise<void>((resolveClose) => {
      for (const controller of upstreamControllers) controller.abort()
      server.close(() => resolveClose())
      server.closeAllConnections()
    })
    signal?.removeEventListener("abort", close)
    return closing
  }
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen)
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", rejectListen)
      resolveListen()
    })
  })
  const address = server.address()
  if (!address || typeof address === "string") {
    await close()
    throw new BridgeRequestError(500, "listen_failed")
  }
  signal?.addEventListener("abort", close, { once: true })
  if (signal?.aborted) {
    await close()
    throw new BridgeRequestError(400, "invalid_options")
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    accessToken,
    getUsage: () => latestUsage,
    getFailureCode: () => latestFailureCode,
    close,
  }
}
