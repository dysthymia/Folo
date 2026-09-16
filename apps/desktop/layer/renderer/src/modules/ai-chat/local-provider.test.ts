import { describe, expect, it, vi } from "vitest"

import {
  getOneTimeTokenFromResult,
  isLocalFoloHost,
  requestLocalAISettings,
} from "./local-provider"

vi.mock("~/lib/auth", () => ({
  oneTimeToken: { generate: vi.fn() },
}))

describe("本地 AI Provider", () => {
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
