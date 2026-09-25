import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@follow/components/ui/hover-card/index.js"
import {
  useEntryProcessingRole,
  useEntryProcessingRoleRelatedEntries,
} from "@follow/store/entry/processing-role"
import { cn } from "@follow/utils/utils"
import type { MouseEvent, PointerEvent } from "react"
import { useTranslation } from "react-i18next"

import { RelativeTime } from "~/components/ui/datetime"
import { useModalStack } from "~/components/ui/modal/stacked/hooks"
import { ProcessingEntryExplanation } from "~/modules/information/ProcessingEntryExplanation"
import { smartReadingPath } from "~/modules/information/reading-mode-link"
import { StoryDigestPanel } from "~/modules/information/StoryDigestPanel"

import { processingButtonClass } from "../action/processing-condition-editor"
import { useProcessingEntryOverride } from "./processing-entry-override"

const stopEntryNavigation = (event: MouseEvent | PointerEvent) => {
  event.stopPropagation()
}

const preventEntryNavigation = (event: MouseEvent | PointerEvent) => {
  event.preventDefault()
  event.stopPropagation()
}

const chipClass = (className?: string) =>
  cn(
    "inline-flex h-5 shrink-0 cursor-default select-none items-center gap-1 rounded px-1.5 text-[11px] font-semibold leading-none",
    "bg-fill-secondary text-text-secondary transition-colors hover:bg-fill hover:text-text",
    className,
  )

/**
 * 条目处理角色角标。数据源是统一角色层，因此服务端综述、语义去重、显式隐藏三种结论
 * 共用同一个挂载点（`all-item` / `list-item-template` / `grid-item-template` 三处不动）。
 *
 * - `story`：综述代表条目，就地打开综述摘要（来源数、句段引用、更新时间），不跳页。
 * - `hidden`：显式隐藏，悬停给出命中规则并可就地恢复。
 * - `restored`：被用户手动恢复，标注出来，否则「恢复」在界面上看不出效果。
 * - `keeper`/`merged`：沿用原有的「+N」合并角标。
 */
export const MergedEntriesBadge = ({
  className,
  entryId,
}: {
  className?: string
  entryId: string
}) => {
  const { t } = useTranslation("app")
  const dialog = useModalStack()
  const role = useEntryProcessingRole(entryId)
  const mergedEntries = useEntryProcessingRoleRelatedEntries(entryId)
  const { setMode, busy, failed } = useProcessingEntryOverride()
  const isStory = role?.kind === "story" && Boolean(role.storyId)
  const isHidden = role?.kind === "hidden"
  const isRestored = role?.kind === "restored"
  const inputSeq = role?.inputSeq

  const openDigest = () => {
    if (!role?.storyId) return
    dialog.present({
      title: t("processing.digest.title"),
      content: () => <StoryDigestPanel storyId={role.storyId!} storyTitle={role.storyTitle} />,
      clickOutsideToDismiss: true,
      modalClassName: "max-w-2xl",
    })
  }

  if (!isStory && !isHidden && !isRestored && mergedEntries.length === 0) return null

  if (isHidden || isRestored) {
    return (
      <HoverCard openDelay={120} closeDelay={120}>
        <HoverCardTrigger asChild>
          <span
            aria-label={isRestored ? t("processing.badge.restored") : t("processing.badge.hidden")}
            className={chipClass(className)}
            onClick={preventEntryNavigation}
            onPointerDown={preventEntryNavigation}
            role="button"
            tabIndex={0}
          >
            {isRestored ? t("processing.badge.restored") : t("processing.badge.hidden")}
          </span>
        </HoverCardTrigger>
        <HoverCardContent
          align="end"
          className="w-80 p-3 text-xs"
          onClick={stopEntryNavigation}
          onPointerDown={stopEntryNavigation}
          side="top"
        >
          <div className="space-y-2">
            <p className="text-text-secondary">
              {isRestored
                ? t("processing.badge.restored_hint")
                : (role?.reason ?? t("processing.badge.hidden_hint"))}
            </p>
            {inputSeq !== undefined && <ProcessingEntryExplanation inputSeq={inputSeq} />}
            {inputSeq !== undefined && (
              <button
                type="button"
                className={processingButtonClass}
                disabled={busy}
                onClick={() => void setMode(inputSeq, isRestored ? "automatic" : "restore")}
              >
                {t(
                  isRestored
                    ? "processing.badge.back_to_automatic"
                    : "processing.reader.override.restore",
                )}
              </button>
            )}
            {failed && (
              <p role="alert" className="text-red">
                {t("processing.badge.override_failed")}
              </p>
            )}
          </div>
        </HoverCardContent>
      </HoverCard>
    )
  }

  const sourceCount = mergedEntries.length + 1
  const label = isStory
    ? t("processing.badge.story_related", { count: mergedEntries.length })
    : t("processing.badge.merged_entries", { count: mergedEntries.length })

  return (
    <HoverCard openDelay={120} closeDelay={120}>
      <HoverCardTrigger asChild>
        <button
          aria-label={label}
          className={chipClass(cn("cursor-button", className))}
          onClick={(event) => {
            preventEntryNavigation(event)
            if (isStory) openDigest()
          }}
          onPointerDown={preventEntryNavigation}
          type="button"
        >
          {isStory ? t("processing.badge.story") : null}
          <span className="tabular-nums">{isStory ? sourceCount : `+${mergedEntries.length}`}</span>
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        align="end"
        className="w-80 p-1.5"
        onClick={stopEntryNavigation}
        onPointerDown={stopEntryNavigation}
        side="top"
      >
        {isStory && (
          <div className="mb-1 border-b border-border px-2 pb-1.5 pt-1">
            <div className="text-[11px] text-text-tertiary">{t("processing.badge.story")}</div>
            <div className="line-clamp-2 text-xs font-medium text-text">
              {role?.storyTitle ?? entryId}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {/* 场景二：综述在列表内就地读，只有需要修改时才进工作台。 */}
              <button
                className="text-[11px] text-accent underline"
                onClick={openDigest}
                type="button"
              >
                {t("processing.badge.read_digest")}
              </button>
              <a
                className="text-[11px] text-text-secondary underline"
                href={smartReadingPath(
                  window.location.pathname + window.location.search,
                  role?.storyId,
                )}
                onClick={stopEntryNavigation}
                onPointerDown={stopEntryNavigation}
              >
                {t("processing.badge.open_story")}
              </a>
            </div>
          </div>
        )}
        <div className="max-h-72 overflow-y-auto">
          {mergedEntries.map((entry) => {
            const content = (
              <>
                <div className="line-clamp-2 text-xs font-medium text-text">{entry.title}</div>
                <div className="mt-1 flex min-w-0 items-center gap-1 text-[11px] text-text-tertiary">
                  {entry.feedTitle && <span className="min-w-0 truncate">{entry.feedTitle}</span>}
                  {entry.feedTitle && entry.publishedAt && <span className="shrink-0">·</span>}
                  {entry.publishedAt && (
                    <span className="shrink-0">
                      <RelativeTime date={entry.publishedAt} />
                    </span>
                  )}
                </div>
                {entry.url && (
                  <div className="mt-1 truncate text-[11px] text-text-quaternary">{entry.url}</div>
                )}
              </>
            )

            if (!entry.url) {
              return (
                <div key={entry.id} className="rounded px-2 py-1.5">
                  {content}
                </div>
              )
            }

            return (
              <a
                className="block rounded px-2 py-1.5 hover:bg-fill-secondary"
                href={entry.url}
                key={entry.id}
                onClick={stopEntryNavigation}
                onPointerDown={stopEntryNavigation}
                rel="noopener noreferrer"
                target="_blank"
              >
                {content}
              </a>
            )
          })}
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}
