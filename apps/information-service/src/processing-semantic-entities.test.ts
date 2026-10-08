import { randomUUID } from "node:crypto"

import type { SemanticEntity, TagAssessment } from "@follow/information-core"
import { SEMANTIC_ENTITY_VERSION } from "@follow/information-core"
import { afterEach, describe, expect, it } from "vitest"
import { z } from "zod"

import { processingApi } from "./processing-api"
import { createEntryModelSelectionSchema, entryModelOutputSchema } from "./processing-decision"
import { createEvidenceCatalog } from "./processing-evidence"
import {
  createSemanticProfile,
  effectiveSemanticAssessments,
  semanticProfileNeedsAnalysis,
} from "./processing-semantic-decision"
import { semanticEntitiesForCatalog } from "./processing-semantic-entities"
import { Store } from "./store"

const text = "Revolut 拟在菲律宾设立全资子公司。BitMine 买入 ETH。"
const catalog = createEvidenceCatalog(text)
const entity: SemanticEntity = {
  kind: "organization",
  name: "Revolut",
  parentName: null,
  aliases: [],
  confidence: 0.98,
  evidenceIds: ["E000001"],
}
const tag: TagAssessment = {
  tagId: "topic:product",
  definitionVersion: 2,
  state: "absent",
  confidence: 0.98,
  reason: "设立子公司属于业务扩张",
  evidenceIds: ["E000001"],
}
const selected = {
  entryId: "entry",
  title: "扩张",
  summary: "设立子公司",
  disposition: "keep",
  reason: "主要事实",
  aggregation: false,
  rewrite: false,
  labels: [],
  facts: [],
  event: null,
  eventMentions: [],
  tagAssessments: [tag],
  materialCoverage: "complete",
  substantiveContribution: {
    state: "unknown",
    confidence: null,
    reason: "独立判断待定。",
    evidenceIds: [],
  },
  entities: [entity],
}
const stores: Store[] = []
afterEach(() => stores.splice(0).forEach((store) => store.close()))

describe("具体实体的证据与当前结果索引", () => {
  it("新语义请求必须显式提取实体；旧持久化结果继续兼容", () => {
    const schema = createEntryModelSelectionSchema("entry", catalog, ["topic:product"])
    expect(schema.safeParse(selected).success).toBe(true)
    const { entities: _entities, ...old } = selected
    expect(schema.safeParse(old).success).toBe(false)
    expect(entryModelOutputSchema.safeParse(old).success).toBe(true)
    expect(schema.safeParse({ ...selected, entities: [] }).success).toBe(true)
    expect(z.toJSONSchema(schema).required).toContain("entities")
  })

  it("名称、所属和别名都须出现在所选原文；缩写不能命中另一个币名", () => {
    const schema = semanticEntitiesForCatalog(catalog)
    expect(schema.safeParse([entity]).success).toBe(true)
    for (const change of [
      { name: "Revolut Pro" },
      { aliases: ["Revo"] },
      { parentName: "Unmentioned" },
      { evidenceIds: ["E000002"] },
      { evidenceIds: ["otherE000001"] },
    ])
      expect(schema.safeParse([{ ...entity, ...change }]).success).toBe(false)
    const asset = { ...entity, kind: "asset", name: "ETH" }
    expect(
      semanticEntitiesForCatalog(createEvidenceCatalog("买入 BETH 和 ETHW。")).safeParse([asset])
        .success,
    ).toBe(false)
    expect(
      semanticEntitiesForCatalog(createEvidenceCatalog("买入ETH，持仓增加。")).safeParse([asset])
        .success,
    ).toBe(true)
    expect(schema.safeParse([entity, { ...entity, name: "Ｒｅｖｏｌｕｔ" }]).success).toBe(false)
  })

  it("批量模型不可交叉引用另一条目的名称或证据", () => {
    const first = createEntryModelSelectionSchema(
      "entry",
      createEvidenceCatalog(text, { prefix: "B1E" }),
      ["topic:product"],
    )
    const second = createEntryModelSelectionSchema(
      "other",
      createEvidenceCatalog("MagicBlock 发布 Validator。", { prefix: "B2E" }),
      ["topic:product"],
    )
    const schema = z.object({ items: z.array(z.union([first, second])) })
    const own = {
      ...selected,
      tagAssessments: [{ ...tag, evidenceIds: ["B1E000001"] }],
      entities: [{ ...entity, evidenceIds: ["B1E000001"] }],
    }
    expect(schema.safeParse({ items: [own] }).success).toBe(true)
    expect(
      schema.safeParse({
        items: [{ ...own, entities: [{ ...entity, evidenceIds: ["B2E000001"] }] }],
      }).success,
    ).toBe(false)
    expect(
      first.safeParse({
        ...own,
        entities: [{ ...entity, name: "MagicBlock", evidenceIds: ["B1E000001"] }],
      }).success,
    ).toBe(false)
  })

  it("实体完成标记和定义版本决定是否补齐；空实体数组不会重复重算", () => {
    const output = entryModelOutputSchema.parse(selected)
    const profile = createSemanticProfile({
      contentVersion: "v1",
      text,
      output,
      evidence: Object.fromEntries(catalog.fragments.map((item) => [item.evidenceId, item.quote])),
    })!
    expect(profile.entityVersion).toBe(SEMANTIC_ENTITY_VERSION)
    expect(semanticProfileNeedsAnalysis(profile, [tag.tagId])).toBe(false)
    expect(semanticProfileNeedsAnalysis({ ...profile, entities: [] }, [tag.tagId])).toBe(false)
    expect(
      semanticProfileNeedsAnalysis({ ...profile, entityVersion: undefined }, [tag.tagId]),
    ).toBe(true)
    expect(
      semanticProfileNeedsAnalysis(
        { ...profile, assessments: [{ ...tag, definitionVersion: 1 }] },
        [tag.tagId],
      ),
    ).toBe(true)
    expect(
      effectiveSemanticAssessments([{ ...tag, state: "present", definitionVersion: 1 }], []),
    ).toMatchObject([{ state: "unknown", confidence: null }])
    expect(
      effectiveSemanticAssessments(
        [{ ...tag, definitionVersion: 1 }],
        [{ tagId: tag.tagId, state: "present" }],
      ),
    ).toMatchObject([{ state: "present", definitionVersion: 2 }])
    expect(() =>
      createSemanticProfile({ contentVersion: "v1", text, output, evidence: {} }),
    ).toThrow("invalid_semantic_entity_evidence")
  })

  it("真实SQLite批量投影只读取高置信当前实体，旧产品判断不展示，修订后旧指针失效", () => {
    const store = new Store(":memory:")
    stores.push(store)
    store.bindOwner("owner")
    store.replaceSources([
      {
        key: "feed/1",
        id: "1",
        kind: "feed",
        title: "Blockchain",
        view: 0,
        category: "Blockchain",
      },
    ])
    store.automation.publish(0, { mode: "future" }, randomUUID())
    store.saveEntry({
      id: "entry",
      sourceKey: "feed/1",
      title: "Revolut",
      url: null,
      publishedAt: "2026-10-07T00:00:00Z",
      read: false,
      description: null,
      content: text,
    })
    const input = store.automation.assign(store.automation.current("feed/1", "entry")!.seq)
    const profile = createSemanticProfile({
      contentVersion: input.contentVersion,
      text,
      output: entryModelOutputSchema.parse(selected),
      evidence: Object.fromEntries(catalog.fragments.map((item) => [item.evidenceId, item.quote])),
    })!
    profile.assessments = [{ ...tag, state: "present", definitionVersion: 1 }]
    profile.entities!.push({
      ...entity,
      name: "BitMine",
      confidence: 0.8,
      evidenceIds: ["E000002"],
    })
    store.semantics.publish(input, {
      schemaVersion: 2,
      fingerprint: "entity",
      provider: "qianwen",
      model: "test",
      generatedAt: new Date().toISOString(),
      durationMs: 1,
      usage: null,
      status: "keep",
      title: "Revolut",
      summary: "扩张",
      reason: "原文",
      labels: [],
      policy: { standalone: "always", aggregation: "deny", rewrite: "deny" },
      sourceRole: "source",
      context: { source_id: "feed/1", contextId: "feed/1" },
      facts: [],
      semantic: null,
      semanticProfile: profile,
      reused: false,
    })
    expect(store.semantics.presentTagIdsByInput().get(input.seq)).toBeUndefined()
    expect(store.semantics.presentEntitiesByInput().get(input.seq)).toEqual([entity])
    expect(processingApi(store, "GET", "/processing/entry-results", null)).toMatchObject({
      results: [{ semanticEntities: [entity] }],
    })
    expect(store.semantics.view(input).profile?.entities).toHaveLength(2)
    store.saveEntry({ ...input.body, sourceKey: "feed/1", content: "Revolut 更新公告。" })
    expect(store.semantics.presentEntitiesByInput().size).toBe(0)
  })
})
