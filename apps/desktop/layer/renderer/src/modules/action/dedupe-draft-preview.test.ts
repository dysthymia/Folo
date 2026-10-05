import type { AutomationRule, ConditionSet } from "@follow/information-core"
import { conditionSetSchema } from "@follow/information-core"
import { describe, expect, it } from "vitest"

import { previewDedupeDraft } from "./dedupe-draft-preview"
import type { ProcessingEditor } from "./processing-client"

const rule: AutomationRule = {
  id: "dedupe",
  ownerId: "owner",
  name: "Dedupe",
  enabled: false,
  order: 0,
  version: 1,
  executionLocation: "processing_service",
  when: { anyOf: [{ allOf: [{ field: "source_id", operator: "in", value: ["feed/allowed"] }] }] },
  actions: [{ type: "ai_dedupe", scope: { all: true } }],
}
const editor: ProcessingEditor = {
  revision: 1,
  capabilities: { automaticProcessing: true },
  config: { formatVersion: 4, ownerId: "owner", global: { markdown: "", version: 1 }, rules: [] },
  sources: [],
  sourceInventoryKnown: true,
  sourceTags: [],
  subscriptionTags: { formatVersion: 1, revision: 0, tags: [] },
  listMemberships: [],
  releases: [],
  items: ["one", "two", "three"].map((id) => ({
    id,
    sourceKey: id === "three" ? "feed/outside" : "feed/allowed",
    title: id,
    url: null,
    publishedAt: "2026-10-04T00:00:00Z",
  })),
}
describe("去重草稿样本预览", () => {
  it.each([
    [
      "未选分类",
      {
        anyOf: [
          { allOf: [{ field: "category_ref", operator: "eq", value: { view: 0, name: "" } }] },
        ],
      },
    ],
    [
      "空文本条件",
      { anyOf: [{ allOf: [{ field: "entry_title", operator: "contains", value: "" }] }] },
    ],
    ["未选来源", { anyOf: [{ allOf: [{ field: "source_id", operator: "in", value: [] }] }] }],
    ["移除全部条件", { anyOf: [{ allOf: [] }] }],
    ["移除全部条件组", { anyOf: [] }],
  ] satisfies [string, ConditionSet][])(
    "%s 时规则和动作范围均保持待完成，不扩大匹配",
    (_, conditions) => {
      // 编辑器允许未完成草稿，但发布与执行共用的 Schema 继续拒绝这些条件。
      expect(conditionSetSchema.safeParse(conditions).success).toBe(false)
      expect(previewDedupeDraft({ ...rule, when: conditions }, editor)).toBeNull()
      expect(
        previewDedupeDraft(
          { ...rule, actions: [{ type: "ai_dedupe", scope: conditions }] },
          editor,
        ),
      ).toBeNull()
    },
  )
  it("只统计规则范围内候选并明确候选对上界", () => {
    expect(previewDedupeDraft(rule, editor)).toEqual({
      sources: 1,
      matched: 2,
      unknown: 0,
      pairs: 1,
    })
  })
  it("缺失已读字段时保持未知，不称为确定匹配", () => {
    const scoped: AutomationRule = {
      ...rule,
      actions: [
        {
          type: "ai_dedupe",
          scope: { anyOf: [{ allOf: [{ field: "status", operator: "eq", value: "unread" }] }] },
        },
      ],
    }
    expect(previewDedupeDraft(scoped, editor)).toMatchObject({ matched: 0, unknown: 2, pairs: 1 })
  })
})
