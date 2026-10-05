import { describe, expect, it, vi } from "vitest"

import {
  loadGeneratedSourcePreferences,
  saveGeneratedSourcePreferences,
} from "./generated-source-preferences"

describe("私人生成来源本地偏好", () => {
  it("隐藏和分组按账号隔离，只写本地阅读偏好", () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value)
      },
    }
    expect(
      saveGeneratedSourcePreferences(
        "owner-1",
        { visible: false, group: "X", collapsed: true },
        storage,
      ),
    ).toBe(true)
    expect(loadGeneratedSourcePreferences("owner-1", storage)).toEqual({
      visible: false,
      group: "X",
      collapsed: true,
    })
    expect(loadGeneratedSourcePreferences("owner-2", storage)).toEqual({
      visible: true,
      group: "",
      collapsed: false,
    })
    expect(values.size).toBe(1)
  })
  it("无效或不可用存储保留安全默认值并报告保存失败", () => {
    expect(
      loadGeneratedSourcePreferences("owner", {
        getItem: () => '{"visible":false,"fakeFeedId":"generated:events"}',
      }),
    ).toEqual({ visible: true, group: "", collapsed: false })
    expect(loadGeneratedSourcePreferences("owner", { getItem: () => "not-json" })).toEqual({
      visible: true,
      group: "",
      collapsed: false,
    })
    const write = vi.fn(() => {
      throw new Error("storage blocked")
    })
    expect(
      saveGeneratedSourcePreferences(
        "owner",
        { visible: false, group: "", collapsed: false },
        { setItem: write },
      ),
    ).toBe(false)
  })
})
