import * as ScrollArea from "@follow/components/ui/scroll-area/ScrollArea.jsx"
import type { AutomationRule } from "@follow/information-core"
import { cn } from "@follow/utils/utils"
import { useTranslation } from "react-i18next"

export type UnifiedRuleScope = "cloud" | "local" | "processing_service"

export type UnifiedRuleRow = {
  id: string
  scope: UnifiedRuleScope
  name: string
  conditionSummary: string
  actionSummary: string
  enabled: boolean
  // 处理服务不可用时为 true：列表内给出受限提示，详情内解释原因与前提。
  enableBlocked?: boolean
}

// 处理服务规则的条件摘要：沿用官方取数路径（本机 2240），不改变存储语义。
export const buildProcessingConditionSummary = (
  when: AutomationRule["when"],
  t: (key: string) => string,
): string => {
  if ("all" in when) return t("actions.action_card.all")
  const count = when.anyOf.reduce((sum, group) => sum + group.allOf.length, 0)
  return `${t("processing.conditions")} (${count})`
}

// 处理服务规则的处理方式摘要：复用 processing.type.* 既有文案。
export const buildProcessingActionSummary = (
  actions: AutomationRule["actions"],
  t: (key: string) => string,
): string => {
  if (!actions.length) return t("actions.action_card.summary.no_actions")
  return actions.map((action) => t(`processing.type.${action.type}`)).join(" + ")
}

const scopeBadgeLabel = (scope: UnifiedRuleScope, t: (key: string) => string): string =>
  scope === "cloud"
    ? t("actions.scope.cloud")
    : scope === "local"
      ? t("actions.scope.local")
      : t("processing.scope")

export const UnifiedActionList = ({
  rules,
  selectedId,
  onSelect,
}: {
  rules: UnifiedRuleRow[]
  selectedId: string | null
  onSelect: (id: string) => void
}) => {
  if (rules.length === 0) return null
  return (
    <div className="flex w-[260px] shrink-0 flex-col">
      <ScrollArea.ScrollArea rootClassName="h-full" viewportClassName="h-full">
        <div className="flex flex-col">
          {rules.map((rule) => (
            <UnifiedRuleListItem
              key={rule.id}
              rule={rule}
              isActive={rule.id === selectedId}
              onSelect={onSelect}
            />
          ))}
        </div>
      </ScrollArea.ScrollArea>
    </div>
  )
}

const UnifiedRuleListItem = ({
  rule,
  isActive,
  onSelect,
}: {
  rule: UnifiedRuleRow
  isActive: boolean
  onSelect: (id: string) => void
}) => {
  // 这一行同时用到两个命名空间：徽标走 app（`processing.scope`、`automation.*`），
  // 停用/无动作提示走 settings（`actions.action_card.summary.*`）。
  // react-i18next 的 `useTranslation([ns1, ns2])` **默认只用 ns1 绑定 t**
  // （`useTranslation.js` 里 `getFixedT(lng, namespaces[0], …)`，只有 `nsMode: "fallback"`
  // 才会把整个数组传下去），所以必须显式声明回退模式，否则 app 侧的键会原样打到界面上。
  const { t } = useTranslation(["settings", "app"], { nsMode: "fallback" })
  // 与下方的 t 一致：跨命名空间的字面量键在这里收窄，避免多命名空间的键联合类型误报。
  const tr = (key: string) => t(key as never)
  return (
    <button
      type="button"
      onClick={() => onSelect(rule.id)}
      className={cn(
        "flex flex-col gap-1 border-b border-fill-tertiary px-4 py-3 text-left transition-all last:border-b-0",
        isActive ? "bg-fill-quaternary" : "hover:bg-fill-quinary",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium text-text">{rule.name}</span>
        <span className="shrink-0 rounded-md border border-fill-secondary bg-fill-quaternary px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-secondary">
          {scopeBadgeLabel(rule.scope, (key) => t(key as never))}
        </span>
      </div>
      <span className="line-clamp-2 text-xs text-text-secondary">{rule.conditionSummary}</span>
      <span className="line-clamp-1 text-xs text-text-secondary">{rule.actionSummary}</span>
      <div className="flex items-center gap-2 text-[10px] text-text-tertiary">
        <span
          className={cn(
            "inline-block size-1.5 rounded-full",
            rule.enabled ? "bg-green" : "bg-fill-tertiary",
          )}
        />
        {!rule.enabled && <span>{tr("actions.action_card.summary.disabled")}</span>}
        {rule.enableBlocked && (
          <span className="text-orange">{tr("automation.processing_unavailable_short")}</span>
        )}
      </div>
    </button>
  )
}
