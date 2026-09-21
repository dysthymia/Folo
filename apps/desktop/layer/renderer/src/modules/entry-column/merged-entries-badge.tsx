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
import { smartReadingPath } from "~/modules/information/reading-mode-link"

const stopEntryNavigation = (event: MouseEvent | PointerEvent) => {
  event.stopPropagation()
}

const preventEntryNavigation = (event: MouseEvent | PointerEvent) => {
  event.preventDefault()
  event.stopPropagation()
}

/**
 * Shows the entries merged into this one. The relation comes from the unified
 * processing role, so it covers both the local semantic dedupe and service side
 * stories without a second badge.
 *
 * A service story representative stays in the timeline as one entry: the badge
 * marks it as a digest and lists what was folded into it, while the digest body
 * itself stays in the smart reading page.
 */
export const MergedEntriesBadge = ({
  className,
  entryId,
}: {
  className?: string
  entryId: string
}) => {
  const { t } = useTranslation("app")
  const role = useEntryProcessingRole(entryId)
  const mergedEntries = useEntryProcessingRoleRelatedEntries(entryId)
  const isStory = role?.kind === "story" && Boolean(role.storyId)

  if (!isStory && mergedEntries.length === 0) return null

  const sourceCount = mergedEntries.length + 1
  const label = isStory
    ? t("processing.badge.story_related", { count: mergedEntries.length })
    : t("processing.badge.merged_entries", { count: mergedEntries.length })

  return (
    <HoverCard openDelay={120} closeDelay={120}>
      <HoverCardTrigger asChild>
        <span
          aria-label={label}
          className={cn(
            "inline-flex h-5 shrink-0 cursor-default select-none items-center gap-0.5 rounded px-1.5 text-[11px] font-semibold leading-none",
            "bg-fill-secondary text-text-secondary transition-colors hover:bg-fill hover:text-text",
            className,
          )}
          onClick={preventEntryNavigation}
          onPointerDown={preventEntryNavigation}
          role="button"
          tabIndex={0}
        >
          {isStory ? t("processing.badge.story") : null}
          <span className="tabular-nums">{isStory ? sourceCount : `+${mergedEntries.length}`}</span>
        </span>
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
            <a
              className="mt-1 inline-block text-[11px] text-accent underline"
              href={smartReadingPath(window.location.pathname + window.location.search)}
              onClick={stopEntryNavigation}
              onPointerDown={stopEntryNavigation}
            >
              {t("processing.badge.open_story")}
            </a>
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
