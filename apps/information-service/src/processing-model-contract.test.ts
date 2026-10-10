import { describe, expect, it } from "vitest"

import {
  createEntryModelSelectionSchema,
  entryModelOutputSchema,
  entryModelSelectionJSONSchema,
} from "./processing-decision"
import { materializeEvent } from "./processing-event"
import { materializeEventMentions } from "./processing-event-mentions"
import { createEvidenceCatalog, materializeEvidenceFacts } from "./processing-evidence"

// 复现真实失败的两类跨字段冲突：模型规范化名称，以及把语义相关事实误归于身份证据。
const catalog = createEvidenceCatalog("来源分析比特币价格。另有市场成交数据。")
const event = {
  kind: "analysis",
  subject: { value: "来源", evidenceId: "E000001" },
  action: { value: "public_statement", evidenceId: "E000001" },
  object: { value: "比特币价格", evidenceId: "E000001" },
  version: null,
  round: null,
  anchor: null,
}
const selected = {
  entryId: "entry",
  title: "分析",
  summary: "价格分析与市场数据",
  disposition: "keep",
  reason: "包含可用事实",
  aggregation: false,
  rewrite: false,
  labels: [],
  event,
  eventMentions: [{ identity: event, role: "analysis_of", isPrimary: true }],
  facts: [
    {
      text: "来源分析比特币价格",
      kind: "source_claim",
      evidenceId: "E000001",
      eventMentionIndex: 3,
    },
    { text: "另有市场成交数据", kind: "fact", evidenceId: "E000002", eventMentionIndex: 0 },
  ],
  tagAssessments: [
    {
      tagId: "topic:product",
      definitionVersion: 2,
      state: "absent",
      confidence: 0.98,
      reason: "未报道产品",
      evidenceIds: ["E000001"],
    },
  ],
  substantiveContribution: {
    state: "present",
    confidence: 0.98,
    reason: "提供数据",
    evidenceIds: ["E000002"],
  },
  materialCoverage: "complete",
  entities: [
    {
      kind: "asset",
      name: "Bitcoin",
      aliases: ["BTC", "比特币"],
      parentName: null,
      confidence: 0.99,
      evidenceIds: ["E000001"],
    },
  ],
}

describe("模型协议与证据驱动解析", () => {
  const schema = createEntryModelSelectionSchema("entry", catalog, ["topic:product"])
  it("模型协议没有归属序号，所有对象属性均必填，符合严格结构化输出", () => {
    const wire = entryModelSelectionJSONSchema(schema)
    const visit = (value: unknown) => {
      if (!value || typeof value !== "object") return
      if (Array.isArray(value)) return value.forEach(visit)
      const node = value as Record<string, unknown>
      if (node.type === "object") {
        const properties = node.properties as Record<string, unknown>
        expect(node.required).toEqual(Object.keys(properties))
        expect(node.additionalProperties).toBe(false)
        expect(properties).not.toHaveProperty("eventMentionIndex")
      }
      Object.values(node).forEach(visit)
    }
    visit(wire)
  })
  it("只保存有据字面名称，并按唯一证据包含计算归属，持久化仍通过严格校验", () => {
    const parsed = schema.parse(selected)
    expect(parsed.entities?.[0]).toMatchObject({ name: "比特币", aliases: [] })
    expect(parsed.facts.map((fact) => fact.eventMentionIndex)).toEqual([0, null])
    const output = {
      ...parsed,
      event: materializeEvent(catalog, parsed.event),
      eventMentions: materializeEventMentions(catalog, parsed.eventMentions ?? []),
      facts: materializeEvidenceFacts(catalog, parsed.facts),
    }
    expect(entryModelOutputSchema.safeParse(output).success).toBe(true)
    // 解析幂等；没有任何有据候选或无据所属仍拒绝，不凭常识创建身份。
    expect(schema.parse(parsed)).toEqual(parsed)
    expect(
      schema.safeParse({ ...selected, entities: [{ ...selected.entities[0], aliases: ["BTC"] }] })
        .success,
    ).toBe(false)
    expect(
      schema.safeParse({
        ...selected,
        entities: [{ ...selected.entities[0], parentName: "未知机构" }],
      }).success,
    ).toBe(false)
  })
  it("相同原文位置重复或多事件身份证据重叠时不生成事实归属", () => {
    const ambiguous = schema.parse({
      ...selected,
      eventMentions: [
        ...selected.eventMentions,
        { identity: event, role: "mentions", isPrimary: false },
      ],
    })
    expect(ambiguous.facts.map((fact) => fact.eventMentionIndex)).toEqual([null, null])
  })
})
