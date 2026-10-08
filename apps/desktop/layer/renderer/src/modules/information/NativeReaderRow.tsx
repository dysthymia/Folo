import { ActionButton } from "@follow/components/ui/button/index.js"
import { FeedViewType } from "@follow/constants"
import { useIsEntryStarred } from "@follow/store/collection/hooks"
import { useEntry } from "@follow/store/entry/hooks"
import { cn } from "@follow/utils/utils"
import { useEffect } from "react"
import { useTranslation } from "react-i18next"

import { useGeneralSettingKey } from "~/atoms/settings/general"
import { RelativeTime } from "~/components/ui/datetime"
import { EntryItem } from "~/modules/entry-column/item"
import { getEntrySourceColorStyle } from "~/modules/entry-column/source-color"
import { CompactListItemFrame } from "~/modules/entry-column/templates/compact-list-item-frame"

import type { GeneratedReaderItem } from "./generated-feed-client"
import { useNativeReader } from "./native-reader-context"
import { ProcessingSignals } from "./ProcessingSignals"
import { readerItemMatchesTarget } from "./reader-target"

/** 同一列表沿用当前视图的布局偏好；私有 Story 永远不进入 entry store。 */
export function NativeReaderRow({ item, view }: { item: GeneratedReaderItem; view: FeedViewType }) {
  return item.kind === "entry" ? (
    <OriginalReaderRow item={item} view={view} />
  ) : (
    <StoryReaderRow item={item} view={view} />
  )
}

function OriginalReaderRow({
  item,
  view,
}: {
  item: Extract<GeneratedReaderItem, { kind: "entry" }>
  view: FeedViewType
}) {
  const reader = useNativeReader()
  const syncOriginalState = reader?.syncOriginalState
  const entry = useEntry(item.id, (entry) => ({ read: entry.read }))
  const starred = useIsEntryStarred(item.id)
  useEffect(() => {
    if (entry) syncOriginalState?.(item)
  }, [entry, starred, item, syncOriginalState])
  if (!entry)
    return (
      <div className="p-4 text-sm text-text-secondary" role="status">
        {item.title}
      </div>
    )
  // 全部列表使用原生单行模板，来源媒体类型不改变当前列表的阅读密度。
  return <EntryItem entryId={item.id} view={view} />
}

function StoryReaderRow({
  item,
  view,
}: {
  item: Extract<GeneratedReaderItem, { kind: "story" }>
  view: FeedViewType
}) {
  const reader = useNativeReader()
  const { t } = useTranslation("app")
  const dimRead = useGeneralSettingKey("dimRead")
  const selected = readerItemMatchesTarget(item, reader?.target ?? null)
  const sourceColorStyle = getEntrySourceColorStyle(item.generatedFeedId)
  return (
    <article
      data-reader-kind="story"
      data-story-id={item.storyId}
      data-active={selected}
      data-read={item.read}
      style={sourceColorStyle}
      className={cn(
        "cursor-button rounded-md duration-200",
        view === FeedViewType.All && "!rounded-none",
        item.read
          ? "bg-[var(--entry-source-background-read)] hover:bg-[var(--entry-source-background-read-hover)]"
          : "bg-[var(--entry-source-background)] hover:bg-[var(--entry-source-background-hover)]",
        selected && "!bg-theme-item-active",
      )}
      onClick={(event) => {
        event.stopPropagation()
        reader?.selectItem(item)
      }}
    >
      <div className="pl-5 pr-4 @[700px]:pl-6 @[1024px]:pr-5">
        <CompactListItemFrame read={!!item.read}>
          <ActionButton
            size="xs"
            active={!!item.collected}
            aria-pressed={!!item.collected}
            tooltip={t(
              item.collected ? "processing.generated.uncollect" : "processing.generated.collect",
            )}
            onClick={(event) => {
              event.stopPropagation()
              void reader?.mutateItem(item, { collected: !item.collected })
            }}
            className="-ml-1 shrink-0"
          >
            <i
              className={
                item.collected
                  ? "i-mgc-star-cute-fi text-yellow"
                  : "i-mgc-star-cute-re text-text-quaternary"
              }
            />
          </ActionButton>
          <i
            aria-label={t("processing.generated.title")}
            className="i-mgc-news-cute-re mr-1 size-4 shrink-0 text-accent"
          />
          {/* 来源名称与图标同行，帮助识别综述且保持标题与摘要的单行密度。 */}
          <span className="mr-2 shrink-0 text-xs text-text-secondary">
            {t("processing.generated.title")}
          </span>
          <div className="flex h-fit min-w-0 flex-1 items-center truncate text-sm leading-tight">
            <button
              type="button"
              className={cn(
                // 与原生条目相同，先保留标题宽度，长摘要只使用剩余空间。
                "min-w-0 max-w-[75%] shrink-0 truncate text-left font-medium text-text",
                dimRead && item.read && "text-text-secondary",
              )}
              title={item.title}
            >
              {item.title}
            </button>
            <span
              className={cn(
                "ml-4 truncate text-[13px] text-text-secondary",
                dimRead && item.read && "text-text-tertiary",
              )}
            >
              {item.summary}
            </span>
          </div>
          <div className="ml-4 flex shrink-0 items-center gap-1 text-xs text-text-secondary">
            {item.attention && (
              <ProcessingSignals signals={{ attention: item.attention }} compact />
            )}
            {item.hasImportantUpdate && (
              <i
                className="i-mgc-sparkles-cute-re text-accent"
                aria-label={t("processing.generated.important_update")}
              />
            )}
            <RelativeTime date={item.publishedAt} postfix="" />
          </div>
        </CompactListItemFrame>
      </div>
    </article>
  )
}
