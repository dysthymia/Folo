import type { AutomationRule } from "@follow/information-core"
import { ruleUsesAI } from "@follow/information-core"
import { describe, expect, it } from "vitest"

import { localRuleUsesAI } from "./local-rule-model"

// 卡片显示包含分类处理，但不扩大后台内容生成或故事资格。
describe("规则卡片处理标签", () => {
  const rule = (actions: AutomationRule["actions"]): AutomationRule => ({
    id: "rule",
    ownerId: "owner",
    name: "规则",
    enabled: true,
    version: 1,
    order: 0,
    executionLocation: "processing_service",
    when: { all: true },
    actions,
  })
  it("分类动作显示包含AI处理，后台ruleUsesAI保留原定义", () => {
    const classified = rule([{ type: "ai_classify", tagIds: ["event:security_incident"] }])
    expect(localRuleUsesAI(classified)).toBe(true)
    expect(ruleUsesAI(classified)).toBe(true)
    expect(
      localRuleUsesAI(rule([{ type: "attention", level: "important", reason: "有关实质变化" }])),
    ).toBe(false)
  })
})
