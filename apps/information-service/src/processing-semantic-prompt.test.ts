import type { TagAssessment } from "@follow/information-core"
import { describe, expect, it } from "vitest"

import { createEvidenceCatalog } from "./processing-evidence"
import type { ChunkSemanticObservation } from "./processing-semantic-prompt"
import {
  combineChunkTagAssessments,
  createTagAssessmentsSelectionSchema,
  renderSemanticTagRequirements,
} from "./processing-semantic-prompt"

const ids = ["signal:pure_promotion", "form:tutorial"]
const assessment = (
  tagId: TagAssessment["tagId"],
  state: TagAssessment["state"],
): TagAssessment => ({
  tagId,
  definitionVersion: 1,
  state,
  confidence: 0.99,
  reason: "已检查本块",
  evidenceIds: state === "unknown" ? [] : ["E000001"],
})
const observation = (
  noise: TagAssessment["state"],
  tutorial: TagAssessment["state"],
  substantive: TagAssessment["state"] = "absent",
  coverage: ChunkSemanticObservation["coverage"] = "complete",
): ChunkSemanticObservation => ({
  coverage,
  tagAssessments: [
    assessment("signal:pure_promotion", noise),
    assessment("form:tutorial", tutorial),
  ],
  substantiveContribution: {
    state: substantive,
    evidenceIds: substantive === "present" ? ["E000002"] : [],
  },
})

describe("长文标签覆盖归并", () => {
  it("推广开头加教程后文不能成为整篇纯推广，后文贡献不依赖 facts", () => {
    const result = combineChunkTagAssessments(
      [observation("present", "absent"), observation("absent", "present", "present")],
      ids,
    )
    expect(result[0]).toMatchObject({ state: "absent", evidenceIds: ["E000002", "E000001"] })
    expect(result[1]).toMatchObject({ state: "present" })
  })
  it("全部完整正证且无实质贡献才支持整篇纯推广", () => {
    expect(
      combineChunkTagAssessments(
        [observation("present", "absent"), observation("present", "absent")],
        ids,
      ).map((item) => item.state),
    ).toEqual(["present", "absent"])
  })
  it.each([
    observation("unknown", "unknown", "unknown"),
    observation("present", "unknown", "unknown"),
    observation("present", "absent", "absent", "partial"),
  ])("未知贡献或未覆盖材料阻止判为整篇纯推广", (unknown) => {
    const result = combineChunkTagAssessments([observation("present", "absent"), unknown], ids)
    expect(result.map((item) => item.state)).toEqual(["unknown", "unknown"])
  })
  it("部分覆盖仍可确认已读片段的教程存在，不能确认其他标签不存在", () => {
    const result = combineChunkTagAssessments(
      [observation("unknown", "present", "present", "partial")],
      ids,
    )
    expect(result.map((item) => item.state)).toEqual(["absent", "present"])
    expect(combineChunkTagAssessments([], ids).map((item) => item.state)).toEqual([
      "unknown",
      "unknown",
    ])
  })
  it("存在性正证采用可靠见证置信度，不被其他低置信度片段稀释", () => {
    const strong = observation("unknown", "present", "present")
    const weak = observation("unknown", "present", "unknown", "partial")
    weak.tagAssessments[1]!.confidence = 0.1
    expect(combineChunkTagAssessments([strong, weak], ids)[1]).toMatchObject({
      state: "present",
      confidence: 0.99,
    })
  })
  it("部分覆盖的否定判断不能推导整篇标签不存在", () => {
    expect(
      combineChunkTagAssessments([observation("absent", "absent", "unknown", "partial")], ids).map(
        (item) => item.state,
      ),
    ).toEqual(["unknown", "unknown"])
  })
})

describe("语义标签请求边界", () => {
  const catalog = createEvidenceCatalog("事实证据。")
  const schema = createTagAssessmentsSelectionSchema(catalog, ids)
  const valid = [
    assessment("signal:pure_promotion", "absent"),
    assessment("form:tutorial", "present"),
  ]
  it("要求唯一完整标签、当前定义版本与当前证据，并拒绝无证据正证", () => {
    expect(schema.safeParse(valid).success).toBe(true)
    for (const invalid of [
      [valid[0]],
      [valid[0], valid[0]],
      [valid[0], { ...valid[1], tagId: "topic:ai" }],
      [valid[0], { ...valid[1], definitionVersion: 2 }],
      [valid[0], { ...valid[1], evidenceIds: ["other"] }],
      [valid[0], { ...valid[1], evidenceIds: [] }],
    ])
      expect(schema.safeParse(invalid).success).toBe(false)
  })
  it("不请求标签时允许旧协议，提示包含完整客观定义与版本", () => {
    expect(createTagAssessmentsSelectionSchema(catalog, []).safeParse([]).success).toBe(true)
    expect(renderSemanticTagRequirements([])).toBe("")
    expect(renderSemanticTagRequirements(ids)).toContain('"definitionVersion":1')
    expect(renderSemanticTagRequirements(ids)).toContain("附带推广不等于纯推广")
    expect(() => renderSemanticTagRequirements(["missing"])).toThrow(
      "invalid_semantic_tag_definition",
    )
  })
})
