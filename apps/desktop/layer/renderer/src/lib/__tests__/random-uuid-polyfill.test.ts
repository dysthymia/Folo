import { describe, expect, it } from "vitest"

import {
  installRandomUuidPolyfill,
  randomUuidFromRandomValues,
  uuidV4Pattern,
} from "../random-uuid-polyfill"

describe("crypto.randomUUID 兜底", () => {
  it("用 getRandomValues 生成合法的 v4 UUID 且不重复", () => {
    // 测试环境自带原生 randomUUID，这里直接验证兜底实现本身。
    for (let index = 0; index < 20; index += 1)
      expect(randomUuidFromRandomValues()).toMatch(uuidV4Pattern)

    const generated = new Set(Array.from({ length: 50 }, () => randomUuidFromRandomValues()))
    expect(generated.size).toBe(50)
  })

  it("原生实现缺失时补上，存在时不覆盖", () => {
    const native = crypto.randomUUID
    const descriptor = Object.getOwnPropertyDescriptor(crypto, "randomUUID")
    try {
      Object.defineProperty(crypto, "randomUUID", { configurable: true, value: undefined })
      expect(typeof crypto.randomUUID).toBe("undefined")

      installRandomUuidPolyfill()
      expect(crypto.randomUUID()).toMatch(uuidV4Pattern)
    } finally {
      if (descriptor) Object.defineProperty(crypto, "randomUUID", descriptor)
      else Reflect.deleteProperty(crypto, "randomUUID")
    }

    // 已存在原生实现时是空操作，引用不变。
    installRandomUuidPolyfill()
    expect(crypto.randomUUID).toBe(native)
  })
})
