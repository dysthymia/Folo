import { Popover, PopoverContent, PopoverTrigger } from "@follow/components/ui/popover/index.js"
import type { SemanticEntity, SemanticTagId } from "@follow/information-core"
import { buildSemanticTagGroups, semanticEntityId } from "@follow/information-core"
import { cn } from "@follow/utils/utils"
import { useTranslation } from "react-i18next"

import { useProcessingEntryResult } from "~/modules/information/processing-entry-result-client"
import { ProcessingSignals } from "~/modules/information/ProcessingSignals"

const tagClass =
  "min-w-0 max-w-full whitespace-normal break-words rounded bg-fill-secondary px-1.5 py-0.5 text-[10px] font-normal leading-3 text-text-secondary"

// 产品名缺少所属项目时补全；已经包含父名称的完整名称不重复拼接。
const entityLabel = (entity: SemanticEntity) =>
  entity.kind === "product" &&
  entity.parentName &&
  !entity.name.toLocaleLowerCase().startsWith(entity.parentName.toLocaleLowerCase())
    ? `${entity.parentName} ${entity.name}`
    : entity.name

// 标签与实体只读当前正文的批量投影；不触发单篇请求，也不按目录推断主题。
export function EntrySemanticTags({
  entryId,
  className,
  compact = false,
  showAll = false,
}: {
  entryId: string
  className?: string
  compact?: boolean
  showAll?: boolean
}) {
  const result = useProcessingEntryResult(entryId)
  return (
    <span className={cn("inline-flex min-w-0 max-w-full flex-wrap items-center gap-1", className)}>
      {result && <ProcessingSignals signals={result} compact />}
      <EntrySemanticTagList
        tags={result?.semanticTags}
        entities={result?.semanticEntities}
        className={className}
        compact={compact}
        showAll={showAll}
      />
    </span>
  )
}

export function EntrySemanticTagList({
  tags = [],
  entities = [],
  className,
  compact = false,
  showAll = false,
}: {
  tags?: readonly SemanticTagId[]
  entities?: readonly SemanticEntity[]
  className?: string
  compact?: boolean
  showAll?: boolean
}) {
  // 标签编号含冒号，翻译时保留完整键名；组合只改变展示，不改写判断。
  const { t } = useTranslation("app")
  const groups = buildSemanticTagGroups(tags)
  const labels = [
    ...groups.map((group) => ({
      id: group.join("/"),
      label: group.map((tag) => t(`semantic.tag.${tag}`, { nsSeparator: false })).join("-"),
      title: group
        .map((tag) => t(`semantic.definition.${tag}`, { nsSeparator: false }))
        .join(" · "),
      entity: false,
    })),
    ...[...new Map(entities.map((entity) => [semanticEntityId(entity), entity])).values()].map(
      (entity) => ({
        id: `entity/${semanticEntityId(entity)}`,
        label: entityLabel(entity),
        title: entityLabel(entity),
        entity: true,
      }),
    ),
  ]
  if (!labels.length) return null
  // 标签与主实体各保留两个，窄栏各显示一个；展开后所有名称可换行，不截断长名称。
  const visible = showAll
    ? labels
    : [
        ...labels.filter((label) => !label.entity).slice(0, 2),
        ...labels.filter((label) => label.entity).slice(0, 2),
      ]
  const narrowCount = Math.min(groups.length, 1) + Math.min(labels.length - groups.length, 1)
  const hiddenCount = labels.length - visible.length
  const showMore = !showAll && labels.length > (compact ? narrowCount : visible.length)
  const renderLabel = (label: (typeof labels)[number], index: number, collapsed: boolean) => (
    <span
      key={label.id}
      className={cn(
        tagClass,
        label.entity && "bg-fill-quaternary",
        compact && collapsed && index === 1 && "hidden @[500px]:inline",
      )}
      title={label.title}
    >
      {label.label}
    </span>
  )
  return (
    <span
      className={cn("inline-flex min-w-0 max-w-full flex-wrap items-center gap-1", className)}
      aria-label={t("semantic.tags.label")}
    >
      {visible.map((label, index) =>
        renderLabel(label, label.entity ? index - Math.min(groups.length, 2) : index, !showAll),
      )}
      {showMore && (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                tagClass,
                "transition-colors hover:bg-fill-tertiary",
                compact && hiddenCount === 0 && "@[500px]:hidden",
              )}
              aria-label={t("semantic.tags.view_all")}
              onClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              {compact ? (
                <>
                  <span className="@[500px]:hidden">+{labels.length - narrowCount}</span>
                  <span className="hidden @[500px]:inline">+{hiddenCount}</span>
                </>
              ) : (
                <>+{hiddenCount}</>
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent
            className="flex max-w-72 flex-wrap gap-1 p-2"
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
          >
            {labels.map((label, index) => renderLabel(label, index, false))}
          </PopoverContent>
        </Popover>
      )}
    </span>
  )
}
