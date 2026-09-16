import { afterEach, describe, expect, it, vi } from "vitest"

import type { QianwenResponsesBridge } from "./qianwen-responses-bridge"
import { startQianwenResponsesBridge } from "./qianwen-responses-bridge"

const schema = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
}

const bridges = new Set<QianwenResponsesBridge>()

const completion = (
  overrides: Record<string, unknown> = {},
  usage: unknown = {
    prompt_tokens: 12,
    completion_tokens: 5,
    total_tokens: 17,
    prompt_tokens_details: { cached_tokens: 3 },
  },
) => ({
  id: "chatcmpl-test",
  model: "qwen3.8-flash",
  choices: [
    {
      index: 0,
      finish_reason: "stop",
      message: { role: "assistant", content: '{"ok":true}' },
      ...overrides,
    },
  ],
  ...(usage === undefined ? {} : { usage }),
})

const start = async (
  fetchImpl: NonNullable<Parameters<typeof startQianwenResponsesBridge>[0]["fetchImpl"]>,
  signal?: AbortSignal,
) => {
  const bridge = await startQianwenResponsesBridge({
    apiKey: "private-qianwen-key",
    model: "qwen3.8-flash",
    schema,
    fetchImpl,
    signal,
  })
  bridges.add(bridge)
  return bridge
}

const codexBody = (overrides: Record<string, unknown> = {}) => ({
  model: "qwen3.8-flash",
  instructions: "Return the requested object.",
  input: [{ role: "user", content: [{ type: "input_text", text: "Set ok true." }] }],
  text: {
    format: {
      type: "json_schema",
      name: "codex_output_schema",
      strict: true,
      schema,
    },
  },
  stream: true,
  ...overrides,
})

const callBridge = (
  bridge: QianwenResponsesBridge,
  body: unknown = codexBody(),
  token = bridge.accessToken,
) =>
  fetch(`${bridge.baseUrl}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })

const parseEvents = (body: string) =>
  body
    .split("\n\n")
    .filter(Boolean)
    .map((entry) => {
      const data = entry.split("\n").find((line) => line.startsWith("data: "))
      if (!data) throw new Error("missing SSE data")
      return JSON.parse(data.slice("data: ".length)) as Record<string, unknown>
    })

afterEach(async () => {
  await Promise.all([...bridges].map((bridge) => bridge.close()))
  bridges.clear()
})

describe("Qianwen Responses loopback bridge", () => {
  it("将纯文本 Responses 请求转换为严格、关闭思考的 Chat 请求", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json(completion(), { status: 200 }),
    )
    const bridge = await start(fetchImpl)
    const response = await callBridge(
      bridge,
      codexBody({
        tools: [
          {
            type: "function",
            name: "read_local_context",
            description: "Private tool declaration that must not be forwarded",
            parameters: { type: "object", properties: {} },
          },
          { type: "local_shell" },
        ],
        tool_choice: "auto",
        input: [
          { role: "system", content: "System context" },
          {
            role: "developer",
            content: [{ type: "input_text", text: "Developer context" }],
          },
          { role: "user", content: [{ type: "input_text", text: "Question" }] },
          {
            type: "message",
            id: "msg-old",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: "Prior answer" }],
          },
        ],
      }),
    )

    expect(response.status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const call = fetchImpl.mock.calls[0]
    expect(call).toBeDefined()
    const url = call?.[0]
    const init = call?.[1]
    expect(url).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions")
    expect(init?.headers).toEqual({
      Authorization: "Bearer private-qianwen-key",
      "Content-Type": "application/json",
    })
    expect(init?.redirect).toBe("error")
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "qwen3.8-flash",
      messages: [
        { role: "system", content: "Return the requested object." },
        { role: "system", content: "System context" },
        { role: "system", content: "Developer context" },
        { role: "user", content: "Question" },
        { role: "assistant", content: "Prior answer" },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "codex_output_schema",
          strict: true,
          schema,
        },
      },
      enable_thinking: false,
      stream: false,
    })
    expect(String(init?.body)).not.toContain("read_local_context")
    expect(String(init?.body)).not.toContain("local_shell")
    expect(bridge.getUsage()).toEqual({
      inputTokens: 12,
      outputTokens: 5,
      cachedInputTokens: 3,
    })
  })

  it("返回 Codex 可消费的完整 Responses SSE 生命周期和真实用量", async () => {
    const bridge = await start(async () => Response.json(completion()))
    const response = await callBridge(bridge)
    const events = parseEvents(await response.text())

    expect(response.headers.get("content-type")).toContain("text/event-stream")
    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ])
    expect(events[3]).toEqual(expect.objectContaining({ delta: '{"ok":true}' }))
    expect(events.at(-1)?.response).toEqual(
      expect.objectContaining({
        status: "completed",
        usage: {
          input_tokens: 12,
          input_tokens_details: { cached_tokens: 3 },
          output_tokens: 5,
          total_tokens: 17,
        },
      }),
    )
  })

  it("随机 token 隔离任务，并拒绝未认证请求", async () => {
    const fetchImpl = vi.fn(async () => Response.json(completion()))
    const first = await start(fetchImpl)
    const second = await start(fetchImpl)
    expect(first.accessToken).not.toBe(second.accessToken)

    const response = await callBridge(first, codexBody(), "wrong-token")
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: { type: "bridge_error", code: "unauthorized" },
    })
    expect(first.getFailureCode()).toBe("unauthorized")
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("每个任务只允许一次通过本地校验的生成请求", async () => {
    const fetchImpl = vi.fn(async () => Response.json(completion()))
    const bridge = await start(fetchImpl)

    const invalid = await callBridge(bridge, codexBody({ model: "other-model" }))
    expect(invalid.status).toBe(400)
    expect((await callBridge(bridge)).status).toBe(200)

    const repeated = await callBridge(bridge)
    expect(repeated.status).toBe(409)
    expect(await repeated.json()).toEqual({
      error: { type: "bridge_error", code: "generation_already_started" },
    })
    expect(bridge.getFailureCode()).toBe("generation_already_started")
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["malformed JSON", "{", "invalid_json"],
    ["wrong model", codexBody({ model: "other-model" }), "invalid_model"],
    ["malformed tools", codexBody({ tools: [{ name: "missing-type" }] }), "invalid_tools"],
    [
      "forced tool",
      codexBody({
        tools: [{ type: "function", name: "forced" }],
        tool_choice: { type: "function", name: "forced" },
      }),
      "forced_tool_not_supported",
    ],
    [
      "required tool",
      codexBody({ tools: [], tool_choice: "required" }),
      "forced_tool_not_supported",
    ],
    [
      "schema mismatch",
      codexBody({
        text: {
          format: {
            type: "json_schema",
            name: "codex_output_schema",
            strict: true,
            schema: { type: "object" },
          },
        },
      }),
      "invalid_output_schema",
    ],
    [
      "image input",
      codexBody({
        input: [{ role: "user", content: [{ type: "input_image", image_url: "private" }] }],
      }),
      "unsupported_input",
    ],
    [
      "function call input",
      codexBody({
        input: [{ type: "function_call", name: "hidden", arguments: "{}", call_id: "1" }],
      }),
      "unsupported_input",
    ],
    [
      "tool output input",
      codexBody({
        input: [{ type: "function_call_output", call_id: "1", output: "private" }],
      }),
      "unsupported_input",
    ],
  ])("在 %s 时固定分类拒绝且不调用上游", async (_name, body, code) => {
    const fetchImpl = vi.fn(async () => Response.json(completion()))
    const bridge = await start(fetchImpl)
    const response = await callBridge(bridge, body)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: { type: "bridge_error", code } })
    expect(bridge.getFailureCode()).toBe(code)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("限制请求体与上游响应体为 1 MiB", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ padding: "x".repeat(1024 * 1024) })),
    )
    const bridge = await start(fetchImpl)

    const oversizedRequest = await callBridge(bridge, "x".repeat(1024 * 1024 + 1))
    expect(oversizedRequest.status).toBe(413)
    expect(fetchImpl).not.toHaveBeenCalled()

    const oversizedUpstream = await callBridge(bridge)
    expect(oversizedUpstream.status).toBe(502)
    expect(await oversizedUpstream.json()).toEqual({
      error: { type: "bridge_error", code: "upstream_response_too_large" },
    })
    expect(bridge.getFailureCode()).toBe("upstream_response_too_large")
  })

  it.each([
    ["non-200", () => Response.json({ secret: "not exposed" }, { status: 429 }), "upstream_error"],
    [
      "length",
      () => Response.json(completion({ finish_reason: "length" })),
      "upstream_incomplete_response",
    ],
    [
      "refusal",
      () =>
        Response.json(
          completion({
            message: { role: "assistant", content: '{"ok":true}', refusal: "private" },
          }),
        ),
      "upstream_invalid_response",
    ],
    [
      "empty",
      () => Response.json(completion({ message: { role: "assistant", content: "" } })),
      "upstream_invalid_response",
    ],
    [
      "invalid JSON output",
      () => Response.json(completion({ message: { role: "assistant", content: "```json" } })),
      "upstream_invalid_output",
    ],
  ])("严格拒绝上游 %s，且错误不回显正文", async (name, makeResponse, code) => {
    const bridge = await start(async () => makeResponse())
    const response = await callBridge(bridge)

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: { type: "bridge_error", code } })
    expect(bridge.getFailureCode()).toBe(code)
    if (name === "non-200") expect(bridge.getUsage()).toBeNull()
    else {
      expect(bridge.getUsage()).toEqual({
        inputTokens: 12,
        outputTokens: 5,
        cachedInputTokens: 3,
      })
    }
  })

  it("缺少可确认用量时保持 null，不伪造 cached input 为零", async () => {
    const bridge = await start(async () => Response.json(completion({}, null)))
    const response = await callBridge(bridge)
    const events = parseEvents(await response.text())

    expect(response.status).toBe(200)
    expect(bridge.getUsage()).toBeNull()
    expect(bridge.getFailureCode()).toBeNull()
    expect(events.at(-1)?.response).toEqual(expect.objectContaining({ usage: null }))
  })

  it("外部取消会关闭监听并中止正在进行的上游请求", async () => {
    const controller = new AbortController()
    let upstreamStarted: (() => void) | undefined
    let upstreamAborted = false
    const started = new Promise<void>((resolve) => {
      upstreamStarted = resolve
    })
    const bridge = await start(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          upstreamStarted?.()
          init?.signal?.addEventListener(
            "abort",
            () => {
              upstreamAborted = true
              reject(new DOMException("Aborted", "AbortError"))
            },
            { once: true },
          )
        }),
      controller.signal,
    )
    const request = callBridge(bridge).catch(() => undefined)
    await started

    controller.abort()
    await bridge.close()
    await request
    expect(upstreamAborted).toBe(true)
  })
})
