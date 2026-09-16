import { afterEach, describe, expect, it, vi } from "vitest"

import { oneTimeToken } from "~/lib/auth"

import {
  exportsResponseSchema,
  loadIntegrationSettings,
  prepareExport,
} from "./information-integration-client"

vi.mock("~/lib/auth", () => ({ oneTimeToken: { generate: vi.fn() } }))

const exportView = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "story" as const,
  storyId: "22222222-2222-4222-8222-222222222222",
  entry: null,
  revision: 2,
  destinationId: "33333333-3333-4333-8333-333333333333",
  contentHash: "hash",
  operation: "create" as const,
  status: "prepared" as const,
  notionPageId: null,
  retryAfter: null,
  error: null,
  createdAt: "2026-09-12T00:00:00.000Z",
  updatedAt: "2026-09-12T00:00:00.000Z",
}

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe("information integration client", () => {
  it("校验后端导出记录的 kind、operation 和 entry 字段", () => {
    const result = exportsResponseSchema.safeParse({
      exports: [exportView],
      integrations: { notion: { enabled: true, parentPageId: exportView.destinationId } },
    })
    expect(result.success).toBe(true)
    expect(
      exportsResponseSchema.safeParse({
        exports: [{ ...exportView, operation: "unexpected" }],
        integrations: { notion: { enabled: true, parentPageId: null } },
      }).success,
    ).toBe(false)
  })

  it("通过同域一次性令牌准备冻结 Story 预览", async () => {
    vi.mocked(oneTimeToken.generate).mockResolvedValue({ data: { token: "once" } } as Awaited<
      ReturnType<typeof oneTimeToken.generate>
    >)
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            export: exportView,
            preview: {
              storyId: exportView.storyId,
              revision: 2,
              title: "标题",
              markdown: "# 正文",
              references: [],
            },
          }),
        ),
    )
    vi.stubGlobal("fetch", fetcher)
    await prepareExport(exportView.storyId!, exportView.destinationId, new AbortController().signal)
    expect(fetcher).toHaveBeenCalledWith(
      "/information/v1/exports",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          storyId: exportView.storyId,
          destinationPageId: exportView.destinationId,
        }),
      }),
    )
  })

  it("设置响应不包含凭据字段", async () => {
    vi.mocked(oneTimeToken.generate).mockResolvedValue({ data: { token: "once" } } as Awaited<
      ReturnType<typeof oneTimeToken.generate>
    >)
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ integrations: { notion: { enabled: true, parentPageId: null } } }),
        ),
    )
    vi.stubGlobal("fetch", fetcher)
    const result = await loadIntegrationSettings(new AbortController().signal)
    expect(result.integrations.notion).not.toHaveProperty("token")
    const init = fetcher.mock.calls[0]?.[1]
    expect(init).toEqual(expect.objectContaining({ method: "POST" }))
    expect(init?.body).toBeUndefined()
    expect(new Headers(init?.headers).get("X-Folo-Read")).toBe("1")
  })
})
