import type { RuleSet } from "@follow/information-core"
import { ruleSetSchema } from "@follow/information-core"
import { describe, expect, it } from "vitest"

import { createSemanticNoiseDraft, upgradeSemanticDraft } from "./processing-semantic-draft"

const draft: RuleSet = {
  formatVersion: 4,
  ownerId: "owner",
  global: { markdown: "", version: 1 },
  rules: [],
}

describe("semantic processing drafts", () => {
  it("保留旧规则格式且不降级已有格式5", () => {
    expect(upgradeSemanticDraft(draft)).toBe(draft)
    const newer = { ...draft, formatVersion: 5 as const }
    expect(upgradeSemanticDraft(newer)).toBe(newer)
  })

  it("模板不启用或推断全来源，明确选来源后格式5才可保存", () => {
    const rule = createSemanticNoiseDraft(draft, "noise", "Noise")
    expect(rule.enabled).toBe(false)
    if (!("anyOf" in rule.when)) throw new Error("unexpected condition")
    expect(rule.when.anyOf[0]!.allOf[0]).toMatchObject({ field: "source_id", value: [] })
    const config = upgradeSemanticDraft({ ...draft, rules: [rule] })
    expect(config.formatVersion).toBe(5)
    expect(ruleSetSchema.safeParse(config).success).toBe(false)
    if (!("anyOf" in rule.when)) throw new Error("unexpected condition")
    rule.when.anyOf[0]!.allOf[0] = {
      field: "source_id",
      operator: "in",
      value: ["feed/authorized"],
    }
    expect(ruleSetSchema.safeParse(config).success).toBe(true)
    expect(ruleSetSchema.safeParse({ ...config, formatVersion: 4 }).success).toBe(false)
  })

  it("尚未选标签的条件也升级，阅读动作与聚合子条件同样升级", () => {
    const rule = createSemanticNoiseDraft(draft, "rule", "Rule")
    rule.when = {
      anyOf: [{ allOf: [{ field: "entry_tag", operator: "contains_any", value: [] }] }],
    }
    rule.actions = [{ type: "display", language: "en" }]
    expect(upgradeSemanticDraft({ ...draft, rules: [rule] }).formatVersion).toBe(5)
    rule.when = { all: true }
    rule.actions = [{ type: "reading_decision", visibility: "show" }]
    expect(upgradeSemanticDraft({ ...draft, rules: [rule] }).formatVersion).toBe(5)
    rule.actions = [
      {
        type: "ai_dedupe",
        scope: {
          anyOf: [
            { allOf: [{ field: "entry_tag", operator: "contains_any", value: ["topic:ai"] }] },
          ],
        },
      },
    ]
    expect(upgradeSemanticDraft({ ...draft, rules: [rule] }).formatVersion).toBe(5)
  })
})
