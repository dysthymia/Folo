import { afterEach, describe, expect, it, vi } from "vitest"

import { oneTimeToken } from "~/lib/auth"

import {
  feedbackRecordResponseSchema,
  FeedbackRequestError,
  loadProcessingFeedback,
  saveProcessingFeedback,
} from "./processing-feedback-client"

vi.mock("~/lib/auth", () => ({ oneTimeToken: { generate: vi.fn() } }))

const record = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "wrong_merge" as const,
  target: {
    kind: "entry" as const,
    inputSeq: 12,
    sourceKey: "feed/1",
    itemId: "item-12",
    contentVersion: "v1",
    decisionId: "decision-12",
    releaseVersion: 3,
  },
  explanation: "说明",
  referenceIds: [],
  suggestion: null,
  createdAt: "2026-09-12T00:00:00.000Z",
}

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe("processing feedback client", () => {
  it("列表读取使用空体 POST 和读取标记", async () => {
    vi.mocked(oneTimeToken.generate).mockResolvedValue({ data: { token: "once" } } as Awaited<
      ReturnType<typeof oneTimeToken.generate>
    >)
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ feedback: [] })),
    )
    vi.stubGlobal("fetch", fetcher)

    await loadProcessingFeedback(new AbortController().signal)

    const init = fetcher.mock.calls[0]?.[1]
    expect(init).toEqual(expect.objectContaining({ method: "POST" }))
    expect(init?.body).toBeUndefined()
    expect(new Headers(init?.headers).get("X-Folo-Read")).toBe("1")
  })

  it("严格校验完整反馈记录", () => {
    expect(feedbackRecordResponseSchema.safeParse({ feedback: record }).success).toBe(true)
    expect(
      feedbackRecordResponseSchema.safeParse({ feedback: { ...record, unexpected: true } }).success,
    ).toBe(false)
  })

  it("提交 entry 时携带 expectedDecisionId 和新一次性令牌", async () => {
    vi.mocked(oneTimeToken.generate).mockResolvedValue({ data: { token: "once" } } as Awaited<
      ReturnType<typeof oneTimeToken.generate>
    >)
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ feedback: record })))
    vi.stubGlobal("fetch", fetcher)
    await saveProcessingFeedback(
      {
        kind: "wrong_merge",
        explanation: "说明",
        suggestion: "请人工审阅",
        target: { kind: "entry", inputSeq: 12, expectedDecisionId: "decision-12" },
      },
      new AbortController().signal,
    )
    expect(fetcher).toHaveBeenCalledWith(
      "/information/v1/feedback",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          kind: "wrong_merge",
          explanation: "说明",
          suggestion: "请人工审阅",
          target: { kind: "entry", inputSeq: 12, expectedDecisionId: "decision-12" },
        }),
      }),
    )
  })

  it("将过期目标的 400 响应归类为 conflict，交给界面提示刷新", async () => {
    vi.mocked(oneTimeToken.generate).mockResolvedValue({ data: { token: "once" } } as Awaited<
      ReturnType<typeof oneTimeToken.generate>
    >)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "stale_target" }), { status: 400 })),
    )
    await expect(
      saveProcessingFeedback(
        { kind: "should_keep", target: { kind: "entry", inputSeq: 12, expectedDecisionId: null } },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ kind: "conflict" })
    await expect(
      saveProcessingFeedback(
        { kind: "should_keep", target: { kind: "entry", inputSeq: 12, expectedDecisionId: null } },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(FeedbackRequestError)
  })
})
