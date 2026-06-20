import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@follow/components/ui/hover-card/index.js"
import { useSemanticDuplicateEntriesForKeeper } from "@follow/store/entry/semantic-dedupe"
import { cn } from "@follow/utils/utils"
import type { MouseEvent, PointerEvent } from "react"

import { RelativeTime } from "~/components/ui/datetime"

const stopEntryNavigation = (event: MouseEvent | PointerEvent) => {
  event.stopPropagation()
}

const preventEntryNavigation = (event: MouseEvent | PointerEvent) => {
  event.preventDefault()
  event.stopPropagation()
}

export const SemanticDuplicateBadge = ({
  className,
  entryId,
}: {
  className?: string
  entryId: string
}) => {
  const duplicateEntries = useSemanticDuplicateEntriesForKeeper(entryId)

  if (duplicateEntries.length === 0) return null

  return (
    <HoverCard openDelay={120} closeDelay={120}>
      <HoverCardTrigger asChild>
        <span
          aria-label={`${duplicateEntries.length} duplicate entries`}
          className={cn(
            "inline-flex h-5 shrink-0 cursor-default select-none items-center rounded px-1.5 text-[11px] font-semibold leading-none",
            "bg-fill-secondary text-text-secondary transition-colors hover:bg-fill hover:text-text",
            className,
          )}
          onClick={preventEntryNavigation}
          onPointerDown={preventEntryNavigation}
          role="button"
          tabIndex={0}
        >
          +{duplicateEntries.length}
        </span>
      </HoverCardTrigger>
      <HoverCardContent
        align="end"
        className="w-80 p-1.5"
        onClick={stopEntryNavigation}
        onPointerDown={stopEntryNavigation}
        side="top"
      >
        <div className="max-h-72 overflow-y-auto">
          {duplicateEntries.map((entry) => {
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
