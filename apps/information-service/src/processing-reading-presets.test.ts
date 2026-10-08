import type { RuleSet, SemanticTagId } from "@follow/information-core"
import {
  compileInstructions,
  semanticTagDefinition,
  semanticTagIds,
} from "@follow/information-core"
import { describe, expect, it } from "vitest"

import { convergedReadingRules, readingPoolCategories } from "./processing-reading-presets"

const previous: RuleSet = {
  formatVersion: 5,
  ownerId: "owner",
  global: { version: 1, markdown: "忠于原文" },
  rules: [
    {
      id: "dedupe",
      name: "去重",
      enabled: true,
      order: 0,
      ownerId: "owner",
      version: 1,
      executionLocation: "processing_service",
      when: { all: true },
      actions: [{ type: "ai_dedupe", scope: { all: true } }],
    },
    {
      id: "story",
      name: "综述",
      enabled: true,
      order: 1,
      ownerId: "owner",
      version: 1,
      executionLocation: "processing_service",
      when: { all: true },
      actions: [
        { type: "presentation", policy: { standalone: "auto", aggregation: "allow" } },
        {
          type: "ai_aggregate",
          mode: "same_event",
          scope: { all: true },
          createPrompt: "事实引用",
          updatePrompt: "保存变化",
        },
      ],
    },
    {
      id: "classify",
      name: "分类",
      enabled: true,
      order: 2,
      ownerId: "owner",
      version: 1,
      executionLocation: "processing_service",
      when: { all: true },
      actions: [{ type: "ai_classify", tagIds: ["topic:ai"] }],
    },
    {
      id: "dim",
      name: "虚化",
      enabled: true,
      order: 3,
      ownerId: "owner",
      version: 1,
      executionLocation: "processing_service",
      when: { all: true },
      actions: [{ type: "local_filter", mode: "dim" }],
    },
  ],
}
const config = convergedReadingRules(previous)
const input = (present: SemanticTagId[], missing: SemanticTagId[] = []) => ({
  source_id: "feed/1",
  contextId: "feed/1",
  view: 0,
  category_ref: { view: 0, name: "AI" },
  subscription_tag: [],
  entry_tag: semanticTagIds
    .filter((id) => !missing.includes(id))
    .map((tagId) => ({
      tagId,
      state: present.includes(tagId) ? ("present" as const) : ("absent" as const),
      confidence: 0.98,
      definitionVersion: semanticTagDefinition(tagId)!.definitionVersion,
      reason: "有原文依据",
      evidenceIds: present.includes(tagId) ? ["source:1"] : [],
    })),
})

describe("阅读规则收敛", () => {
  it("分类去重综述共享范围，保留综述提示而不抢占展示策略", () => {
    for (const category of readingPoolCategories) {
      const plan = compileInstructions(config, {
        ...input([]),
        view: category.view,
        category_ref: { ...category },
      })
      expect(plan.matched.map((rule) => rule.id)).toEqual(
        expect.arrayContaining(["dedupe", "story", "classify"]),
      )
      expect(plan.policy).toEqual({})
    }
    expect(config.global.markdown).toContain("忠于原文")
    expect(convergedReadingRules(config)).toEqual(config)
  })
  it("高置信纯噪声隐藏，教程/实测和未知贡献保持可读", () => {
    expect(compileInstructions(config, input(["signal:pure_promotion"])).policy).toEqual({
      standalone: "never",
      aggregation: "deny",
      rewrite: "deny",
    })
    expect(
      compileInstructions(config, input(["signal:pure_promotion", "form:tutorial"])).policy
        .standalone,
    ).toBeUndefined()
    const pending = compileInstructions(config, input(["signal:pure_promotion"], ["form:tutorial"]))
    expect(pending.policy.standalone).toBeUndefined()
    expect(pending.pendingPolicyFields).toContain("standalone")
  })
  it("关注提示不阻止去重，不猜测关注资产", () => {
    const plan = compileInstructions(config, input(["event:security_incident"]))
    expect(
      plan.matched.flatMap((rule) => rule.actions).filter((action) => action.type === "attention"),
    ).toHaveLength(1)
    expect(plan.policy.standalone).toBeUndefined()
    expect(config.global.attention?.watchlist).toEqual([])
  })
})
