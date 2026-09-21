import { afterEach, describe, expect, it, vi } from "vitest"

import { oneTimeToken } from "~/lib/auth"

import {
  loadProcessingEntryRoles,
  processingEntryRolesResponseSchema,
  toServiceProcessingRoles,
} from "./processing-role-client"

vi.mock("~/lib/auth", () => ({ oneTimeToken: { generate: vi.fn() } }))

const roles = [
  {
    itemId: "entry-a",
    inputSeq: 2,
    kind: "merged" as const,
    reason: "同事件综述",
    relatedEntryIds: ["entry-b"],
    storyId: "story-1",
    storyTitle: "同事件综述",
  },
  {
    itemId: "entry-c",
    inputSeq: 3,
    kind: "hidden" as const,
    reason: "娱乐内容",
    relatedEntryIds: [],
    storyId: null,
    storyTitle: null,
  },
]

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe("processing role client", () => {
  it("严格校验角色投影，拒绝未声明字段与本地角色类型", () => {
    expect(processingEntryRolesResponseSchema.safeParse({ roles }).success).toBe(true)
    expect(
      processingEntryRolesResponseSchema.safeParse({ roles: [{ ...roles[0], unexpected: true }] })
        .success,
    ).toBe(false)
    // keeper 只属于本地去重，服务端不该产生它。
    expect(
      processingEntryRolesResponseSchema.safeParse({ roles: [{ ...roles[0], kind: "keeper" }] })
        .success,
    ).toBe(false)
  })

  it("把 itemId 搬运成角色层的 entryId，并丢掉空的综述身份", () => {
    expect(toServiceProcessingRoles(roles)).toEqual([
      {
        entryId: "entry-a",
        kind: "merged",
        reason: "同事件综述",
        relatedEntryIds: ["entry-b"],
        storyId: "story-1",
        storyTitle: "同事件综述",
      },
      {
        entryId: "entry-c",
        kind: "hidden",
        reason: "娱乐内容",
        relatedEntryIds: [],
      },
    ])
  })

  it("从处理服务读取角色投影，不把本地去重结果混进来", async () => {
    vi.mocked(oneTimeToken.generate).mockResolvedValue({ data: { token: "once" } } as Awaited<
      ReturnType<typeof oneTimeToken.generate>
    >)
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ roles })),
    )
    vi.stubGlobal("fetch", fetcher)

    await expect(loadProcessingEntryRoles(new AbortController().signal)).resolves.toEqual({ roles })
    expect(fetcher.mock.calls[0]?.[0]).toBe("/information/v1/processing/roles")
    // 只读请求走空体 POST + 读取标记，服务端据此才走 GET 分支。
    const init = fetcher.mock.calls[0]?.[1]
    expect(init).toEqual(expect.objectContaining({ method: "POST" }))
    expect(init?.body).toBeUndefined()
    expect(new Headers(init?.headers).get("X-Folo-Read")).toBe("1")
  })
})
