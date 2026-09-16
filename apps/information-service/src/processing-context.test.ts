import { describe, expect, it } from "vitest"

import type { SourceEntry } from "./folo"
import { processingRuleInput } from "./processing-context"
import type { Store } from "./store"

const entry: SourceEntry = {
  id: "entry-1",
  sourceKey: "list/l1",
  feedId: "f1",
  feedKind: "feed",
  title: "文章标题",
  url: "https://x.com/example/status/1",
  publishedAt: "2026-01-01T00:00:00.000Z",
  read: true,
  content: "正文",
  description: null,
}

function storeFixture(): Store {
  return {
    sources: () => [
      {
        key: "feed/f1",
        kind: "feed",
        id: "f1",
        title: "真实 Feed 标题",
        view: 0,
        category: "研究",
        siteUrl: "https://source.example.test",
        feedUrl: "https://source.example.test/rss.xml",
        platform: null,
      },
      {
        key: "list/l1",
        kind: "list",
        id: "l1",
        title: "List 容器",
        view: 1,
        category: "关注",
      },
    ],
    sourceSync: {
      contextFor: () => ({
        sourceId: "feed/f1",
        contextId: "list/l1",
        view: 1,
        categoryRef: { view: 1, name: "关注" },
        listMembership: { l1: true },
        metadata: { sourceSyncedAt: null, listMembershipVersion: 1 },
      }),
    },
    subscriptionTags: {
      sourceTagBindings: (keys: string[]) => ({
        revision: 1,
        bindings: keys.includes("feed/f1") ? [{ sourceKey: "feed/f1", tagIds: ["tag-feed"] }] : [],
      }),
    },
  } as unknown as Store
}

describe("处理条件上下文", () => {
  it("List 保留容器上下文，但来源标签、名称与 URL 使用实际 feed", () => {
    const context = processingRuleInput(storeFixture(), "list/l1", entry, "正文", true)
    expect(context).toMatchObject({
      source_id: "feed/f1",
      contextId: "list/l1",
      title: "真实 Feed 标题",
      site_url: "https://source.example.test",
      feed_url: "https://source.example.test/rss.xml",
      subscription_tag: ["tag-feed"],
      list_id: { l1: true },
      view: 1,
      category: "关注",
      platform: "x",
    })
    expect(context.subscription_tag).not.toContain("list-container-tag")
  })

  it("缺失元数据保持 unknown，官方明确的零媒体和零秒附件保持 0", () => {
    const missing = processingRuleInput(storeFixture(), "list/l1", entry, null, false)
    const knownZero = processingRuleInput(
      storeFixture(),
      "list/l1",
      { ...entry, mediaLength: 0, attachmentsDuration: 0, collected: false, read: false },
      "正文",
      true,
    )
    expect(missing).toMatchObject({
      entry_media_length: null,
      entry_attachments_duration: null,
      collected: null,
      language: null,
      entry_author: null,
      updated_at: null,
    })
    expect(knownZero).toMatchObject({
      entry_media_length: 0,
      entry_attachments_duration: 0,
      collected: false,
      read: false,
    })
  })

  it("read 使用传入的批次快照，不从之后的状态变化重新推断", () => {
    const startedWithRead = processingRuleInput(storeFixture(), "list/l1", entry, "正文", true)
    const laterUnread = processingRuleInput(
      storeFixture(),
      "list/l1",
      { ...entry, read: false },
      "正文",
      true,
    )
    expect(startedWithRead.read).toBe(true)
    expect(laterUnread.read).toBe(false)
  })
})
