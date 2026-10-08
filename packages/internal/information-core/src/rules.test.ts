import { describe, expect, it } from "vitest"

import type { AutomationRule, Condition, MatchState, RuleInput, RuleSet } from "./rules"
import {
  andStates,
  compileInstructions,
  conditionSetSchema,
  matchConditions,
  orStates,
  requiredSemanticTagIds,
  ruleRequiresSemantics,
  ruleSetSchema,
  ruleUsesAI,
  visibleLength,
} from "./rules"
import type { TagAssessment } from "./semantic-tags"
import { semanticTagIds } from "./semantic-tags"

const input: RuleInput = {
  source_id: "feed/1",
  contextId: "feed/1",
  view: 0,
  category_ref: { view: 0, name: "Blockchain" },
  subscription_tag: [],
}
const when = (...conditions: Condition[]) => ({ anyOf: [{ allOf: conditions }] })
const rule = (
  id: string,
  order: number,
  actions: AutomationRule["actions"],
  conditions: AutomationRule["when"] = { all: true },
): AutomationRule => ({
  id,
  ownerId: "owner",
  name: id,
  enabled: true,
  order,
  when: conditions,
  actions,
  version: 1,
  executionLocation: "processing_service",
})
const rules = (...items: AutomationRule[]): RuleSet => ({
  formatVersion: 4,
  ownerId: "owner",
  global: { version: 1, markdown: "全局说明" },
  rules: items,
})

describe("三值条件与原文身份", () => {
  const states: MatchState[] = ["match", "no_match", "unknown"]
  it("AND/OR 全部真值组合符合 unknown 传播规则", () => {
    const andExpected = [
      "match",
      "no_match",
      "unknown",
      "no_match",
      "no_match",
      "no_match",
      "unknown",
      "no_match",
      "unknown",
    ]
    const orExpected = [
      "match",
      "match",
      "match",
      "match",
      "no_match",
      "unknown",
      "match",
      "unknown",
      "unknown",
    ]
    expect(states.flatMap((a) => states.map((b) => andStates([a, b])))).toEqual(andExpected)
    expect(states.flatMap((a) => states.map((b) => orStates([a, b])))).toEqual(orExpected)
  })
  it("ALL 显式匹配；空组、未知字段和半成品条件拒绝保存", () => {
    expect(matchConditions({ all: true }, input).state).toBe("match")
    for (const invalid of [
      { anyOf: [] },
      { anyOf: [{ allOf: [] }] },
      { all: true, anyOf: [] },
      { anyOf: [{ allOf: [{ field: "made_up", operator: "eq", value: "x" }] }] },
    ])
      expect(conditionSetSchema.safeParse(invalid).success).toBe(false)
  })
  it("全局 Prompt 可保存正整数预设来源版本", () => {
    expect(
      ruleSetSchema.safeParse({
        ...rules(),
        global: { version: 1, markdown: "说明", preset: { id: "P00", version: 2 } },
      }).success,
    ).toBe(true)
    expect(
      ruleSetSchema.safeParse({
        ...rules(),
        global: { version: 1, markdown: "说明", preset: { id: "P00", version: 0 } },
      }).success,
    ).toBe(false)
  })
  it("标签未加载不能命中否定条件；已加载空集可以", () => {
    const condition = when({
      field: "subscription_tag",
      operator: "not_contains_any",
      value: ["media"],
    })
    expect(matchConditions(condition, { ...input, subscription_tag: null }).state).toBe("unknown")
    expect(matchConditions(condition, input).state).toBe("match")
  })
  it("List 匹配成员资格而非路由，部分成员保留 unknown", () => {
    const condition = when({ field: "list_id", operator: "not_in", value: ["list-1", "list-2"] })
    expect(
      matchConditions(condition, { ...input, list_id: { "list-1": false, "list-2": null } }).state,
    ).toBe("unknown")
    expect(
      matchConditions(condition, { ...input, list_id: { "list-1": true, "list-2": null } }).state,
    ).toBe("no_match")
    expect(
      matchConditions(when({ field: "list_id", operator: "contains_any", value: ["list-1"] }), {
        ...input,
        list_id: { "list-1": true },
      }).state,
    ).toBe("match")
  })
  it("分类以视图和名称共同定位；来源改标题不改变 ID 命中", () => {
    expect(
      matchConditions(
        when({ field: "category_ref", operator: "eq", value: { view: 1, name: "Blockchain" } }),
        input,
      ).state,
    ).toBe("no_match")
    expect(
      matchConditions(when({ field: "source_id", operator: "in", value: ["feed/1"] }), {
        ...input,
        title: "改名",
      }).state,
    ).toBe("match")
  })
  it("未读与收藏独立，不因收藏覆盖已读状态", () => {
    expect(
      matchConditions(when({ field: "status", operator: "eq", value: "read" }), {
        ...input,
        read: true,
        collected: true,
      }).state,
    ).toBe("match")
    expect(
      matchConditions(when({ field: "status", operator: "not_eq", value: "collected" }), input)
        .state,
    ).toBe("unknown")
  })
  it("长度按 grapheme 去 URL/空白，49/50 严格边界，缺正文不是零", () => {
    const text = `${"你".repeat(48)}👨‍👩‍👧‍👦  https://example.com/a`
    expect(visibleLength(text, true)).toBe(49)
    expect(visibleLength("e\u0301", true)).toBe(1)
    expect(visibleLength(null, true)).toBeNull()
    expect(visibleLength("摘要", false)).toBeNull()
    const condition = when({ field: "visible_length", operator: "lt", value: 50 })
    expect(matchConditions(condition, { ...input, visible_length: 49 }).state).toBe("match")
    expect(matchConditions(condition, { ...input, visible_length: 50 }).state).toBe("no_match")
    expect(matchConditions(condition, { ...input, visible_length: null }).state).toBe("unknown")
  })
  it("正则有清晰错误，嵌套量词不会指数回溯", () => {
    expect(
      conditionSetSchema.safeParse(when({ field: "entry_content", operator: "regex", value: "(" }))
        .success,
    ).toBe(false)
    expect(
      conditionSetSchema.safeParse(
        when({ field: "entry_content", operator: "regex", value: "(x)\\1" }),
      ).success,
    ).toBe(false)
    expect(
      matchConditions(when({ field: "entry_content", operator: "regex", value: "^(a+)+$" }), {
        ...input,
        entry_content: `${"a".repeat(30000)}!`,
      }).state,
    ).toBe("no_match")
  })
})

describe("有效指令与字段优先级", () => {
  it("全局始终保留，多条 ALL 语义联合，显式值逐字段取首项", () => {
    const config = rules(
      rule("low", 2, [
        { type: "presentation", policy: { standalone: "never", aggregation: "deny" } },
        { type: "display", language: "en", summaryMaxGraphemes: 800 },
        { type: "ai_transform", prompt: "过滤娱乐" },
      ]),
      rule("high", 0, [
        { type: "presentation", policy: { standalone: "auto" } },
        { type: "display", language: "zh" },
        { type: "ai_transform", prompt: "保留重要短公告" },
      ]),
    )
    const bundle = compileInstructions(config, input)
    expect(bundle.global.markdown).toBe("全局说明")
    expect(bundle.policy).toEqual({ standalone: "auto", aggregation: "deny" })
    expect(bundle.display).toEqual({ language: "zh", summaryMaxGraphemes: 800 })
    expect(bundle.transformations.map((item) => item.ruleId)).toEqual(["high", "low"])
    expect(bundle.shadowed).toContainEqual({
      field: "standalone",
      ruleId: "low",
      winnerRuleId: "high",
    })
    expect(compileInstructions(rules(), input).global).toEqual(config.global)
  })
  it("unknown 语义/资格条件阻止最终隐藏和合并，纯显示条件不扩大阻塞", () => {
    const condition = when({ field: "subscription_tag", operator: "in", value: ["project"] })
    const bundle = compileInstructions(
      rules(rule("pending", 0, [{ type: "ai_transform", prompt: "重要公告保留" }], condition)),
      { ...input, subscription_tag: null },
    )
    expect(bundle.pendingRuleIds).toEqual(["pending"])
    expect(bundle.blocksFinalPresentation).toBe(true)
    expect(
      compileInstructions(
        rules(rule("language", 0, [{ type: "display", language: "zh" }], condition)),
        { ...input, subscription_tag: null },
      ).blocksFinalPresentation,
    ).toBe(false)
  })
  it("独立与综合互不推导；同一聚合动作共享创建/更新身份和范围", () => {
    const scope = when({ field: "source_id", operator: "in", value: ["feed/1", "feed/2"] })
    const bundle = compileInstructions(
      rules(
        rule("original", 0, [
          {
            type: "presentation",
            policy: { standalone: "always", aggregation: "allow", rewrite: "deny" },
          },
          {
            type: "ai_aggregate",
            createPrompt: "同事件整合",
            updatePrompt: "",
            mode: "same_event",
            scope,
          },
        ]),
      ),
      input,
    )
    expect(bundle.policy).toEqual({ standalone: "always", aggregation: "allow", rewrite: "deny" })
    expect(bundle.aggregates[0]).toMatchObject({
      ruleId: "original",
      scope,
      updatePrompt: "同事件整合",
    })
  })
  it("语义去重动作只暴露参与范围，且与聚合动作共存而不互相顶替", () => {
    const scope = when({ field: "category_ref", operator: "eq", value: { view: 0, name: "AI" } })
    const bundle = compileInstructions(
      rules(
        rule("dedupe", 0, [
          { type: "ai_dedupe", scope },
          {
            type: "ai_aggregate",
            createPrompt: "同事件整合",
            updatePrompt: "",
            mode: "same_event",
            scope: { all: true },
          },
        ]),
      ),
      input,
    )
    expect(bundle.dedupes).toEqual([{ ruleId: "dedupe", version: 1, order: 0, scope }])
    expect(bundle.aggregates).toHaveLength(1)
  })
  it("同规则里两个去重动作会被拒绝，不会悄悄取其一", () => {
    expect(
      ruleSetSchema.safeParse(
        rules(
          rule("dedupe", 0, [
            { type: "ai_dedupe", scope: { all: true } },
            { type: "ai_dedupe", scope: { all: true } },
          ]),
        ),
      ).success,
    ).toBe(false)
  })
  it("同规则重复字段、重复顺序、跨账号规则均拒绝，而不是末项获胜", () => {
    expect(
      ruleSetSchema.safeParse(
        rules(
          rule("bad", 0, [
            { type: "display", language: "zh" },
            { type: "display", language: "en" },
          ]),
        ),
      ).success,
    ).toBe(false)
    expect(
      ruleSetSchema.safeParse(
        rules(
          rule("a", 0, [{ type: "ai_transform", prompt: "a" }]),
          rule("b", 0, [{ type: "ai_transform", prompt: "b" }]),
        ),
      ).success,
    ).toBe(false)
    expect(
      ruleSetSchema.safeParse(
        rules({
          ...rule("a", 0, [{ type: "ai_transform", prompt: "a" }]),
          ownerId: "someone-else",
        }),
      ).success,
    ).toBe(false)
  })
})

// 使用真实版本和置信度覆盖语义条件，避免用标签字符串模拟已分析状态。
const assessment = (
  tagId: TagAssessment["tagId"],
  state: TagAssessment["state"] = "present",
  overrides: Partial<TagAssessment> = {},
): TagAssessment => ({
  tagId,
  definitionVersion: 1,
  state,
  confidence: 0.95,
  reason: "原文已按定义检查",
  evidenceIds: ["entry:1:body"],
  ...overrides,
})
const semanticWhen = (
  operator: "contains_any" | "contains_all" | "not_contains_any",
  value: TagAssessment["tagId"][] = ["signal:social_chatter"],
) => when({ field: "entry_tag", operator, value })
const semanticRules = (...items: AutomationRule[]): RuleSet => ({
  ...rules(...items),
  formatVersion: 5,
})

describe("v5 语义契约与阅读动作", () => {
  it("缺失、未知、旧定义、空置信度和低置信度不能命中正向或否定条件", () => {
    for (const entry_tag of [
      null,
      [],
      [assessment("signal:social_chatter", "unknown")],
      [assessment("signal:social_chatter", "absent", { definitionVersion: 2 })],
      [assessment("signal:social_chatter", "absent", { confidence: null })],
      [assessment("signal:social_chatter", "absent", { confidence: 0.89 })],
      [assessment("signal:social_chatter", "absent"), assessment("signal:social_chatter")],
    ])
      for (const operator of ["contains_any", "not_contains_any"] as const)
        expect(matchConditions(semanticWhen(operator), { ...input, entry_tag }).state).toBe(
          "unknown",
        )
    expect(
      matchConditions(semanticWhen("not_contains_any"), {
        ...input,
        entry_tag: [assessment("signal:social_chatter", "absent")],
      }).state,
    ).toBe("match")
    expect(
      matchConditions(semanticWhen("not_contains_any"), {
        ...input,
        entry_tag: [assessment("signal:social_chatter")],
      }).state,
    ).toBe("no_match")
  })
  it("ANY/ALL/否定组合按三态传播，显式阈值包含边界", () => {
    const value: TagAssessment["tagId"][] = ["signal:social_chatter", "signal:pure_promotion"]
    const present = { ...input, entry_tag: [assessment(value[0]!)] }
    expect(matchConditions(semanticWhen("contains_any", value), present).state).toBe("match")
    expect(matchConditions(semanticWhen("contains_all", value), present).state).toBe("unknown")
    expect(matchConditions(semanticWhen("not_contains_any", value), present).state).toBe("no_match")
    const absent = { ...input, entry_tag: [assessment(value[0]!, "absent")] }
    expect(matchConditions(semanticWhen("contains_all", value), absent).state).toBe("no_match")
    expect(matchConditions(semanticWhen("not_contains_any", value), absent).state).toBe("unknown")
    const condition = when({
      field: "entry_tag",
      operator: "contains_any",
      value: ["form:review"],
      minConfidence: 0.7,
    })
    expect(
      matchConditions(condition, {
        ...input,
        entry_tag: [assessment("form:review", "present", { confidence: 0.7 })],
      }).state,
    ).toBe("match")
  })
  it("v4 保持旧规则可解析，新条件/动作必须 v5，未知 ID 和空动作被拒绝", () => {
    const semantic = rule(
      "tag",
      0,
      [{ type: "reading_decision", visibility: "hide" }],
      semanticWhen("contains_any"),
    )
    expect(ruleSetSchema.safeParse(rules(semantic)).success).toBe(false)
    expect(ruleSetSchema.safeParse(semanticRules(semantic)).success).toBe(true)
    expect(
      ruleSetSchema.safeParse(
        rules(rule("legacy", 0, [{ type: "presentation", policy: { standalone: "never" } }])),
      ).success,
    ).toBe(true)
    expect(
      ruleSetSchema.safeParse(
        rules(rule("action", 0, [{ type: "reading_decision", visibility: "show" }])),
      ).success,
    ).toBe(false)
    expect(
      conditionSetSchema.safeParse({
        anyOf: [
          { allOf: [{ field: "entry_tag", operator: "contains_any", value: ["free-label"] }] },
        ],
      }).success,
    ).toBe(false)
    expect(
      ruleSetSchema.safeParse(semanticRules(rule("empty", 0, [{ type: "reading_decision" }])))
        .success,
    ).toBe(false)
    expect(
      ruleSetSchema.safeParse(
        semanticRules(
          rule("duplicate", 0, [
            { type: "presentation", policy: { standalone: "always" } },
            { type: "reading_decision", visibility: "hide" },
          ]),
        ),
      ).success,
    ).toBe(false)
  })
  it("新旧阅读动作逐字段按顺序取首项", () => {
    const bundle = compileInstructions(
      semanticRules(
        rule("legacy", 0, [{ type: "presentation", policy: { standalone: "always" } }]),
        rule("semantic", 1, [
          { type: "reading_decision", visibility: "hide", aggregationEligibility: "deny" },
        ]),
        rule("later", 2, [
          { type: "presentation", policy: { aggregation: "allow", rewrite: "deny" } },
        ]),
      ),
      input,
    )
    expect(bundle.policy).toEqual({ standalone: "always", aggregation: "deny", rewrite: "deny" })
    expect(bundle.resolvedBy).toEqual({
      standalone: "legacy",
      aggregation: "semantic",
      rewrite: "later",
    })
    expect(bundle.shadowed).toContainEqual({
      field: "standalone",
      ruleId: "semantic",
      winnerRuleId: "legacy",
    })
  })
  it("早期未知规则仅阻塞它会覆盖的字段；后期未知规则不阻塞已有赢家", () => {
    const unknown = semanticWhen("contains_any")
    const bundle = compileInstructions(
      semanticRules(
        rule("known", 1, [
          {
            type: "presentation",
            policy: { standalone: "always", aggregation: "allow", rewrite: "deny" },
          },
        ]),
        rule("early", 0, [{ type: "reading_decision", aggregationEligibility: "deny" }], unknown),
        rule("late", 2, [{ type: "reading_decision", visibility: "hide" }], unknown),
      ),
      input,
    )
    expect(bundle.pendingPolicyFields).toEqual(["aggregation"])
    expect(bundle.blocksFinalPresentation).toBe(true)
    expect(
      compileInstructions(
        semanticRules(
          rule("known", 0, [{ type: "presentation", policy: { standalone: "always" } }]),
          rule("late", 1, [{ type: "reading_decision", visibility: "hide" }], unknown),
        ),
        input,
      ).blocksFinalPresentation,
    ).toBe(false)
    expect(
      compileInstructions(
        semanticRules(rule("prompt", 0, [{ type: "ai_transform", prompt: "处理要求" }], unknown)),
        input,
      ).pendingPolicyFields,
    ).toEqual(["standalone", "aggregation", "rewrite"])
  })
  it("语义阅读依赖触发分类而不冒充 AI 动作，确定范围外的规则不扩大依赖", () => {
    const semantic = rule(
      "semantic",
      0,
      [{ type: "reading_decision", visibility: "hide" }],
      semanticWhen("contains_any"),
    )
    const outside = rule(
      "outside",
      1,
      [{ type: "reading_decision", visibility: "hide" }],
      when(
        { field: "source_id", operator: "in", value: ["feed/other"] },
        { field: "entry_tag", operator: "contains_any", value: ["form:pure_entertainment"] },
      ),
    )
    const aggregate = rule("scope", 2, [
      {
        type: "ai_aggregate",
        createPrompt: "综合",
        updatePrompt: "",
        mode: "topic",
        scope: semanticWhen("contains_any", ["topic:ai"]),
      },
    ])
    const disabled = {
      ...rule(
        "disabled",
        3,
        [{ type: "reading_decision", visibility: "hide" }],
        semanticWhen("contains_any", ["topic:music"]),
      ),
      enabled: false,
    }
    const config = semanticRules(semantic, outside, aggregate, disabled)
    expect(ruleRequiresSemantics(semantic)).toBe(true)
    expect(ruleUsesAI(semantic)).toBe(false)
    expect(ruleRequiresSemantics(aggregate)).toBe(true)
    expect(requiredSemanticTagIds(config, input)).toEqual(["signal:social_chatter", "topic:ai"])
    expect(requiredSemanticTagIds(config)).toEqual([
      "form:pure_entertainment",
      "signal:social_chatter",
      "topic:ai",
    ])
    const bundle = compileInstructions(config, input)
    expect(bundle.semanticTagIds).toEqual(["signal:social_chatter", "topic:ai"])
    expect(bundle.pendingRuleIds).toEqual(["semantic"])
  })
})

describe("独立标签分类动作", () => {
  it("当前全部稳定标签可配置，重复标签申请被拒绝", () => {
    // 验证真实内置清单，防止新增标签后固定数量上限再次阻止规则发布。
    const classifyRule = (tagIds: TagAssessment["tagId"][]) =>
      semanticRules(rule("classify-all", 0, [{ type: "ai_classify", tagIds }]))
    expect(ruleSetSchema.safeParse(classifyRule([...semanticTagIds])).success).toBe(true)
    expect(
      ruleSetSchema.safeParse(classifyRule([semanticTagIds[0], semanticTagIds[0]])).success,
    ).toBe(false)
  })
  it("按来源申请标签但不赋予隐藏、综述或变换权限，并要求 v5", () => {
    const classifier = rule(
      "classify",
      0,
      [{ type: "ai_classify", tagIds: ["topic:ai", "form:review"] }],
      when({ field: "source_id", operator: "in", value: ["feed/1"] }),
    )
    const config = { ...rules(classifier), formatVersion: 5 as const }
    expect(ruleSetSchema.safeParse({ ...config, formatVersion: 4 }).success).toBe(false)
    expect(ruleUsesAI(classifier)).toBe(true)
    expect(ruleRequiresSemantics(classifier)).toBe(true)
    const compiled = compileInstructions(config, input)
    expect(compiled.semanticTagIds).toEqual(["form:review", "topic:ai"])
    expect(compiled.policy).toEqual({})
    expect(compiled.transformations).toEqual([])
    expect(compiled.aggregates).toEqual([])
    expect(requiredSemanticTagIds(config, { ...input, source_id: "feed/other" })).toEqual([])
    expect(
      ruleSetSchema.safeParse({
        ...config,
        rules: [{ ...classifier, actions: [{ type: "ai_classify", tagIds: [] }] }],
      }).success,
    ).toBe(false)
  })
})
