import type { PresetId } from "./presets"
import { applyPreset, mergePresetApplication, preset } from "./presets"
import type { AutomationRule, RuleSet } from "./rules"
import { ruleSetSchema } from "./rules"

const domains = [
  { id: "R20", tags: ["Crypto-撸毛", "Crypto-项目方"] },
  {
    id: "R30",
    tags: ["Crypto-投研", "Crypto-交易", "Crypto-项目方", "Crypto-媒体", "美股宏观", "AI×Crypto"],
  },
  {
    id: "R40",
    tags: ["AI-研究前沿", "AI-产品工具", "AI-科普内容", "效率·工具", "独立开发出海", "AI×Crypto"],
  },
  { id: "R50", tags: ["个人成长", "独立开发出海", "效率·工具"] },
  { id: "R60", tags: ["Crypto-项目方"] },
] as const satisfies readonly { id: PresetId; tags: readonly string[] }[]

export type PersonalizedRulePack = {
  ownerId: string
  globalPrompt: string
  rules: AutomationRule[]
  unresolvedTagNames: string[]
  omittedPresetIds: PresetId[]
}

// 只解析实际已有的私人标签，不创建标签、不绑定来源，也不保存或发布用户配置。
export function createPersonalizedRulePack(options: {
  ownerId: string
  tagCatalog: readonly { id: string; name: string }[]
}): PersonalizedRulePack {
  const pack: PersonalizedRulePack = {
    ownerId: options.ownerId,
    globalPrompt: applyPreset("G00").prompt,
    rules: [],
    unresolvedTagNames: [],
    omittedPresetIds: [],
  }
  const normalize = (name: string) => name.trim().normalize("NFKC")
  const addRule = (id: PresetId, when: AutomationRule["when"], enabled = true) => {
    const application = applyPreset(id)
    if (!("type" in application.patch)) throw new Error("invalid_personalized_preset")
    pack.rules.push({
      id: `personalized:${id}`,
      ownerId: options.ownerId,
      name: preset(id).name,
      enabled,
      order: pack.rules.length,
      when,
      actions: [application.patch],
      version: 1,
      executionLocation: "processing_service",
    })
  }
  for (const domain of domains) {
    const expectedNames: readonly string[] = domain.tags
    const matches = options.tagCatalog.filter((tag) => expectedNames.includes(normalize(tag.name)))
    pack.unresolvedTagNames.push(
      ...expectedNames.filter((name) => !matches.some((tag) => normalize(tag.name) === name)),
    )
    if (!matches.length) {
      // 缺标签的领域规则不能悄悄退化成 all；G00/R10仍识别跨标签的有效内容。
      pack.omittedPresetIds.push(domain.id)
      continue
    }
    addRule(
      domain.id,
      {
        anyOf: [
          {
            allOf: [
              {
                field: "subscription_tag",
                operator: "in",
                value: [...new Set(matches.map((tag) => tag.id))],
              },
            ],
          },
        ],
      },
      domain.id !== "R60",
    )
  }
  addRule("R10", { all: true })
  // 同事件只有一个主归属；领域补充规则只做单篇解释，避免重叠创建综述。
  const create = applyPreset("R90-C")
  const update = applyPreset("R90-U")
  if (!("createPrompt" in create.patch) || !("updatePrompt" in update.patch))
    throw new Error("invalid_personalized_preset")
  pack.rules.push({
    id: "personalized:R90",
    ownerId: options.ownerId,
    name: "同事件多文整合 → 事件综述",
    enabled: true,
    order: pack.rules.length,
    when: { all: true },
    actions: [
      {
        type: "ai_aggregate",
        mode: "same_event",
        scope: { all: true },
        createPrompt: create.patch.createPrompt,
        updatePrompt: update.patch.updatePrompt,
        presets: { create: create.presetRef, update: update.presetRef },
      },
    ],
    version: 1,
    executionLocation: "processing_service",
  })
  pack.unresolvedTagNames = [...new Set(pack.unresolvedTagNames)]
  return pack
}

// 导入只追加新规则，保留已编辑的同名包规则和私人 Prompt；再次导入不会重复生成综述规则。
export function appendPersonalizedRulePack(current: RuleSet, pack: PersonalizedRulePack): RuleSet {
  if (current.ownerId !== pack.ownerId) throw new Error("personalized_pack_owner_mismatch")
  const ids = new Set(current.rules.map((rule) => rule.id))
  const hasSameEventRule = current.rules.some((rule) =>
    rule.actions.some((action) => action.type === "ai_aggregate" && action.mode === "same_event"),
  )
  const additions = pack.rules.filter(
    (rule) => !ids.has(rule.id) && !(rule.id === "personalized:R90" && hasSameEventRule),
  )
  if (!additions.length) return structuredClone(current)
  const order = Math.max(-1, ...current.rules.map((rule) => rule.order)) + 1
  // 后续补齐标签规则时不再追加G00；已有同事件规则也不被新默认规则抢占。
  const markdown = ids.has("personalized:R10")
    ? current.global.markdown
    : mergePresetApplication(
        {
          ...applyPreset("G00"),
          prompt: pack.globalPrompt,
          patch: { markdown: pack.globalPrompt },
        },
        current.global.markdown,
        "append",
      ).prompt
  return ruleSetSchema.parse({
    ...current,
    global: {
      ...current.global,
      markdown,
      version: current.global.version + (markdown === current.global.markdown ? 0 : 1),
    },
    rules: [
      ...current.rules,
      ...additions.map((rule, index) => ({ ...rule, order: order + index })),
    ],
  })
}

export type PersonalizedRuleConditionDiff = {
  ruleId: string
  currentTagIds: string[]
  expectedTagIds: string[]
  addedTagIds: string[]
  removedTagIds: string[]
  currentWhen: AutomationRule["when"]
  proposedWhen: AutomationRule["when"]
  requiresManualEdit: boolean
}

// 对已有领域规则单独预览范围差异；追加默认集本身仍不改用户规则。
export function previewPersonalizedRuleConditions(
  current: RuleSet,
  pack: PersonalizedRulePack,
): PersonalizedRuleConditionDiff[] {
  if (current.ownerId !== pack.ownerId) throw new Error("personalized_pack_owner_mismatch")
  const domainIds = new Set(domains.map((domain) => `personalized:${domain.id}`))
  const diffs: PersonalizedRuleConditionDiff[] = []
  for (const rule of current.rules) {
    if (!domainIds.has(rule.id)) continue
    const expected = pack.rules.find((item) => item.id === rule.id)
    // 标签完全缺失时不能产生空条件或退化为全来源，保留现有规则等待对账补齐。
    if (!expected || !("anyOf" in expected.when)) continue
    const expectedTagIds = expected.when.anyOf.flatMap((group) =>
      group.allOf.flatMap((condition) =>
        condition.field === "subscription_tag" ? condition.value : [],
      ),
    )
    const tagConditions =
      "anyOf" in rule.when
        ? rule.when.anyOf.flatMap((group) =>
            group.allOf.flatMap((condition) =>
              condition.field === "subscription_tag" ? [condition] : [],
            ),
          )
        : []
    const currentTagIds = [...new Set(tagConditions.flatMap((condition) => condition.value))]
    const addedTagIds = expectedTagIds.filter((id) => !currentTagIds.includes(id))
    const removedTagIds = currentTagIds.filter((id) => !expectedTagIds.includes(id))
    if (!addedTagIds.length && !removedTagIds.length) continue
    const [tagCondition] = tagConditions
    // 多分支、反向匹配或多个标签谓词涉及私人逻辑，只展示建议并交回原编辑器。
    const requiresManualEdit =
      !("anyOf" in rule.when) ||
      rule.when.anyOf.length !== 1 ||
      tagConditions.length !== 1 ||
      !tagCondition ||
      !["in", "contains_any"].includes(tagCondition.operator)
    let proposedWhen: AutomationRule["when"] = structuredClone(expected.when)
    if (!requiresManualEdit && "anyOf" in rule.when) {
      // 普通包规则只替换标签值，保留用户另加的来源、正文等过滤条件和原操作符。
      proposedWhen = {
        anyOf: rule.when.anyOf.map((group) => ({
          allOf: group.allOf.map((condition) =>
            condition.field === "subscription_tag"
              ? { ...condition, value: [...expectedTagIds] }
              : structuredClone(condition),
          ),
        })),
      }
    }
    diffs.push({
      ruleId: rule.id,
      currentTagIds,
      expectedTagIds,
      addedTagIds,
      removedTagIds,
      currentWhen: structuredClone(rule.when),
      proposedWhen,
      requiresManualEdit,
    })
  }
  return diffs
}

// 只有用户明确勾选的差异才进入草稿；Prompt、动作、开关、顺序和全局要求原样保留。
export function updatePersonalizedRuleConditions(
  current: RuleSet,
  pack: PersonalizedRulePack,
  selectedRuleIds: readonly string[],
): RuleSet {
  const diffs = previewPersonalizedRuleConditions(current, pack)
  const selected = new Set(selectedRuleIds)
  if (
    [...selected].some(
      (id) => !diffs.some((diff) => diff.ruleId === id && !diff.requiresManualEdit),
    )
  )
    throw new Error("personalized_pack_condition_diff_unavailable")
  return ruleSetSchema.parse({
    ...current,
    rules: current.rules.map((rule) => {
      const diff = selected.has(rule.id) ? diffs.find((item) => item.ruleId === rule.id) : undefined
      return diff ? { ...rule, when: diff.proposedWhen, version: rule.version + 1 } : rule
    }),
  })
}
