import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"

import { join } from "pathe"
import { afterEach, describe, expect, it, vi } from "vitest"

import { Store } from "./store"
import { createWebAuthenticator } from "./web-auth"

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})
async function fixture(owner = "owner", initialized = true) {
  const directory = await mkdtemp(join(tmpdir(), "folo-web-auth-"))
  directories.push(directory)
  const store = new Store(":memory:")
  if (initialized) store.bindOwner("owner")
  if (initialized)
    store.replaceSources([
      { key: "feed/1", kind: "feed", id: "1", title: "Feed", view: 0, category: null },
    ])
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, options) => {
    const url = String(input)
    if (url.endsWith("/one-time-token/apply")) {
      expect(options?.redirect).toBe("error")
      return Response.json({ session: { token: "verified-session" } })
    }
    if (url.endsWith("/get-session"))
      return Response.json({
        user: { id: owner },
        session: { userId: owner, expiresAt: "2099-01-01T00:00:00Z" },
      })
    if (new URL(url).pathname === "/subscriptions") return Response.json({ code: 0, data: [] })
    throw new Error("Unexpected request")
  })
  const path = join(directory, "web-credential.json")
  return { store, path, fetcher, authenticate: createWebAuthenticator(store, path, fetcher) }
}

describe("主站授权交换", () => {
  it("新后台首次打开即可使用主站账号，无需 CLI 初始化", async () => {
    const { store, path, authenticate } = await fixture("owner", false)
    await authenticate("one-time")
    expect(store.ownerId).toBe("owner")
    expect(store.sources()).toEqual([])
    expect(JSON.parse(await readFile(path, "utf8")).token).toBe("verified-session")
    store.close()
  })

  it("使用官方核验后的凭据，按 0600 保存后台认证", async () => {
    const { store, path, fetcher, authenticate } = await fixture()
    await authenticate("one-time")
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      apiUrl: "https://api.folo.is",
      token: "verified-session",
    })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    store.close()
  })
  it("其他账号不能覆盖凭据或读取旧账号数据", async () => {
    const { store, path, authenticate } = await fixture("other-owner")
    await expect(authenticate("one-time")).rejects.toMatchObject({
      status: 403,
      code: "account_mismatch",
    })
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" })
    expect(store.ownerId).toBe("owner")
    store.close()
  })
  it("凭据重放或过期明确报未登录，不保存无效授权", async () => {
    const { store, path, fetcher, authenticate } = await fixture()
    fetcher.mockResolvedValueOnce(
      Response.json({ message: "private-token-value" }, { status: 401 }),
    )
    await expect(authenticate("expired")).rejects.toMatchObject({
      status: 401,
      code: "authorization",
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" })
    store.close()
  })
  it("交换成功但官方会话已失效仍拒绝访问", async () => {
    const { store, path, fetcher, authenticate } = await fixture()
    fetcher
      .mockResolvedValueOnce(Response.json({ session: { token: "expired" } }))
      .mockResolvedValueOnce(Response.json(null))
    await expect(authenticate("one-time")).rejects.toMatchObject({ status: 401 })
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" })
    store.close()
  })
})
