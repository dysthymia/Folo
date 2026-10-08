import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

type OwnerState = { whoami: { id: string } | null }
const identity = vi.hoisted(() => ({
  owner: "owner-1" as string | null,
  listeners: [] as Array<(next: OwnerState, previous: OwnerState) => void>,
}))
vi.mock("@follow/store/user/getters", () => ({
  whoami: () => (identity.owner ? { id: identity.owner } : null),
}))
vi.mock("@follow/store/user/store", () => ({
  useUserStore: {
    subscribe: (listener: (next: OwnerState, previous: OwnerState) => void) => {
      identity.listeners.push(listener)
      return () => {}
    },
  },
}))

const token = "a".repeat(64)
const session = (ownerId = "owner-1", value = token) =>
  Response.json({ ownerId, token: value, expiresAt: Date.now() + 300_000 })
const signal = () => new AbortController().signal
function changeOwner(owner: string | null) {
  const previous = { whoami: identity.owner ? { id: identity.owner } : null }
  identity.owner = owner
  for (const listener of identity.listeners)
    listener({ whoami: owner ? { id: owner } : null }, previous)
}
beforeEach(() => {
  vi.resetModules()
  identity.owner = "owner-1"
  identity.listeners = []
  vi.stubGlobal("window", { location: new URL("http://local.folo.is") })
  document.documentElement.removeAttribute("data-information-page")
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute("data-information-page")
})

describe("本地读取短时会话", () => {
  it("并发读取共享一次 bootstrap，数据请求只发送本地 token", async () => {
    const { tryLocalInformationRead } = await import("./local-read-access")
    const fetcher = vi.fn(async (input: string, _init: RequestInit) =>
      input.endsWith("local-read-session") ? session() : Response.json({ ok: true }),
    )
    await Promise.all([
      tryLocalInformationRead("runs", "GET", signal(), undefined, fetcher),
      tryLocalInformationRead("inputs", "GET", signal(), undefined, fetcher),
    ])
    expect(
      fetcher.mock.calls.filter(([input]) => input.endsWith("local-read-session")),
    ).toHaveLength(1)
    expect(JSON.parse(fetcher.mock.calls[0]![1].body as string)).toEqual({ ownerId: "owner-1" })
    for (const [, init] of fetcher.mock.calls.slice(1)) {
      const headers = new Headers(init.headers)
      expect(headers.get("X-Folo-Local-Read-Token")).toBe(token)
      expect(headers.has("X-Folo-One-Time-Token")).toBe(false)
      expect(headers.get("X-Folo-Read")).toBe("1")
      expect(init.method).toBe("POST")
      expect(init.body).toBeUndefined()
    }
  })

  it("查询 POST 保留 body，写操作和非本机界面交还原调用者", async () => {
    const { tryLocalInformationRead } = await import("./local-read-access")
    const fetcher = vi.fn(async (input: string, _init: RequestInit) =>
      input.endsWith("local-read-session") ? session() : Response.json({ ok: true }),
    )
    const body = { inputSeqs: [1, 2] }
    await tryLocalInformationRead("processing/semantics/query", "POST", signal(), body, fetcher)
    expect(fetcher.mock.calls[1]![1].body).toBe(JSON.stringify(body))
    expect(new Headers(fetcher.mock.calls[1]![1].headers).has("X-Folo-Read")).toBe(false)
    expect(await tryLocalInformationRead("schedule", "PUT", signal(), {}, fetcher)).toBeNull()
    vi.stubGlobal("window", { location: new URL("https://app.folo.is") })
    expect(await tryLocalInformationRead("runs", "GET", signal(), undefined, fetcher)).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it("独立本机工作台用已绑定工作区且不加载主站身份", async () => {
    vi.stubGlobal("window", { location: new URL("http://localhost:3000") })
    document.documentElement.setAttribute("data-information-page", "")
    identity.owner = null
    const { tryLocalInformationRead } = await import("./local-read-access")
    const fetcher = vi.fn(async (input: string, _init: RequestInit) =>
      input.endsWith("local-read-session") ? session() : Response.json({ ok: true }),
    )
    await tryLocalInformationRead("/information/api/settings", "GET", signal(), undefined, fetcher)
    expect(fetcher.mock.calls[0]![1].body).toBe(JSON.stringify({ ownerId: null }))
    expect(identity.listeners).toHaveLength(0)
  })

  it("localhost 上的普通主站界面不启用本地授权", async () => {
    vi.stubGlobal("window", { location: new URL("http://localhost:5173") })
    const { tryLocalInformationRead } = await import("./local-read-access")
    const fetcher = vi.fn()
    expect(await tryLocalInformationRead("runs", "GET", signal(), undefined, fetcher)).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("换号及注销再登录会重新获取 token，注销期间禁止读取", async () => {
    const { tryLocalInformationRead } = await import("./local-read-access")
    const fetcher = vi.fn(async (input: string, _init: RequestInit) =>
      input.endsWith("local-read-session") ? session(identity.owner!) : Response.json({ ok: true }),
    )
    await tryLocalInformationRead("runs", "GET", signal(), undefined, fetcher)
    changeOwner("owner-2")
    await tryLocalInformationRead("runs", "GET", signal(), undefined, fetcher)
    changeOwner(null)
    await expect(
      tryLocalInformationRead("runs", "GET", signal(), undefined, fetcher),
    ).rejects.toMatchObject({ kind: "authorization" })
    changeOwner("owner-2")
    await tryLocalInformationRead("runs", "GET", signal(), undefined, fetcher)
    expect(
      fetcher.mock.calls.filter(([input]) => input.endsWith("local-read-session")),
    ).toHaveLength(3)
  })

  it("返回数据前核验账号，换号中的旧请求不能泄露结果", async () => {
    const { tryLocalInformationRead } = await import("./local-read-access")
    const fetcher = vi.fn(async (input: string, _init: RequestInit) => {
      if (input.endsWith("local-read-session")) return session()
      changeOwner("owner-2")
      return Response.json({ secret: "owner-1" })
    })
    await expect(
      tryLocalInformationRead("runs", "GET", signal(), undefined, fetcher),
    ).rejects.toMatchObject({ kind: "account_mismatch" })
  })

  it.each(["bootstrap", "data"])("%s 返回401只重获一次，不循环或回退官方", async (stage) => {
    const { tryLocalInformationRead } = await import("./local-read-access")
    const fetcher = vi.fn(async (input: string, _init: RequestInit) => {
      if (input.endsWith("local-read-session"))
        return stage === "bootstrap" ? new Response(null, { status: 401 }) : session()
      return new Response(null, { status: 401 })
    })
    if (stage === "bootstrap")
      await expect(
        tryLocalInformationRead("runs", "GET", signal(), undefined, fetcher),
      ).rejects.toMatchObject({ kind: "authorization" })
    else
      expect(
        (await tryLocalInformationRead("runs", "GET", signal(), undefined, fetcher))?.status,
      ).toBe(401)
    expect(
      fetcher.mock.calls.filter(([input]) => input.endsWith("local-read-session")),
    ).toHaveLength(2)
    expect(fetcher).toHaveBeenCalledTimes(stage === "bootstrap" ? 2 : 4)
  })

  it("服务重启后首次401可以恢复读取", async () => {
    const { tryLocalInformationRead } = await import("./local-read-access")
    const fetcher = vi
      .fn<(input: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(session())
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(session("owner-1", "b".repeat(64)))
      .mockResolvedValueOnce(Response.json({ ok: true }))
    expect((await tryLocalInformationRead("runs", "GET", signal(), undefined, fetcher))?.ok).toBe(
      true,
    )
    expect(new Headers(fetcher.mock.calls[3]![1].headers).get("X-Folo-Local-Read-Token")).toBe(
      "b".repeat(64),
    )
  })

  it.each(["bootstrap", "data"])("%s 返回403立即拒绝，不重试", async (stage) => {
    const { tryLocalInformationRead } = await import("./local-read-access")
    const fetcher = vi.fn(async (input: string, _init: RequestInit) =>
      stage === "data" && input.endsWith("local-read-session")
        ? session()
        : new Response(null, { status: 403 }),
    )
    await expect(
      tryLocalInformationRead("runs", "GET", signal(), undefined, fetcher),
    ).rejects.toMatchObject({ kind: "account_mismatch" })
    expect(fetcher).toHaveBeenCalledTimes(stage === "bootstrap" ? 1 : 2)
  })
})
