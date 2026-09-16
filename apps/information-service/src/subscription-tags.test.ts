import { randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"

import { afterEach, describe, expect, it } from "vitest"

import { AutomationStore } from "./automation-store"
import { SubscriptionTagError, SubscriptionTagStore } from "./subscription-tags"

const databases: DatabaseSync[] = []

function fixture(owner = "owner") {
  const db = new DatabaseSync(":memory:")
  databases.push(db)
  let currentOwner: string | null = owner
  return {
    db,
    tags: new SubscriptionTagStore(db, () => currentOwner),
    owner(value: string | null) {
      currentOwner = value
    },
  }
}

afterEach(() => {
  databases.splice(0).forEach((db) => db.close())
})

describe("私人订阅标签", () => {
  it("使用稳定 ID 保存私有标签，并在改名后保留 ID 和版本", () => {
    const { tags } = fixture()
    const created = tags.create("来源/媒体", 0)
    const tag = created.tags[0]!
    expect(created).toMatchObject({ formatVersion: 1, revision: 1 })
    const renamed = tags.rename(tag.id, "来源/新闻媒体", 1)
    expect(renamed).toMatchObject({ revision: 2 })
    expect(renamed.tags).toEqual([
      expect.objectContaining({ id: tag.id, name: "来源/新闻媒体", createdAt: tag.createdAt }),
    ])
  })

  it("拒绝过期写入、跨账号读取和伪造的其他账号标签", () => {
    const { tags, owner } = fixture("owner-a")
    const tag = tags.create("领域/AI", 0).tags[0]!
    expect(() => tags.create("用途/重点观察", 0)).toThrow("revision_conflict")
    owner("owner-b")
    expect(tags.snapshot().tags).toEqual([])
    expect(() => tags.rename(tag.id, "领域/机器学习", 1)).toThrow("invalid_tag")
    owner(null)
    expect(() => tags.snapshot()).toThrow("owner_required")
  })

  it("批量绑定覆盖完整 sourceKey 集合，不依赖当前页面", () => {
    const { tags } = fixture()
    const tag = tags.create("用途/重点观察", 0).tags[0]!
    const allSourceKeys = Array.from({ length: 1001 }, (_, index) => `feed/${index + 1}`)
    const applied = tags.updateBindings({
      expectedRevision: 1,
      sourceKeys: allSourceKeys,
      tagIds: [tag.id, tag.id],
      operation: "add",
    })
    expect(applied).toMatchObject({ revision: 2, changedBindings: 1001 })
    const bindings = tags.sourceTagBindings()
    expect(bindings.revision).toBe(2)
    expect(bindings.bindings).toHaveLength(1001)
    expect(bindings.bindings.at(-1)).toEqual({ sourceKey: "feed/999", tagIds: [tag.id] })
    expect(tags.sourceTagBindings(["feed/1", "feed/1001"]).bindings).toEqual([
      { sourceKey: "feed/1", tagIds: [tag.id] },
      { sourceKey: "feed/1001", tagIds: [tag.id] },
    ])
    const removed = tags.updateBindings({
      expectedRevision: 2,
      sourceKeys: allSourceKeys,
      tagIds: [tag.id],
      operation: "remove",
    })
    expect(removed).toMatchObject({ revision: 3, changedBindings: 1001 })
    expect(tags.sourceTagBindings().bindings).toEqual([])
  })

  it("不允许将不存在的标签写入来源绑定", () => {
    const { tags } = fixture()
    tags.create("来源/研究者", 0)
    expect(() =>
      tags.updateBindings({
        expectedRevision: 1,
        sourceKeys: ["feed/1"],
        tagIds: ["not-a-tag"],
        operation: "add",
      }),
    ).toThrow("invalid_tag_set")
    expect(tags.sourceTagBindings().bindings).toEqual([])
  })

  it("来源标签只能绑定实际 feed 或 inbox，不能绑定 List 容器", () => {
    const { tags } = fixture()
    const tag = tags.create("来源/研究者", 0).tags[0]!
    expect(() =>
      tags.updateBindings({
        expectedRevision: 1,
        sourceKeys: ["list/1"],
        tagIds: [tag.id],
        operation: "add",
      }),
    ).toThrow("invalid_source_keys")
    expect(() => tags.sourceTagBindings(["feed/1/child"])).toThrow("invalid_source_keys")
    expect(tags.sourceTagBindings().bindings).toEqual([])
  })

  it("删除被当前规则引用的标签会拒绝并返回规则 ID", () => {
    const { db, tags } = fixture()
    const automation = new AutomationStore(db, () => "owner")
    const tag = tags.create("来源/项目方", 0).tags[0]!
    automation.saveDraft(
      {
        formatVersion: 4,
        ownerId: "owner",
        global: { version: 1, markdown: "" },
        rules: [
          {
            id: "project-rule",
            ownerId: "owner",
            name: "项目方公告",
            enabled: true,
            order: 0,
            when: {
              anyOf: [
                {
                  allOf: [
                    {
                      field: "subscription_tag",
                      operator: "contains_any",
                      value: [tag.id],
                    },
                  ],
                },
              ],
            },
            actions: [{ type: "ai_transform", prompt: "保留公告" }],
            version: 1,
            executionLocation: "processing_service",
          },
        ],
      },
      0,
    )
    try {
      tags.delete(tag.id, 1)
      throw new Error("expected tag reference rejection")
    } catch (error) {
      expect(error).toBeInstanceOf(SubscriptionTagError)
      expect(error).toMatchObject({ code: "tag_referenced", ruleIds: ["project-rule"] })
    }
  })

  it("删除被最新发布聚合范围引用的标签会拒绝，旧历史版本不会永久阻止删除", () => {
    const { db, tags } = fixture()
    const automation = new AutomationStore(db, () => "owner")
    const tag = tags.create("领域/AI", 0).tags[0]!
    const aggregateRule = {
      id: "aggregate-rule",
      ownerId: "owner",
      name: "AI 聚合",
      enabled: true,
      order: 0,
      when: { all: true },
      actions: [
        {
          type: "ai_aggregate",
          createPrompt: "综合同一事件",
          updatePrompt: "补充新事实",
          scope: {
            anyOf: [
              {
                allOf: [
                  {
                    field: "subscription_tag",
                    operator: "contains_any",
                    value: [tag.id],
                  },
                ],
              },
            ],
          },
          mode: "same_event",
        },
      ],
      version: 1,
      executionLocation: "processing_service",
    } as const
    automation.saveDraft(
      {
        formatVersion: 4,
        ownerId: "owner",
        global: { version: 1, markdown: "" },
        rules: [aggregateRule],
      },
      0,
    )
    automation.publish(1, { mode: "future" }, randomUUID())
    automation.saveDraft(
      {
        formatVersion: 4,
        ownerId: "owner",
        global: { version: 1, markdown: "" },
        rules: [],
      },
      1,
    )
    try {
      tags.delete(tag.id, 1)
      throw new Error("expected latest release reference rejection")
    } catch (error) {
      expect(error).toMatchObject({ code: "tag_referenced", ruleIds: ["aggregate-rule"] })
    }

    // 新发布版本不再引用后，旧历史版本仍保留，但不再阻止当前标签删除。
    automation.publish(2, { mode: "future" }, randomUUID())
    expect(tags.delete(tag.id, 1)).toMatchObject({ revision: 2, tags: [] })
  })

  it("删除未引用标签会清理私有绑定并推进元数据版本", () => {
    const { tags } = fixture()
    const tag = tags.create("领域/DeFi", 0).tags[0]!
    tags.updateBindings({
      expectedRevision: 1,
      sourceKeys: ["feed/1", "inbox/1"],
      tagIds: [tag.id],
      operation: "add",
    })
    expect(tags.delete(tag.id, 2)).toMatchObject({ revision: 3, tags: [] })
    expect(tags.sourceTagBindings()).toMatchObject({ revision: 3, bindings: [] })
  })
})
