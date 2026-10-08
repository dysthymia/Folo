import { afterEach, describe, expect, it, vi } from "vitest"

import {
  getOneTimeTokenFromResult,
  isLocalFoloHost,
  requestLocalAISettings,
} from "./local-provider"

vi.mock("~/lib/auth", () => ({
  oneTimeToken: { generate: vi.fn() },
}))

afterEach(() => {
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute("data-information-page")
})

describe("本地 AI Provider", () => {
  it("本机模型设置读取不生成官方凭据", async () => {
    vi.stubGlobal("window", { location: new URL("http://local.folo.is:3041") })
    document.documentElement.setAttribute("data-information-page", "")
    const generate = vi.fn()
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ ownerId: "owner", token: "d".repeat(64), expiresAt: Date.now() + 300_000 }),
      )
      .mockResolvedValueOnce(Response.json({ provider: "codex", model: "model", hasApiKey: false }))
    expect(await requestLocalAISettings(generate, fetcher)).toMatchObject({ model: "model" })
    expect(generate).not.toHaveBeenCalled()
    expect(new Headers(fetcher.mock.calls[1]![1]?.headers).has("X-Folo-One-Time-Token")).toBe(false)
  })
  it("自定义提供商继续使用本机对话配置，不因新增提供商丢失模型", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        provider: "openai-compatible",
        model: "custom-chat",
        baseUrl: "https://models.example.test/v1",
        hasApiKey: true,
      }),
    )
    expect(await requestLocalAISettings(async () => "one-time", fetcher)).toEqual({
      provider: "openai-compatible",
      model: "custom-chat",
      hasApiKey: true,
    })
  })
  it("只在 local.folo.is 启用", () => {
    expect(isLocalFoloHost("local.folo.is")).toBe(true)
    expect(isLocalFoloHost("app.folo.is")).toBe(false)
  })

  it.each([{ token: "token" }, { data: { token: "token" } }])("兼容主站一次性凭据", (result) => {
    expect(getOneTimeTokenFromResult(result)).toBe("token")
  })

  it("带一次性凭据读取后台模型设置", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ provider: "qianwen", model: "qwen3.8-flash", hasApiKey: true }),
      )

    await expect(requestLocalAISettings(async () => "one-time", fetcher)).resolves.toEqual({
      provider: "qianwen",
      model: "qwen3.8-flash",
      hasApiKey: true,
    })
    expect(fetcher).toHaveBeenCalledWith(
      "/information/api/settings",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        headers: { "X-Folo-One-Time-Token": "one-time" },
      }),
    )
  })
})
