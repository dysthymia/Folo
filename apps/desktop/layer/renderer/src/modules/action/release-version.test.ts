import { describe, expect, it } from "vitest"

import { resolveLiveReleaseVersion } from "./release-version"

describe("resolveLiveReleaseVersion", () => {
  it("刚发布的那一版必须压过历史列表——editor.releases 在本次会话里是过期的", () => {
    // 实测形态：页面加载时读到 v1/v2/v3，本轮保存并启用产出 v4。
    expect(
      resolveLiveReleaseVersion([{ version: 1 }, { version: 2 }, { version: 3 }], { version: 4 }),
    ).toBe(4)
  })

  it("刷新后 release 为空时回落到历史列表", () => {
    expect(resolveLiveReleaseVersion([{ version: 1 }, { version: 2 }], null)).toBe(2)
    expect(resolveLiveReleaseVersion([{ version: 3 }, { version: 5 }], null)).toBe(5)
  })

  it("两者都没有时不显示版本提示", () => {
    expect(resolveLiveReleaseVersion([], null)).toBeNull()
  })

  it("刚发布的版本低于历史最大值时仍取最大值（不因本次发布更旧而回退提示）", () => {
    expect(resolveLiveReleaseVersion([{ version: 7 }], { version: 6 })).toBe(7)
  })
})
