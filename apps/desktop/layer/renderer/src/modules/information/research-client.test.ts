import { afterEach, describe, expect, it, vi } from "vitest"

import { oneTimeToken } from "~/lib/auth"

import {
  loadResearchPacks,
  prepareResearchPack,
  researchPackSchema,
  transitionResearchPack,
} from "./research-client"

vi.mock("~/lib/auth", () => ({ oneTimeToken: { generate: vi.fn() } }))

const pack = {
  id: "11111111-1111-4111-8111-111111111111",
  revision: 1,
  status: "prepared" as const,
  target: { kind: "entry" as const, inputSeq: 7 },
  question: "需要核查什么？",
  goal: "核对原始材料",
  knownQuestions: ["日期是否一致？"],
  title: "研究文件",
  markdown: "# 研究文件",
  createdAt: "2026-09-12T00:00:00.000Z",
  updatedAt: "2026-09-12T00:00:00.000Z",
  submissionReference: null,
  resultReference: null,
}

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe("research client", () => {
  it("严格校验研究文件，并拒绝未知字段", () => {
    expect(researchPackSchema.safeParse(pack).success).toBe(true)
    expect(researchPackSchema.safeParse({ ...pack, secret: "不要进入客户端" }).success).toBe(false)
  })

  it("使用当前一次性令牌提交研究目标，不自动调用外部研究", async () => {
    vi.mocked(oneTimeToken.generate).mockResolvedValue({ data: { token: "once" } } as Awaited<
      ReturnType<typeof oneTimeToken.generate>
    >)
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ pack })),
    )
    vi.stubGlobal("fetch", fetcher)

    await prepareResearchPack(
      {
        target: { kind: "entry", inputSeq: 7 },
        question: pack.question,
        goal: pack.goal,
        knownQuestions: pack.knownQuestions,
      },
      new AbortController().signal,
    )

    expect(fetcher).toHaveBeenCalledWith(
      "/information/v1/research-packs",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          target: { kind: "entry", inputSeq: 7 },
          question: pack.question,
          goal: pack.goal,
          knownQuestions: pack.knownQuestions,
        }),
      }),
    )
  })

  it("支持列表读取和带 revision 的手动交接更新", async () => {
    vi.mocked(oneTimeToken.generate).mockResolvedValue({ data: { token: "once" } } as Awaited<
      ReturnType<typeof oneTimeToken.generate>
    >)
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ packs: [pack] })),
    )
    vi.stubGlobal("fetch", fetcher)
    await loadResearchPacks(new AbortController().signal)
    expect(fetcher).toHaveBeenCalledWith(
      "/information/v1/research-packs",
      expect.objectContaining({ method: "POST" }),
    )
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("X-Folo-Read")).toBe("1")

    fetcher.mockResolvedValueOnce(
      new Response(JSON.stringify({ pack: { ...pack, revision: 2, status: "submitted" } })),
    )
    await transitionResearchPack(
      pack.id,
      { expectedRevision: 1, status: "submitted", reference: "任务 A" },
      new AbortController().signal,
    )
    expect(fetcher).toHaveBeenLastCalledWith(
      `/information/v1/research-packs/${pack.id}`,
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ expectedRevision: 1, status: "submitted", reference: "任务 A" }),
      }),
    )
  })
})
