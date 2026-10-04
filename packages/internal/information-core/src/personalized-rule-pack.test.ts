import { describe, expect, it } from "vitest"

import {
  appendPersonalizedRulePack,
  createPersonalizedRulePack,
  previewPersonalizedRuleConditions,
  updatePersonalizedRuleConditions,
} from "./personalized-rule-pack"
import { applyPreset, preset } from "./presets"
import type { RuleSet } from "./rules"
import { compileInstructions, ruleSetSchema } from "./rules"

const empty: RuleSet = {
  formatVersion: 4,
  ownerId: "owner",
  global: { markdown: "私人全局要求", version: 1 },
  rules: [],
}

describe("个性化规则默认集", () => {
  it("真实标签名称解析成ID，领域规则不全局强设展示，只有一条同事件归属", () => {
    const pack = createPersonalizedRulePack({
      ownerId: "owner",
      tagCatalog: [
        { id: "airdrop-real-id", name: "Crypto-撸毛" },
        { id: "official-real-id", name: "Crypto-项目方" },
        { id: "ai-real-id", name: "AI-产品工具" },
        { id: "growth-real-id", name: "个人成长" },
      ],
    })
    const rules = appendPersonalizedRulePack(empty, pack)
    expect(ruleSetSchema.safeParse(rules).success).toBe(true)
    expect(rules.rules).toHaveLength(7)
    const airdrop = rules.rules.find((rule) => rule.id === "personalized:R20")!
    expect(airdrop.when).toEqual({
      anyOf: [
        {
          allOf: [
            {
              field: "subscription_tag",
              operator: "in",
              value: ["airdrop-real-id", "official-real-id"],
            },
          ],
        },
      ],
    })
    expect(rules.rules.find((rule) => rule.id === "personalized:R60")?.enabled).toBe(false)
    expect(
      rules.rules
        .flatMap((rule) => rule.actions)
        .filter((action) => action.type === "ai_aggregate"),
    ).toHaveLength(1)
    expect(
      rules.rules.flatMap((rule) => rule.actions).some((action) => action.type === "presentation"),
    ).toBe(false)
    expect(pack.unresolvedTagNames).toContain("Crypto-投研")
    expect(pack.omittedPresetIds).toEqual([])
  })

  it("缺标签明确列出而不伪造ID，全局兜底保留跨领域内容", () => {
    const pack = createPersonalizedRulePack({ ownerId: "owner", tagCatalog: [] })
    expect(pack.rules.map((rule) => rule.id)).toEqual(["personalized:R10", "personalized:R90"])
    expect(pack.omittedPresetIds).toEqual(["R20", "R30", "R40", "R50", "R60"])
    const config = appendPersonalizedRulePack(empty, pack)
    const instructions = compileInstructions(config, {
      source_id: "unrelated",
      contextId: "unrelated",
      subscription_tag: [],
    })
    expect(instructions.transformations[0]?.prompt).toContain("领取开放")
    expect(instructions.global.markdown).toContain("Crypto 账号里的 AI 教程")
    expect(instructions.policy).toEqual({})
    expect(instructions.blocksFinalPresentation).toBe(false)
  })

  it("重复导入或后续补标签保留私人编辑，不重复G00或综述规则", () => {
    const pack = createPersonalizedRulePack({ ownerId: "owner", tagCatalog: [] })
    const initial = appendPersonalizedRulePack(empty, pack)
    expect(initial.global.markdown).toMatch(/^私人全局要求\n\n/)
    expect(empty.global.markdown).toBe("私人全局要求")
    initial.rules[0]!.actions = [{ type: "ai_transform", prompt: "我编辑的去噪要求" }]
    expect(appendPersonalizedRulePack(initial, pack)).toEqual(initial)
    const expanded = appendPersonalizedRulePack(
      initial,
      createPersonalizedRulePack({
        ownerId: "owner",
        tagCatalog: [{ id: "ai-real-id", name: "AI-产品工具" }],
      }),
    )
    expect(expanded.global).toEqual(initial.global)
    expect(expanded.rules.find((rule) => rule.id === "personalized:R10")?.actions).toEqual(
      initial.rules[0]!.actions,
    )
    expect(expanded.rules.filter((rule) => rule.id === "personalized:R90")).toHaveLength(1)
    expect(expanded.rules.find((rule) => rule.id === "personalized:R40")).toBeDefined()
    expect(() => appendPersonalizedRulePack({ ...empty, ownerId: "other" }, pack)).toThrow(
      "personalized_pack_owner_mismatch",
    )
  })

  // 用真实 ID 扩充现有领域条件，私人动作及其他过滤必须保持不变。
  it("预览新增标签并只将明确选中的条件更新到草稿", () => {
    const current = appendPersonalizedRulePack(
      empty,
      createPersonalizedRulePack({
        ownerId: "owner",
        tagCatalog: [{ id: "old-ai", name: "AI-产品工具" }],
      }),
    )
    const rule = current.rules.find((item) => item.id === "personalized:R40")!
    rule.enabled = false
    rule.name = "私人 AI 规则"
    rule.version = 8
    rule.actions = [{ type: "ai_transform", prompt: "私人 Prompt" }]
    if ("anyOf" in rule.when)
      rule.when.anyOf[0]!.allOf.push({
        field: "entry_author",
        operator: "not_eq",
        value: "excluded-author",
      })
    const expanded = createPersonalizedRulePack({
      ownerId: "owner",
      tagCatalog: [
        { id: "old-ai", name: "AI-产品工具" },
        { id: "new-ai", name: "AI-研究前沿" },
      ],
    })
    const [diff] = previewPersonalizedRuleConditions(current, expanded)
    expect(diff).toMatchObject({
      ruleId: rule.id,
      addedTagIds: ["new-ai"],
      removedTagIds: [],
      requiresManualEdit: false,
    })
    expect(updatePersonalizedRuleConditions(current, expanded, [])).toEqual(current)
    const saved = updatePersonalizedRuleConditions(current, expanded, [rule.id])
    const updated = saved.rules.find((item) => item.id === rule.id)!
    expect({ ...updated, when: rule.when, version: rule.version }).toEqual(rule)
    expect(updated.version).toBe(9)
    expect(updated.when).toEqual({
      anyOf: [
        {
          allOf: [
            { field: "subscription_tag", operator: "in", value: ["old-ai", "new-ai"] },
            { field: "entry_author", operator: "not_eq", value: "excluded-author" },
          ],
        },
      ],
    })
    expect(saved.global).toEqual(current.global)
    expect(previewPersonalizedRuleConditions(saved, expanded)).toEqual([])
    expect(rule.version).toBe(8)
  })

  it("替换旧标签 ID 能预览增删，缺失标签不会自动改成全来源", () => {
    const current = appendPersonalizedRulePack(
      empty,
      createPersonalizedRulePack({
        ownerId: "owner",
        tagCatalog: [{ id: "old-id", name: "AI-产品工具" }],
      }),
    )
    const replacement = createPersonalizedRulePack({
      ownerId: "owner",
      tagCatalog: [{ id: "new-id", name: "AI-产品工具" }],
    })
    expect(previewPersonalizedRuleConditions(current, replacement)[0]).toMatchObject({
      addedTagIds: ["new-id"],
      removedTagIds: ["old-id"],
    })
    expect(
      previewPersonalizedRuleConditions(
        current,
        createPersonalizedRulePack({ ownerId: "owner", tagCatalog: [] }),
      ),
    ).toEqual([])
    expect(() =>
      updatePersonalizedRuleConditions(current, replacement, ["personalized:R10"]),
    ).toThrow("personalized_pack_condition_diff_unavailable")
    expect(() =>
      previewPersonalizedRuleConditions({ ...current, ownerId: "other" }, replacement),
    ).toThrow("personalized_pack_owner_mismatch")
  })

  it("复杂手工逻辑仅预览，不允许一键覆盖私人条件", () => {
    const pack = createPersonalizedRulePack({
      ownerId: "owner",
      tagCatalog: [{ id: "ai", name: "AI-产品工具" }],
    })
    const current = appendPersonalizedRulePack(empty, pack)
    const rule = current.rules.find((item) => item.id === "personalized:R40")!
    rule.when = {
      anyOf: [{ allOf: [{ field: "subscription_tag", operator: "not_in", value: ["excluded"] }] }],
    }
    expect(previewPersonalizedRuleConditions(current, pack)[0]?.requiresManualEdit).toBe(true)
    expect(() => updatePersonalizedRuleConditions(current, pack, [rule.id])).toThrow(
      "personalized_pack_condition_diff_unavailable",
    )
    rule.when = { all: true }
    expect(previewPersonalizedRuleConditions(current, pack)[0]?.requiresManualEdit).toBe(true)
    expect(updatePersonalizedRuleConditions(current, pack, []).rules).toEqual(current.rules)
  })

  it("已有同事件规则保留其私人Prompt，不导入第二条竞争主归属", () => {
    const existing: RuleSet = {
      ...empty,
      rules: [
        {
          id: "mine",
          ownerId: "owner",
          name: "我的综述",
          enabled: true,
          order: 3,
          when: { all: true },
          version: 1,
          executionLocation: "processing_service",
          actions: [
            {
              type: "ai_aggregate",
              mode: "same_event",
              scope: { all: true },
              createPrompt: "我的创建要求",
              updatePrompt: "我的更新要求",
            },
          ],
        },
      ],
    }
    const result = appendPersonalizedRulePack(
      existing,
      createPersonalizedRulePack({ ownerId: "owner", tagCatalog: [] }),
    )
    expect(result.rules[0]).toEqual(existing.rules[0])
    expect(
      result.rules
        .flatMap((rule) => rule.actions)
        .filter((action) => action.type === "ai_aggregate"),
    ).toHaveLength(1)
  })

  it("新预设可独立应用，不继承旧短文长度门槛或整个来源总是显示", () => {
    for (const id of ["G00", "R10", "R20", "R30", "R40", "R50", "R60", "R90-C", "R90-U"] as const) {
      const application = applyPreset(id)
      expect(application.presentation).toBeUndefined()
      expect(application.prompt).toBe(preset(id).prompt)
    }
    expect(applyPreset("R10").prompt).toContain("纯噪声隐藏并禁止整合")
  })
})
