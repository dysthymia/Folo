import type { AutomationRule } from "@follow/information-core"
import { describe, expect, it } from "vitest"

import { localRuleConditionSummary, localRulePublicationState } from "./local-rule-feedback"

const rule: AutomationRule = {
  id: "rule",
  ownerId: "owner",
  name: "规则",
  enabled: true,
  version: 1,
  order: 0,
  executionLocation: "processing_service",
  when: { all: true },
  actions: [{ type: "ai_transform", prompt: "保留事实" }],
}

describe("规则实际生效反馈", () => {
  it("草稿 enabled 不会冒充已启用，停用修改必须区分尚未发布", () => {
    expect(localRulePublicationState(rule, undefined)).toBe("draft")
    expect(localRulePublicationState(rule, { ...rule, version: 4 })).toBe("active")
    expect(localRulePublicationState({ ...rule, enabled: false }, rule)).toBe("pending")
    expect(
      localRulePublicationState({ ...rule, enabled: false }, { ...rule, enabled: false }),
    ).toBe("disabled")
    expect(
      localRulePublicationState(
        { ...rule, actions: [{ type: "ai_transform", prompt: "新要求" }] },
        rule,
      ),
    ).toBe("pending")
  })
  it("条件摘要使用真实名称，并保留多分支关系和否定操作", () => {
    const summary = localRuleConditionSummary(
      {
        anyOf: [
          {
            allOf: [
              { field: "subscription_tag", operator: "in", value: ["tag"] },
              { field: "source_id", operator: "not_in", value: ["feed/1"] },
            ],
          },
          { allOf: [{ field: "view", operator: "eq", value: 1 }] },
        ],
      },
      {
        sources: [{ key: "feed/1", title: "来源一" }] as never,
        subscriptionTags: { tags: [{ id: "tag", name: "AI 工具" }] } as never,
      },
      (key) => key,
    )
    expect(summary).toContain("AI 工具")
    expect(summary).toContain("来源一")
    expect(summary).toContain("processing.operator.not_in")
    expect(summary).toContain("automation.feedback.and")
    expect(summary).toContain("automation.feedback.or")
  })
})
