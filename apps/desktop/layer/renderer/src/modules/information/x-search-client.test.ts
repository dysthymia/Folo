import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { oneTimeToken } from "~/lib/auth"

import {
  createXQuery,
  deleteXQuery,
  loadX,
  syncX,
  updateXQuery,
  xQueriesSchema,
} from "./x-search-client"

vi.mock("~/lib/auth", () => ({ oneTimeToken: { generate: vi.fn() } }))

const id = "11111111-1111-4111-8111-111111111111"
const now = "2026-09-12T00:00:00.000Z"
const query = {
  id,
  sourceKey: `x/search/${id}`,
  query: "from:follow_app",
  title: "Folo posts",
  view: 3,
  category: "Product",
  enabled: true,
  createdAt: now,
  updatedAt: now,
}
const state = {
  queryId: id,
  nextToken: null,
  scanSinceId: null,
  candidateHighWaterId: null,
  highWaterId: null,
  pending: false,
  status: "idle" as const,
  failure: null,
  retryAt: null,
  updatedAt: now,
}

beforeEach(() => {
  vi.mocked(oneTimeToken.generate).mockResolvedValue({ data: { token: "once" } } as Awaited<
    ReturnType<typeof oneTimeToken.generate>
  >)
})

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe("x search client", () => {
  it("严格拒绝查询和状态中的未知字段", () => {
    const payload = { queries: [{ ...query, state }], sources: [] }
    expect(xQueriesSchema.safeParse(payload).success).toBe(true)
    expect(
      xQueriesSchema.safeParse({
        ...payload,
        queries: [{ ...query, state: { ...state, secret: "should-not-pass" } }],
      }).success,
    ).toBe(false)
  })

  it("读取设置和查询时每个同域请求都使用新的主站一次性令牌", async () => {
    vi.mocked(oneTimeToken.generate)
      .mockResolvedValueOnce({ data: { token: "once-1" } } as Awaited<
        ReturnType<typeof oneTimeToken.generate>
      >)
      .mockResolvedValueOnce({ data: { token: "once-2" } } as Awaited<
        ReturnType<typeof oneTimeToken.generate>
      >)
    const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
      String(input).endsWith("/settings")
        ? new Response(
            JSON.stringify({
              enabled: false,
              configured: false,
              access: "recent_search",
              billingNotice: "notice",
            }),
          )
        : new Response(JSON.stringify({ queries: [], sources: [] })),
    )
    vi.stubGlobal("fetch", fetcher)

    await loadX(new AbortController().signal)

    expect(oneTimeToken.generate).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[0]?.[0]).toBe("/information/v1/x/settings")
    expect(fetcher.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ method: "POST", credentials: "same-origin" }),
    )
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("X-Folo-One-Time-Token")).toBe(
      "once-1",
    )
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("X-Folo-Read")).toBe("1")
    expect(fetcher.mock.calls[1]?.[0]).toBe("/information/v1/x/queries")
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("X-Folo-One-Time-Token")).toBe(
      "once-2",
    )
  })

  it("创建、编辑和删除发送精确路径与请求体", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(JSON.stringify({ deleted: true }))
      return new Response(JSON.stringify(query))
    })
    vi.stubGlobal("fetch", fetcher)
    const input = {
      query: query.query,
      title: query.title,
      view: query.view,
      category: query.category,
      enabled: query.enabled,
    }

    await createXQuery(input, new AbortController().signal)
    await updateXQuery(id, { ...input, title: "Edited" }, new AbortController().signal)
    await deleteXQuery(id, new AbortController().signal)

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "/information/v1/x/queries",
      expect.objectContaining({ method: "POST", body: JSON.stringify(input) }),
    )
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      `/information/v1/x/queries/${id}`,
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ ...input, title: "Edited" }),
      }),
    )
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      `/information/v1/x/queries/${id}`,
      expect.objectContaining({ method: "DELETE" }),
    )
  })

  it("手动同步只发送服务端允许的严格空对象", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ results: [] })))
    vi.stubGlobal("fetch", fetcher)

    await syncX(new AbortController().signal)

    expect(fetcher).toHaveBeenCalledWith(
      "/information/v1/x/sync",
      expect.objectContaining({ method: "POST", body: "{}" }),
    )
  })

  it("手动同步只向固定端点发送严格空对象", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ results: [] })))
    vi.stubGlobal("fetch", fetcher)

    await syncX(new AbortController().signal)

    expect(fetcher).toHaveBeenCalledWith(
      "/information/v1/x/sync",
      expect.objectContaining({ method: "POST", body: "{}" }),
    )
  })
})
