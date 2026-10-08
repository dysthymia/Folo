import { randomUUID } from "node:crypto"

import { afterEach, describe, expect, it } from "vitest"

import { processingApi } from "./processing-api"
import { processListLoaded } from "./processing-list-load"
import { Store } from "./store"

const stores: Store[] = []
const now = new Date("2026-10-04T10:00:00Z")
const source = {
  key: "feed/list-load",
  kind: "feed" as const,
  id: "list-load",
  title: "加载来源",
  category: null,
  view: 0,
}
const listed = {
  id: "loaded",
  sourceKey: source.key,
  title: "列表条目",
  publishedAt: "2026-10-04T09:00:00Z",
  url: null,
  read: false,
  description: null,
}
function fixture() {
  const store = new Store(":memory:")
  stores.push(store)
  store.bindOwner("owner")
  store.replaceSources([source, { ...source, key: "feed/other", id: "other" }])
  const draft = store.automation.draft()
  store.automation.saveDraft(
    {
      ...draft.config,
      rules: [
        {
          id: "ai",
          name: "自动处理",
          ownerId: "owner",
          enabled: true,
          order: 0,
          version: 1,
          executionLocation: "processing_service",
          when: { all: true },
          actions: [{ type: "ai_transform", prompt: "概括正文" }],
        },
      ],
    },
    draft.revision,
  )
  store.automation.publish(draft.revision + 1, { mode: "future" }, randomUUID())
  store.schedule.save(
    {
      sourceKeys: [source.key],
      historySince: "2026-10-04T00:00:00Z",
      timeZone: "UTC",
      enabled: true,
    },
    0,
  )
  return store
}
afterEach(() => stores.splice(0).forEach((store) => store.close()))

// 只使用内存库，验证事件捕获和队列范围，不请求真实模型。
describe("列表加载自动化入口", () => {
  it("只有语义阅读动作也能接收授权来源的新未读条目", () => {
    const store = fixture()
    const draft = store.automation.draft()
    store.automation.saveDraft(
      {
        ...draft.config,
        formatVersion: 5,
        rules: draft.config.rules.map((rule) => ({
          ...rule,
          when: {
            anyOf: [
              {
                allOf: [
                  { field: "source_id", operator: "in", value: [source.key] },
                  {
                    field: "entry_tag",
                    operator: "contains_any",
                    value: ["signal:social_chatter"],
                  },
                ],
              },
            ],
          },
          actions: [{ type: "reading_decision", visibility: "hide" }],
        })),
      },
      draft.revision,
    )
    store.automation.publish(draft.revision + 1, { mode: "future" }, randomUUID())
    const result = processListLoaded(
      store,
      { entries: [listed, { ...listed, id: "outside", sourceKey: "feed/other" }] },
      now,
    )
    expect(result.accepted).toBe(1)
    expect(result.trigger?.targets).toEqual([{ sourceKey: source.key, itemId: listed.id }])
  })
  it("严格校验列表元信息、最多一百条且不能提交正文", () => {
    const store = fixture()
    expect(() =>
      processingApi(store, "POST", "/processing/list-loaded", {
        entries: [{ ...listed, content: "不可信正文" }],
      }),
    ).toThrow()
    expect(() =>
      processListLoaded(store, { entries: Array.from({ length: 101 }, () => listed) }, now),
    ).toThrow()
    expect(() =>
      processListLoaded(store, { entries: [{ ...listed, publishedAt: "invalid" }] }, now),
    ).toThrow()
    expect(store.automation.inputs()).toEqual([])
  })
  it("仅规则授权与计划交集内的明确未读、本历史窗口条目成为目标", () => {
    const store = fixture()
    const response = processListLoaded(
      store,
      {
        entries: [
          listed,
          listed,
          { ...listed, id: "read", read: true },
          { ...listed, id: "unknown", read: null },
          { ...listed, id: "history", publishedAt: "2026-01-01T00:00:00Z" },
          { ...listed, id: "future", publishedAt: "2027-01-01T00:00:00Z" },
          { ...listed, id: "other", sourceKey: "feed/other" },
          { ...listed, id: "generated", sourceKey: "generated:story" },
        ],
      },
      now,
    )
    expect(response.accepted).toBe(1)
    expect(response.trigger).toMatchObject({
      kind: "list_loaded",
      sourceKeys: [source.key],
      targets: [{ sourceKey: source.key, itemId: listed.id }],
      historySince: "2026-10-04T00:00:00.000Z",
    })
    expect(store.automation.inputs().map((input) => input.itemId)).toEqual([
      "loaded",
      "read",
      "unknown",
    ])
  })
  it("总暂停、列表开关或未发布规则都不捕获材料、不建任务", () => {
    const store = fixture()
    const config = store.schedule.snapshot().config!
    store.schedule.save({ ...config, runOnListLoad: false }, 1)
    expect(processListLoaded(store, { entries: [listed] }, now)).toEqual({
      accepted: 0,
      trigger: null,
    })
    store.schedule.save({ ...config, enabled: false }, 2)
    expect(processListLoaded(store, { entries: [listed] }, now)).toEqual({
      accepted: 0,
      trigger: null,
    })
    expect(store.automation.inputs()).toEqual([])
    const unpublished = new Store(":memory:")
    stores.push(unpublished)
    unpublished.bindOwner("owner")
    unpublished.replaceSources([source])
    unpublished.schedule.save(config, 0)
    expect(processListLoaded(unpublished, { entries: [listed] }, now)).toEqual({
      accepted: 0,
      trigger: null,
    })
  })
  it("读取列表保留已水合正文与身份元信息，同正文重复不换代", () => {
    const store = fixture()
    store.saveEntry({
      ...listed,
      content: "已验证正文",
      author: "作者",
      updatedAt: "2026-10-04T08:00:00Z",
      context: { links: "complete" },
    })
    const original = store.automation.current(source.key, listed.id)!
    processListLoaded(store, { entries: [listed] }, now)
    expect(store.entry(source.key, listed.id)).toMatchObject({
      content: "已验证正文",
      author: "作者",
      context: { links: "complete" },
    })
    expect(store.automation.current(source.key, listed.id)?.seq).toBe(original.seq)
  })
  it("同 revision pending 合并分页，running 保持冻结且新目标进入下一批", () => {
    const store = fixture()
    const first = processListLoaded(store, { entries: [listed] }, now).trigger!
    const second = processListLoaded(store, { entries: [{ ...listed, id: "page2" }] }, now).trigger!
    expect(second.id).toBe(first.id)
    expect(second.targets).toHaveLength(2)
    const running = store.schedule.claim(now)!
    expect(processListLoaded(store, { entries: [listed] }, now).trigger).toBeNull()
    const next = processListLoaded(store, { entries: [{ ...listed, id: "page3" }] }, now).trigger!
    expect(next.id).not.toBe(running.id)
    expect(store.schedule.triggers().find((run) => run.id === running.id)?.targets).toHaveLength(2)
    expect(next.targets).toEqual([{ sourceKey: source.key, itemId: "page3" }])
  })
  it("完成后至少六十秒抑制重复，正文变化不受旧签名冷却阻塞", () => {
    const store = fixture()
    processListLoaded(store, { entries: [listed] }, now)
    const running = store.schedule.claim(now)!
    store.schedule.finish(running.id, running.leaseToken!, "succeeded", now)
    expect(
      processListLoaded(store, { entries: [listed] }, new Date(now.getTime() + 59_000)).trigger,
    ).toBeNull()
    expect(
      processListLoaded(
        store,
        { entries: [{ ...listed, title: "内容已更新" }] },
        new Date(now.getTime() + 59_000),
      ).trigger?.kind,
    ).toBe("list_loaded")
  })
  it("已有定时任务覆盖已加载条目时复用队列，不增加列表任务", () => {
    const store = fixture()
    const scheduled = store.schedule.manual(randomUUID(), now)
    const result = processListLoaded(store, { entries: [listed] }, now)
    expect(result.trigger?.id).toBe(scheduled.id)
    expect(store.schedule.triggers()).toHaveLength(1)
  })
})

it("只重排本次加载且缺少标签的未读条目，并保持定时来源范围", () => {
  const store = fixture()
  const old = { ...listed, id: "old", sourceKey: "feed/other", content: "真实正文" }
  const unread = { ...old, id: "unread" }
  const read = { ...old, id: "read", read: true }
  for (const entry of [old, unread, read]) {
    store.saveEntry(entry)
    store.automation.recalculate(store.automation.current(entry.sourceKey, entry.id)!, {}, 1)
  }
  const draft = store.automation.draft()
  store.automation.activateRule(
    "classify",
    {
      id: "classify",
      ownerId: "owner",
      name: "标签",
      order: 1,
      enabled: true,
      version: 1,
      executionLocation: "processing_service",
      when: { all: true },
      actions: [{ type: "ai_classify", tagIds: ["topic:ai"] }],
    },
    draft.revision,
    randomUUID(),
  )
  const prior = store.automation.current(old.sourceKey, old.id)!
  const result = processListLoaded(
    store,
    { entries: [unread, read].map(({ content: _content, ...entry }) => entry) },
    now,
  )
  expect(result.accepted).toBe(1)
  expect(result.trigger?.targets).toEqual([{ sourceKey: unread.sourceKey, itemId: unread.id }])
  expect(store.automation.current(unread.sourceKey, unread.id)).toMatchObject({
    status: "pending",
    releaseVersion: 2,
  })
  expect(store.automation.current(old.sourceKey, old.id)).toEqual(prior)
  expect(store.automation.current(read.sourceKey, read.id)).toMatchObject({
    status: "succeeded",
    releaseVersion: 1,
  })
  expect(store.schedule.snapshot().config?.sourceKeys).toEqual([source.key])
})
