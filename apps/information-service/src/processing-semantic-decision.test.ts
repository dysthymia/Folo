import type { RuleSet, TagAssessment } from "@follow/information-core"
import { describe, expect, it } from "vitest"

import type { EntryModelOutput, ProcessingDecision } from "./processing-decision"
import { createEntryModelSelectionSchema } from "./processing-decision"
import { createEvidenceCatalog } from "./processing-evidence"
import {
  createSemanticProfile,
  effectiveSemanticAssessments,
  projectSemanticDecision,
} from "./processing-semantic-decision"

const context = { source_id: "feed/1", contextId: "feed/1" }
const tag: TagAssessment = {
  tagId: "signal:pure_promotion",
  definitionVersion: 1,
  state: "present",
  confidence: 0.99,
  reason: "含推广。",
  evidenceIds: ["E000001"],
}
const config: RuleSet = {
  formatVersion: 5,
  ownerId: "owner",
  global: { version: 1, markdown: "" },
  rules: [
    {
      id: "noise",
      ownerId: "owner",
      version: 1,
      name: "隐藏纯推广",
      enabled: true,
      order: 0,
      executionLocation: "processing_service",
      when: {
        anyOf: [
          {
            allOf: [
              {
                field: "entry_tag",
                operator: "contains_any",
                value: [tag.tagId],
                minConfidence: 0.9,
              },
            ],
          },
        ],
      },
      actions: [{ type: "reading_decision", visibility: "hide" }],
    },
  ],
}
const output: EntryModelOutput = {
  entryId: "entry",
  title: "教程附推广",
  summary: "教程内容",
  disposition: "keep",
  reason: "保留原文",
  aggregation: false,
  rewrite: false,
  labels: [],
  facts: [],
  tagAssessments: [tag],
  entities: [],
  eventMentions: [],
  event: null,
  materialCoverage: "complete",
  substantiveContribution: {
    state: "present",
    confidence: 0.95,
    reason: "提供完整可用步骤。",
    evidenceIds: ["E000001"],
  },
}
function decision(value: EntryModelOutput): ProcessingDecision {
  return {
    schemaVersion: 2,
    fingerprint: "test",
    provider: "codex",
    model: "test",
    generatedAt: "2026-10-08T00:00:00Z",
    durationMs: 0,
    usage: null,
    status: "keep",
    title: value.title,
    summary: value.summary,
    reason: value.reason,
    labels: [],
    facts: [],
    policy: { standalone: "auto", aggregation: "deny", rewrite: "deny" },
    sourceRole: "unknown",
    context,
    semantic: value,
    semanticProfile: createSemanticProfile({
      contentVersion: "v1",
      text: "提供完整可用步骤。",
      output: value,
      evidence: { E000001: "提供完整可用步骤。" },
    }),
    reused: false,
  }
}

describe("材料、标签与策略的独立语义", () => {
  it("完整材料但unknown标签只使评估partial；旧coverage仍合并兼容", () => {
    const value = decision({
      ...output,
      tagAssessments: [{ ...tag, state: "unknown", confidence: null }],
    })
    expect(value.semanticProfile).toMatchObject({
      materialCoverage: "complete",
      semanticAssessmentCoverage: "partial",
      coverage: "partial",
    })
    const projected = projectSemanticDecision(value, config, context)
    expect(projected).toMatchObject({
      status: "keep",
      pendingPolicyFields: ["standalone"],
      policy: { standalone: "always" },
    })
    expect(projected.reason).toContain("阅读策略待定")
  })
  it("缺失外部材料与已知标签分别保存，并且真正needs_context保持不变", () => {
    const value = decision({ ...output, materialCoverage: "partial", disposition: "needs_context" })
    expect(value.semanticProfile).toMatchObject({
      materialCoverage: "partial",
      semanticAssessmentCoverage: "complete",
      coverage: "partial",
    })
    expect(projectSemanticDecision(value, config, context).status).toBe("needs_context")
  })
  it("普通单篇已证实贡献与纯噪声冲突时保持可读，原档案保留模型正证", () => {
    const value = decision(output)
    const projected = projectSemanticDecision(value, config, context)
    expect(projected.status).toBe("keep")
    expect(projected.context.entry_tag?.[0]).toMatchObject({ state: "unknown", confidence: null })
    expect(projected.semanticProfile?.assessments[0]).toMatchObject({ state: "present" })
    expect(projected.semanticProfile?.substantiveContribution).toEqual(
      output.substantiveContribution,
    )
    expect(projected.reason).toContain("实质贡献冲突")
    const effective = effectiveSemanticAssessments(
      value.semanticProfile!.assessments,
      [],
      value.semanticProfile?.substantiveContribution,
    )
    expect(effective[0]).toMatchObject({
      state: "unknown",
      reason: expect.stringContaining("实质贡献冲突"),
    })
  })
  it("低置信贡献不能擅自否定噪声；可靠教程正证仍保护原文", () => {
    const weak = decision({
      ...output,
      tagAssessments: [...output.tagAssessments!],
      substantiveContribution: { ...output.substantiveContribution!, confidence: 0.2 },
    })
    expect(projectSemanticDecision(weak, config, context).status).toBe("hide")
    weak.semanticProfile!.assessments.push({
      ...tag,
      tagId: "form:tutorial",
      reason: "完整教程步骤。",
    })
    expect(projectSemanticDecision(weak, config, context).status).toBe("keep")
  })
  it("新请求贡献必须来自当前证据，旧持久化输出仍可读取", () => {
    const schema = createEntryModelSelectionSchema(
      "entry",
      createEvidenceCatalog("提供完整可用步骤。"),
      [tag.tagId],
    )
    expect(schema.safeParse(output).error).toBeUndefined()
    expect(
      schema.safeParse({
        ...output,
        substantiveContribution: { ...output.substantiveContribution, evidenceIds: ["other"] },
      }).success,
    ).toBe(false)
    const { substantiveContribution: _contribution, materialCoverage: _coverage, ...old } = output
    expect(schema.safeParse(old).success).toBe(false)
    expect(decision(old).semanticProfile?.substantiveContribution).toBeUndefined()
  })
})
