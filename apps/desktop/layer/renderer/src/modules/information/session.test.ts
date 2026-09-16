import { describe, expect, it, vi } from "vitest"

import type { InformationFetcher } from "./session"
import {
  loadInformationAISettings,
  loadInformationSnapshot,
  saveInformationAISettings,
} from "./session"

const snapshot = { ownerId: "owner", sources: [], items: [], jobs: [], results: [] }
describe("信息工作台复用主站登录", () => {
  it("先取一次性凭据，再以同源 POST 读取结果", async () => {
    const fetcher = vi.fn<InformationFetcher>().mockResolvedValue(Response.json(snapshot))
    const result = await loadInformationSnapshot(
      async () => ({ data: { token: "one-time" } }),
      new AbortController().signal,
      fetcher,
    )
    expect(result).toEqual(snapshot)
    expect(fetcher).toHaveBeenCalledWith(
      "/information/api/snapshot",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        headers: { "X-Folo-One-Time-Token": "one-time" },
      }),
    )
  })
  it("主站未登录时不访问后台快照", async () => {
    const fetcher = vi.fn<InformationFetcher>()
    await expect(
      loadInformationSnapshot(
        async () => ({ error: { status: 401 } }),
        new AbortController().signal,
        fetcher,
      ),
    ).rejects.toMatchObject({ kind: "authorization" })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it.each([
    [401, "authorization"],
    [403, "account_mismatch"],
    [502, "request"],
  ] as const)("正确呈现后台 %s 状态", async (status, kind) => {
    const fetcher = vi
      .fn<InformationFetcher>()
      .mockResolvedValue(Response.json({ error: "account_mismatch" }, { status }))
    await expect(
      loadInformationSnapshot(
        async () => ({ token: "one-time" }),
        new AbortController().signal,
        fetcher,
      ),
    ).rejects.toMatchObject({ kind })
  })
  it("旧页面请求取消后不交换凭据", async () => {
    const controller = new AbortController()
    const fetcher = vi.fn<InformationFetcher>()
    controller.abort()
    await expect(
      loadInformationSnapshot(async () => ({ token: "one-time" }), controller.signal, fetcher),
    ).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("登录校验后同源读取模型设置", async () => {
    const fetcher = vi
      .fn<InformationFetcher>()
      .mockResolvedValue(
        Response.json({ provider: "qianwen", model: "qwen3.8-flash", hasApiKey: true }),
      )
    await expect(
      loadInformationAISettings(
        async () => ({ token: "one-time" }),
        new AbortController().signal,
        fetcher,
      ),
    ).resolves.toMatchObject({ provider: "qianwen", model: "qwen3.8-flash", hasApiKey: true })
    expect(fetcher).toHaveBeenCalledWith(
      "/information/api/settings",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        headers: { "X-Folo-One-Time-Token": "one-time" },
      }),
    )
  })

  it("保存时只把本次输入的密钥发送给后台", async () => {
    const fetcher = vi
      .fn<InformationFetcher>()
      .mockResolvedValue(
        Response.json({ provider: "codex", model: "qwen3.8-flash", hasApiKey: true }),
      )
    await saveInformationAISettings(
      { provider: "codex", model: "qwen3.8-flash", apiKey: "temporary-key" },
      async () => ({ data: { token: "one-time" } }),
      fetcher,
    )
    expect(fetcher).toHaveBeenCalledWith(
      "/information/api/settings",
      expect.objectContaining({
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Folo-One-Time-Token": "one-time",
        },
        body: JSON.stringify({
          provider: "codex",
          model: "qwen3.8-flash",
          apiKey: "temporary-key",
        }),
      }),
    )
  })
})
