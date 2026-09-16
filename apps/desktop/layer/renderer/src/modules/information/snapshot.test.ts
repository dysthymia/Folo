import { describe, expect, it } from "vitest"

import { getInformationArticleUrl, informationSnapshotSchema } from "./snapshot"

// 覆盖外部数据的安全边界；界面状态由浏览器验证。
describe("information snapshot", () => {
  it("accepts a real empty snapshot without inventing results", () => {
    expect(
      informationSnapshotSchema.parse({
        ownerId: null,
        sources: [],
        items: [],
        jobs: [],
        results: [],
      }).results,
    ).toEqual([])
  })

  it("rejects a malformed snapshot", () => {
    expect(informationSnapshotSchema.safeParse({ ownerId: "owner", results: [] }).success).toBe(
      false,
    )
  })

  it("keeps X search as its own source kind", () => {
    const result = informationSnapshotSchema.safeParse({
      ownerId: "owner",
      sources: [
        {
          key: "x/search/example",
          kind: "x_search",
          id: "example",
          title: "X search",
          view: 0,
          category: null,
        },
      ],
      items: [],
      jobs: [],
      results: [],
    })
    expect(result.success).toBe(true)
  })

  it.each(["javascript:alert(1)", "data:text/html,test", "file:///tmp/test", "/relative", null])(
    "rejects non-web article links: %s",
    (url) => expect(getInformationArticleUrl(url)).toBeNull(),
  )

  it.each(["https://example.com/article", "http://example.com/article"])(
    "allows absolute web article links: %s",
    (url) => expect(getInformationArticleUrl(url)).toBe(url),
  )
})
