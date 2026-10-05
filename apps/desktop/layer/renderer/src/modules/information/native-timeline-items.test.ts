import { describe, expect, it } from "vitest"

import type { GeneratedReaderItem } from "./generated-feed-client"
import { mergeNativeTimelineItems } from "./native-timeline-items"

const date = (hour: number) => `2026-10-04T${String(hour).padStart(2, "0")}:00:00Z`
const original = (id: string, hour: number): Extract<GeneratedReaderItem, { kind: "entry" }> => ({
  kind: "entry",
  origin: "original",
  id,
  sourceKey: "feed/1",
  title: id,
  summary: "",
  publishedAt: date(hour),
  read: false,
  collected: false,
  materialCount: 0,
  topics: [],
  inputSeq: null,
  decisionId: null,
  storyIds: [],
})
const story = (id: string, hour: number): Extract<GeneratedReaderItem, { kind: "story" }> => ({
  kind: "story",
  origin: "generated",
  id,
  storyId: id,
  generatedFeedId: "generated:events",
  title: id,
  summary: "",
  publishedAt: date(hour),
  updatedAt: date(hour),
  read: false,
  collected: false,
  materialCount: 2,
  topics: [],
  revision: 1,
  substantiveRevision: 1,
  sourceKeys: ["feed/1"],
  hasImportantUpdate: false,
})
const keys = (items: GeneratedReaderItem[]) => items.map((item) => `${item.kind}:${item.id}`)

describe("普通时间线的双流时间水位", () => {
  it("暂缓旧 Story，官方下一页只能追加到已完整展示区间之后", () => {
    const stories = [story("new", 11), story("old", 5)]
    const first = mergeNativeTimelineItems({
      originals: [original("a", 12), original("b", 10)],
      stories,
      originalHasNext: true,
      storyHasNext: false,
    })
    expect(keys(first)).toEqual(["entry:a", "story:new", "entry:b"])
    const next = mergeNativeTimelineItems({
      originals: [original("a", 12), original("b", 10), original("c", 8), original("d", 4)],
      stories,
      originalHasNext: true,
      storyHasNext: false,
    })
    expect(keys(next)).toEqual([...keys(first), "entry:c", "story:old", "entry:d"])
  })

  it("Story 下一页补齐水位后才释放更老原文", () => {
    const originals = [original("a", 12), original("b", 8), original("c", 4)]
    const first = mergeNativeTimelineItems({
      originals,
      stories: [story("new", 10)],
      originalHasNext: true,
      storyHasNext: true,
    })
    expect(keys(first)).toEqual(["entry:a", "story:new"])
    expect(
      keys(
        mergeNativeTimelineItems({
          originals,
          stories: [story("new", 10), story("old", 6), story("tail", 2)],
          originalHasNext: true,
          storyHasNext: true,
        }),
      ),
    ).toEqual([...keys(first), "entry:b", "story:old", "entry:c"])
  })

  it("优先采用官方响应页尾，不以过滤后原文末行限制已覆盖区间", () => {
    expect(
      keys(
        mergeNativeTimelineItems({
          originals: [original("a", 12)],
          stories: [story("covered", 8), story("buffered", 3)],
          originalHasNext: true,
          storyHasNext: false,
          originalBoundary: date(4),
        }),
      ),
    ).toEqual(["entry:a", "story:covered"])
  })

  it("官方页全部被隐藏时仍按原始响应边界展示已覆盖 Story", () => {
    expect(
      keys(
        mergeNativeTimelineItems({
          originals: [],
          stories: [story("covered", 8), story("buffered", 3)],
          originalHasNext: true,
          storyHasNext: false,
          originalBoundary: date(4),
        }),
      ),
    ).toEqual(["story:covered"])
  })

  it("两流耗尽后释放所有条目并保留同时间原文顺序", () => {
    expect(
      keys(
        mergeNativeTimelineItems({
          originals: [original("z", 8), original("a", 8), original("older", 1)],
          stories: [story("same", 8)],
          originalHasNext: false,
          storyHasNext: false,
        }),
      ),
    ).toEqual(["story:same", "entry:z", "entry:a", "entry:older"])
  })

  it("按真实身份去重，Story 修订和原文来源不会新增重复行", () => {
    const item = original("same", 8)
    const generated = story("same", 8)
    const rows = mergeNativeTimelineItems({
      originals: [item, { ...item, sourceKey: "list/1" }],
      stories: [generated, { ...generated, revision: 2 }],
      originalHasNext: false,
      storyHasNext: false,
    })
    expect(rows).toEqual([generated, item])
  })

  it.each(["entry", "story"])("未耗尽的 %s 流为空时暂缓另一流", (emptyKind) => {
    expect(
      mergeNativeTimelineItems({
        originals: emptyKind === "entry" ? [] : [original("a", 8)],
        stories: emptyKind === "story" ? [] : [story("s", 8)],
        originalHasNext: emptyKind === "entry",
        storyHasNext: emptyKind === "story",
      }),
    ).toEqual([])
  })

  it("无效官方边界不产生未经确认的顺序", () => {
    expect(
      mergeNativeTimelineItems({
        originals: [original("a", 8)],
        stories: [story("s", 7)],
        originalHasNext: true,
        storyHasNext: false,
        originalBoundary: "invalid",
      }),
    ).toEqual([])
  })
})
