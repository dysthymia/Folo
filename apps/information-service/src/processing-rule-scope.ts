import type { RuleInput, RuleSet } from "@follow/information-core"
import { matchConditions, ruleUsesAI } from "@follow/information-core"

import { processingRuleInput } from "./processing-context"
import type { Store } from "./store"

// 选源阶段只排除确定不匹配者；文章正文、作者等未知字段不能被当成 false。
export function resolveAIRuleSourceKeys(
  store: Store,
  config = store.automation.effective().config,
): string[] {
  const rules = config?.rules.filter((rule) => rule.enabled && ruleUsesAI(rule)) ?? []
  if (!rules.length) return []
  return store
    .sources()
    .filter((source) => {
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

// 正式调用必须明确命中 AI 规则；全局说明或纯本地动作均不自行开启模型处理。
export function matchesAIRule(config: RuleSet, context: RuleInput): boolean {
  return config.rules.some(
    (rule) =>
      rule.enabled && ruleUsesAI(rule) && matchConditions(rule.when, context).state === "match",
  )
}

export function activateRuleSchedule(store: Store) {
  const previous = store.schedule.snapshot()
  const active = store.automation.effective().config
  const hasAI = active?.rules.some((rule) => rule.enabled && ruleUsesAI(rule)) ?? false
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
): RuleSet {
  if (!active) return config
  return {
    ...config,
    rules: config.rules.flatMap((rule) => {
      const current = active.rules.find(
        (candidate) => candidate.id === rule.id && candidate.enabled,
      )
      if (!current) return []
      const actions = rule.actions.filter((action) => {
        if (!ruleUsesAI({ actions: [action] })) return true
        return (
          current.actions.some((candidate) => candidate.type === action.type) &&
          (!context || matchConditions(current.when, context).state === "match")
        )
      })
      return actions.length ? [{ ...rule, actions }] : []
    }),
  }
}
