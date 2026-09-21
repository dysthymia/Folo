import { describe, expect, it } from "vitest"

import { originalReadingPath, smartReadingPath } from "./reading-mode-link"

describe("智能与原始阅读切换", () => {
  it("保留原时间线且新入口仍在同域", () => {
    const path = "/timeline/view-1/123/pending?sortBy=publishedAt"
    const target = smartReadingPath(path)
    expect(target.startsWith("/information?")).toBe(true)
    expect(
      originalReadingPath(new URL(target, "http://local.folo.is").searchParams.get("returnTo")),
    ).toBe(path)
  })
  it("带上 storyId 时深链到那一篇综述", () => {
    const path = "/timeline/view-1/123/pending"
    const target = smartReadingPath(path, "11111111-1111-4111-8111-111111111111")
    expect(target).toBe(
      `/information?returnTo=${encodeURIComponent(path)}&storyId=11111111-1111-4111-8111-111111111111#smart-reading`,
    )
    expect(
      originalReadingPath(new URL(target, "http://local.folo.is").searchParams.get("returnTo")),
    ).toBe(path)
  })
  it.each([
    null,
    "https://example.com",
    "//example.com",
    "/information",
    "/timeline/../../evil",
    "/timeline/foo\\evil",
  ])("拒绝非法返回路径 %s", (value) => {
    expect(originalReadingPath(value)).toBe("/timeline/view-0/all/pending")
  })
})
