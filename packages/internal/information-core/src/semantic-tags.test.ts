import { describe, expect, it } from "vitest"

import {
  buildSemanticTagGroups,
  semanticTagDefinition,
  semanticTagDefinitions,
  semanticTagDefinitionSchema,
  semanticTagIds,
  tagAssessmentSchema,
} from "./semantic-tags"

describe("内置语义定义", () => {
  it("每个稳定 ID 有独立定义、正反例及版本，名称和用户偏好不参与身份", () => {
    expect(semanticTagDefinitions).toHaveLength(30)
    expect(new Set(semanticTagDefinitions.map((item) => item.id)).size).toBe(semanticTagIds.length)
    for (const definition of semanticTagDefinitions) {
      expect(semanticTagDefinitionSchema.safeParse(definition).success).toBe(true)
      expect(semanticTagDefinition(definition.id)).toBe(definition)
      expect(definition.definitionVersion).toBe(definition.id === "topic:product" ? 2 : 1)
    }
    expect(semanticTagDefinition("纯娱乐")).toBeUndefined()
    expect(semanticTagDefinition("form:pure_entertainment")?.negativeExamples).toContain("音乐教程")
  })
  it("细分区块链领域有父级，产品定义排除只涉及经营与资产的事件", () => {
    for (const id of ["topic:defi", "topic:blockchain_infrastructure"])
      expect(semanticTagDefinition(id)?.parentId).toBe("topic:blockchain")
    expect(semanticTagDefinition("topic:fintech")?.parentId).toBeNull()
    expect(semanticTagDefinition("topic:product")?.description).toContain(
      "融资、机构设立子公司、交易和持仓",
    )
    expect(semanticTagDefinitions.filter((definition) => definition.kind === "event")).toHaveLength(
      13,
    )
  })
  it("判断不能提交自由标签、非法版本或越界置信度，明确 absent 不需伪造引文", () => {
    const valid = {
      tagId: "form:tutorial",
      definitionVersion: 1,
      state: "absent",
      confidence: 0.95,
      reason: "已检查完整正文，没有操作步骤",
      evidenceIds: [],
    }
    expect(tagAssessmentSchema.safeParse(valid).success).toBe(true)
    for (const update of [
      { tagId: "教程" },
      { definitionVersion: 0 },
      { confidence: 1.1 },
      { confidence: -0.1 },
      { state: "missing" },
      { reason: "" },
    ])
      expect(tagAssessmentSchema.safeParse({ ...valid, ...update }).success).toBe(false)
    expect(
      tagAssessmentSchema.safeParse({ ...valid, state: "unknown", confidence: null }).success,
    ).toBe(true)
  })
})

describe("语义标签展示组合", () => {
  it("明确的单领域产品组合去重，事件独立并排在形式和信号前", () => {
    expect(
      buildSemanticTagGroups([
        "signal:original_data",
        "event:product_launch",
        "topic:product",
        "topic:blockchain",
        "topic:product",
      ]),
    ).toEqual([
      ["topic:blockchain", "topic:product"],
      ["event:product_launch"],
      ["signal:original_data"],
    ])
    expect(buildSemanticTagGroups(["topic:ai", "topic:product"])).toEqual([
      ["topic:ai", "topic:product"],
    ])
    expect(buildSemanticTagGroups(["topic:product"])).toEqual([["topic:product"]])
  })
  it("细分领域隐藏宽泛父级，但允许明确父级参与产品组合", () => {
    expect(buildSemanticTagGroups(["topic:blockchain", "topic:defi"])).toEqual([["topic:defi"]])
    expect(
      buildSemanticTagGroups([
        "topic:blockchain",
        "topic:defi",
        "topic:blockchain_infrastructure",
        "topic:product",
      ]),
    ).toEqual([
      ["topic:blockchain", "topic:product"],
      ["topic:defi"],
      ["topic:blockchain_infrastructure"],
    ])
    expect(buildSemanticTagGroups(["topic:defi", "topic:product"])).toEqual([
      ["topic:defi"],
      ["topic:product"],
    ])
  })
  it("单领域与唯一事件可组合，多领域或多事件不能臆造关联", () => {
    expect(
      buildSemanticTagGroups(["event:institutional_accumulation", "topic:blockchain"]),
    ).toEqual([["topic:blockchain", "event:institutional_accumulation"]])
    expect(
      buildSemanticTagGroups(["topic:ai", "topic:blockchain", "topic:product", "event:funding"]),
    ).toEqual([["topic:ai"], ["topic:blockchain"], ["topic:product"], ["event:funding"]])
    expect(
      buildSemanticTagGroups([
        "topic:blockchain",
        "event:funding",
        "event:institutional_investment",
      ]),
    ).toEqual([["topic:blockchain"], ["event:funding"], ["event:institutional_investment"]])
    expect(
      buildSemanticTagGroups(["topic:blockchain", "topic:defi", "event:feature_update"]),
    ).toEqual([["topic:defi"], ["event:feature_update"]])
  })
  it("空标签保持空展示", () => {
    expect(buildSemanticTagGroups([])).toEqual([])
  })
})
