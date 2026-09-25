import {
  entryProcessingRoleActions,
  resolveEntryProcessingRole,
} from "@follow/store/entry/processing-role"
import { afterEach, describe, expect, it, vi } from "vitest"

import { oneTimeToken } from "~/lib/auth"

import {
  loadProcessingEntryRoles,
  processingEntryRolesResponseSchema,
  refreshServiceProcessingRoles,
  syncServiceProcessingRoles,
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
  entryProcessingRoleActions.clearServiceRoles()
})

// 请求要等一次性令牌的 promise 落地之后才发出，断言前先把微任务跑完。
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("processing role client", () => {
  it("严格校验角色投影，拒绝未声明字段与非法角色类型", () => {
    expect(processingEntryRolesResponseSchema.safeParse({ roles }).success).toBe(true)
    expect(
      processingEntryRolesResponseSchema.safeParse({ roles: [{ ...roles[0], unexpected: true }] })
        .success,
    ).toBe(false)
    // 服务端的语义去重同样会产出 keeper：它保留了内容，角标列出被并入的条目。
    expect(
      processingEntryRolesResponseSchema.safeParse({ roles: [{ ...roles[0], kind: "keeper" }] })
        .success,
    ).toBe(true)
    expect(
      processingEntryRolesResponseSchema.safeParse({ roles: [{ ...roles[0], kind: "unknown" }] })
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
        // inputSeq 一并搬运：时间线靠它按需取处理理由（命中规则），不另建映射表。
        inputSeq: 2,
        storyId: "story-1",
        storyTitle: "同事件综述",
      },
      {
        entryId: "entry-c",
        kind: "hidden",
        reason: "娱乐内容",
        relatedEntryIds: [],
        inputSeq: 3,
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

  it("同一时刻只发一次角色请求，并发的调用复用同一个在途结果", async () => {
    vi.mocked(oneTimeToken.generate).mockResolvedValue({ data: { token: "once" } } as Awaited<
      ReturnType<typeof oneTimeToken.generate>
    >)
    let settle: (response: Response) => void = () => {}
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          settle = resolve
        }),
    )
    vi.stubGlobal("fetch", fetcher)

    const first = syncServiceProcessingRoles()
    const second = syncServiceProcessingRoles()
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(1)

    settle(new Response(JSON.stringify({ roles })))
    await Promise.all([first, second])
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(resolveEntryProcessingRole("entry-c")?.kind).toBe("hidden")
  })

  it("覆盖写入后的强制刷新不会被在途轮询吞掉，界面拿到的是写入后的角色", async () => {
    vi.mocked(oneTimeToken.generate).mockResolvedValue({ data: { token: "once" } } as Awaited<
      ReturnType<typeof oneTimeToken.generate>
    >)
    const pending: Array<(response: Response) => void> = []
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          pending.push(resolve)
        }),
    )
    vi.stubGlobal("fetch", fetcher)

    // 模拟一次轮询正在途中（它的响应是「恢复」写入之前发起的，内容已过期）。
    const polling = syncServiceProcessingRoles()
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(1)

    const forced = refreshServiceProcessingRoles()
    await flush()
    // 强制刷新必须等在途那次收尾，不能直接复用它的结果，也不能另起一次并发请求。
    expect(fetcher).toHaveBeenCalledTimes(1)

    pending[0]!(new Response(JSON.stringify({ roles })))
    await polling
    // 等旧请求结束后，才发起一次全新的读取。
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))

    pending[1]!(
      new Response(
        JSON.stringify({
          roles: [
            {
              itemId: "entry-c",
              inputSeq: 3,
              kind: "restored",
              reason: null,
              relatedEntryIds: [],
              storyId: null,
              storyTitle: null,
            },
          ],
        }),
      ),
    )
    await forced
    expect(fetcher).toHaveBeenCalledTimes(2)
    // 旧响应里的 hidden 已经被写入后的 restored 覆盖，用户点完立刻能看到结果。
    expect(resolveEntryProcessingRole("entry-c")?.kind).toBe("restored")
  })
})
