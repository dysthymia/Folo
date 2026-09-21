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
