import { describe, expect, it } from "vitest"

import { readReaderTarget, storyReaderLocation, validReaderDate } from "./reader-target"

describe("原生阅读目标身份", () => {
  it("普通原文从 canonical 路径读取，兼容旧 item 链接但不伪造官方 ID", () => {
    expect(readReaderTarget("official-entry", new URLSearchParams())).toEqual({
      kind: "entry",
      entryId: "official-entry",
    })
    expect(
      readReaderTarget("pending", new URLSearchParams("item=entry:feed/1:older-entry")),
    ).toEqual({ kind: "entry", entryId: "older-entry", sourceKey: "feed/1" })
    expect(readReaderTarget("pending", new URLSearchParams("item=story:stable-story"))).toEqual({
      kind: "story",
      storyId: "stable-story",
    })
  })

  it("综述跳转保留原生列表范围和筛选，官方正文槽位恢复 pending", () => {
    expect(
      storyReaderLocation(
        "/timeline/social-media/folder-Crypto/official-entry",
        new URLSearchParams("aiSearch=tool&item=entry:feed/1:official-entry"),
        "story-one",
      ),
    ).toEqual({
      pathname: "/timeline/social-media/folder-Crypto/pending",
      search: "?aiSearch=tool&story=story-one",
    })
    expect(storyReaderLocation("/events", new URLSearchParams(), "story-one").pathname).toBe(
      "/events",
    )
  })

  it("无效日历日期不会进位为另一日", () => {
    expect(validReaderDate("2026-02-30")).toBe("")
    expect(validReaderDate("2026-10-04")).toBe("2026-10-04")
  })
})
