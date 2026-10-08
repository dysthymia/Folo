import type {
  AutomationRule,
  Condition,
  ConditionSet,
  RuleSet,
  SemanticTagId,
} from "@follow/information-core"
import { ruleSetSchema, semanticTagIds } from "@follow/information-core"

// 分类、去重、同事件综述共享动态分类范围，后来加入这些分类的来源自动生效。
export const readingPoolCategories = [
  { view: 0, name: "Blockchain" },
  { view: 1, name: "X" },
  { view: 0, name: "AI" },
  { view: 0, name: "个人成长" },
  { view: 1, name: "个人成长" },
  { view: 0, name: "创业" },
] as const

const noise: SemanticTagId[] = [
  "form:pure_entertainment",
  "signal:social_chatter",
  "signal:empty_opinion",
  "signal:pure_promotion",
]
const contribution: SemanticTagId[] = [
  "signal:original_data",
  "signal:reasoned_analysis",
  "form:tutorial",
  "form:review",
  "signal:concrete_experience",
  "event:product_launch",
  "event:feature_update",
  "event:incentive_airdrop",
  "event:security_incident",
  "event:tokenomics_change",
  "event:listing_trading_support",
  "event:regulation",
  "event:macro_change",
]

function inPool(...extra: Condition[]): ConditionSet {
  return {
    anyOf: readingPoolCategories.map((category) => ({
      allOf: [{ field: "category_ref", operator: "eq", value: { ...category } }, ...extra],
    })),
  }
}
const tags = (
  value: SemanticTagId[],
  minConfidence: number,
  operator: "contains_any" | "not_contains_any" = "contains_any",
): Condition => ({ field: "entry_tag", operator, value, minConfidence })

export function convergedReadingRules(previous: RuleSet): RuleSet {
  const original = previous.rules
  const dedupe = original.find((rule) => rule.actions.some((action) => action.type === "ai_dedupe"))
  const aggregate = original.find((rule) =>
    rule.actions.some((action) => action.type === "ai_aggregate" && action.mode === "same_event"),
  )
  const classify = original.find((rule) =>
    rule.actions.some((action) => action.type === "ai_classify"),
  )
  const dim = original.find((rule) =>
    rule.actions.some((action) => action.type === "local_filter" && action.mode === "dim"),
  )
  if (!dedupe || !aggregate || !classify || !dim) throw new Error("reading_baseline_rules_missing")
  const aggregation = aggregate.actions.find((action) => action.type === "ai_aggregate")!
  const make = (
    id: string,
    name: string,
    when: ConditionSet,
    actions: AutomationRule["actions"],
  ): AutomationRule => ({
    id,
    name,
    ownerId: previous.ownerId,
    enabled: true,
    order: 0,
    when,
    actions,
    version: 1,
    executionLocation: "processing_service",
  })
  const additions: AutomationRule[] = [
    // 隐藏只接受高置信纯噪声，同时要求贡献标签明确否定；缺标签不会等同于无贡献。
    make(
      "reading-confirmed-noise-v1",
      "已确认纯噪声：隐藏并排除综述",
      inPool(tags(noise, 0.95), tags(contribution, 0.8, "not_contains_any")),
      [
        { type: "reading_decision", visibility: "hide", aggregationEligibility: "deny" },
        { type: "presentation", policy: { rewrite: "deny" } },
      ],
    ),
    make(
      dim.id,
      "疑似纯噪声：虚化并保留原文",
      inPool(tags(noise, 0.8), tags(contribution, 0.8, "not_contains_any")),
      [
        { type: "local_filter", mode: "dim" },
        { type: "presentation", policy: { aggregation: "deny", rewrite: "deny" } },
      ],
    ),
    make(
      "reading-security-attention-v1",
      "安全事件重点关注",
      inPool(tags(["event:security_incident"], 0.9)),
      [
        {
          type: "attention",
          level: "urgent",
          reason: "原文支持的安全事件，请核对影响范围与官方说明。",
        },
      ],
    ),
    make(
      "reading-important-attention-v1",
      "可行动事件与实用经验重点关注",
      inPool(
        tags(
          [
            "event:incentive_airdrop",
            "event:tokenomics_change",
            "event:listing_trading_support",
            "event:regulation",
            "event:macro_change",
            "form:tutorial",
            "form:review",
            "signal:concrete_experience",
          ],
          0.9,
        ),
      ),
      [
        {
          type: "attention",
          level: "important",
          reason: "有明确事件变化或可用方法，保留来源、适用条件与时间信息。",
        },
      ],
    ),
    // 综述不预先赋值 auto/allow，避免抢占噪声规则的逐字段决定。
    make(dedupe.id, "内容池：语义去重", inPool(), [{ type: "ai_dedupe", scope: inPool() }]),
    make(aggregate.id, "内容池：同事件综述", inPool(), [{ ...aggregation, scope: inPool() }]),
    make(classify.id, "内容池：新内容语义分类", inPool(), [
      { type: "ai_classify", tagIds: [...semanticTagIds] },
    ]),
  ]
  const migrated = new Set([
    dedupe.id,
    aggregate.id,
    classify.id,
    dim.id,
    ...additions.map((rule) => rule.id),
  ])
  const rules = [...additions, ...original.filter((rule) => !migrated.has(rule.id))].map(
    (rule, order) => ({ ...rule, order }),
  )
  const extra =
    "\n\n阅读贡献要求：短公告、数据、反证、教程、评测和具体经验同样可以有价值；缺少图片、串文、音视频或外链材料时说明缺口。AI 工具、产品与成长内容若原文包含实操步骤、失败经验、适用条件或成本，可在事实摘要中提炼，不能自行生成建议或收益承诺。多事件文章按对应片段与事实引用参与综述，保留各事件区别与原文阅读入口。重点关注只提示阅读优先级，不代表持仓建议，不强制原文独立展示。"
  return ruleSetSchema.parse({
    ...previous,
    formatVersion: 5,
    global: {
      ...previous.global,
      markdown: previous.global.markdown.includes("阅读贡献要求：")
        ? previous.global.markdown
        : previous.global.markdown + extra,
      attention: previous.global.attention ?? {
        enabled: true,
        watchlist: [],
        nearDeadlineHours: 48,
      },
    },
    rules,
  })
}
