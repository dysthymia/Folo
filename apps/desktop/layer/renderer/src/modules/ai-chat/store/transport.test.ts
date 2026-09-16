import { describe, expect, it, vi } from "vitest"

import { normalizeLocalMessageMetadata } from "./transport"

vi.mock("~/lib/auth", () => ({
  oneTimeToken: { generate: vi.fn() },
}))

describe("本地聊天 SSE metadata", () => {
  it("将后台 model 映射为现有消息组件的 modelUsed", () => {
    expect(normalizeLocalMessageMetadata({ model: "qwen3.8-flash" })).toEqual({
      model: "qwen3.8-flash",
      modelUsed: "qwen3.8-flash",
    })
  })

  it("保留后台已提供的 modelUsed 与非对象 metadata", () => {
    expect(normalizeLocalMessageMetadata({ model: "qwen", modelUsed: "custom" })).toEqual({
      model: "qwen",
      modelUsed: "custom",
    })
    expect(normalizeLocalMessageMetadata(undefined)).toBeUndefined()
  })
})
