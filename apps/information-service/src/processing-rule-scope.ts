import type { AutomationRule, RuleInput, RuleSet } from "@follow/information-core"
import { matchConditions, ruleRequiresSemantics, ruleUsesAI } from "@follow/information-core"

import { processingRuleInput } from "./processing-context"
import type { Store } from "./store"

// 选源阶段只排除确定不匹配者；文章正文、作者等未知字段不能被当成 false。
export function resolveAIRuleSourceKeys(
  store: Store,
  config = store.automation.effective().config,
): string[] {
  const rules =
    config?.rules.filter(
      (rule) => rule.enabled && (ruleUsesAI(rule) || ruleRequiresSemantics(rule)),
    ) ?? []
  if (!rules.length) return []
  return store
    .sources()
    .filter((source) => {
      // 派生综述只参与阅读，不能被原文规则重新选中。
      if (source.origin === "generated" || source.key.startsWith("generated:")) return false
      const context = processingRuleInput(
        store,
        source.key,
        {
          id: "scope-preview",
          sourceKey: source.key,
          title: "",
          url: null,
          publishedAt: "1970-01-01T00:00:00.000Z",
          read: null,
          content: null,
          description: null,
        },
        null,
        false,
      )
      // 假条目只用于读取真实订阅身份，所有文章字段保持未知。
      context.entry_title = null
      context.entry_content = null
      context.entry_url = null
      context.entry_author = null
      // 即使条目构造器以后增加默认值，选源阶段也不能把尚未抓取的文章当成零字或缺失。
      context.language = null
      context.read = null
      context.collected = null
      context.entry_media_length = null
      context.entry_attachments_duration = null
      context.updated_at = null
      context.content_completeness = null
      context.visible_length = null
      context.platform = source.platform ?? null
      return rules.some((rule) => matchConditions(rule.when, context).state !== "no_match")
    })
    .map((source) => source.key)
    .sort()
}

// 语义条件本身可要求分类；未知不能被当作未命中而失去首次处理机会。
function pendingSemanticDependency(rule: AutomationRule, context: RuleInput): boolean {
  const conditions = [
    rule.when,
    ...rule.actions.flatMap((action) =>
      action.type === "ai_aggregate" || action.type === "ai_dedupe" ? [action.scope] : [],
    ),
  ]
  return conditions.some((set) => {
    if ("all" in set || matchConditions(set, context).state === "no_match") return false
    return set.anyOf.some(
      (group) =>
        matchConditions({ anyOf: [group] }, context).state !== "no_match" &&
        group.allOf.some(
          (condition) =>
            condition.field === "entry_tag" &&
            matchConditions({ anyOf: [{ allOf: [condition] }] }, context).state === "unknown",
        ),
    )
  })
}

export function matchesAIRule(config: RuleSet, context: RuleInput): boolean {
  return config.rules.some((rule) => {
    if (!rule.enabled) return false
    const match = matchConditions(rule.when, context).state
    if (ruleUsesAI(rule) && match === "match") return true
    return (
      match !== "no_match" &&
      ruleRequiresSemantics(rule) &&
      pendingSemanticDependency(rule, context)
    )
  })
}

export function activateRuleSchedule(store: Store) {
  const previous = store.schedule.snapshot()
  const active = store.automation.effective().config
  const hasAI =
    active?.rules.some(
      (rule) => rule.enabled && (ruleUsesAI(rule) || ruleRequiresSemantics(rule)),
    ) ?? false
  // 旧计划只在用户首次保存统一规则时迁移；保留原来的时间、历史边界和暂停状态。
  if (!previous.config && !hasAI) return previous
  if (previous.config?.scope.mode === "rules") return previous
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  return store.schedule.save(
    {
      ...(previous.config ?? {
        historySince: now.toISOString(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        enabled: true,
      }),
      scope: { mode: "rules" },
      sourceKeys: resolveAIRuleSourceKeys(store, active),
    },
    previous.revision,
  )
}

// 历史任务沿用原指令与引用版本，但不能继续执行用户已停用或移除的 AI 动作。
export function runnableReleasedConfig(
  config: RuleSet,
  active: RuleSet | null | undefined,
  context?: RuleInput,
  allowClassification = true,
): RuleSet {
  // 默认分类由列表加载触发；既有定时去重/综述不能因此扩大成历史标签回跑。
  if (!allowClassification)
    config = {
      ...config,
      rules: config.rules.flatMap((rule) => {
        const actions = rule.actions.filter((action) => action.type !== "ai_classify")
        return actions.length ? [{ ...rule, actions }] : []
      }),
    }
  if (!active) return config
  return {
    ...config,
    rules: config.rules.flatMap((rule) => {
      const current = active.rules.find(
        (candidate) => candidate.id === rule.id && candidate.enabled,
      )
      if (!current) return []
      // 文章标签尚未知时保留已授权的分类动作，确定不匹配的范围继续排除。
      const currentMatch = context ? matchConditions(current.when, context).state : "match"
      if (
        ruleRequiresSemantics(rule) &&
        (!ruleRequiresSemantics(current) || currentMatch === "no_match")
      )
        return []
      const actions = rule.actions.filter((action) => {
        if (!ruleUsesAI({ actions: [action] })) return true
        return (
          current.actions.some((candidate) => candidate.type === action.type) &&
          (currentMatch === "match" ||
            (currentMatch === "unknown" && ruleRequiresSemantics(current)))
        )
      })
      return actions.length ? [{ ...rule, actions }] : []
    }),
  }
}
