import { ActionButton } from "@follow/components/ui/button/index.js"
import { Input } from "@follow/components/ui/input/index.js"
import { Popover, PopoverContent, PopoverTrigger } from "@follow/components/ui/popover/index.js"
import { useSetAtom } from "jotai"
import { useTranslation } from "react-i18next"

import { timelineContentModeAtom } from "~/modules/entry-column/atoms/processing-timeline"

import { useNativeReader } from "./native-reader-context"

/** 常驻列表只显示需要处理的空态与失败，筛选放回工具栏浮层。 */
export function NativeReaderFilters() {
  const reader = useNativeReader()
  const { t } = useTranslation("app")
  const setMode = useSetAtom(timelineContentModeAtom)
  if (!reader?.active) return null
  const emptyReason =
    reader.search ||
    reader.topic ||
    reader.since ||
    reader.until ||
    (reader.scope.mode !== "collections" && (reader.unreadOnly || reader.collectedOnly))
      ? "processing.reader.empty_filtered"
      : reader.scope.mode === "collections"
        ? "processing.reader.empty_collections"
        : (reader.counts?.uncovered ?? 0) > 0
          ? "processing.reader.empty_uncovered"
          : (reader.counts?.needsContext ?? 0) > 0
            ? "processing.reader.empty_context"
            : (reader.counts?.pending ?? 0) + (reader.counts?.failed ?? 0) > 0
              ? "processing.reader.empty_pending"
              : (reader.counts?.hidden ?? 0) + (reader.counts?.folded ?? 0) > 0
                ? "processing.reader.empty_processed"
                : "processing.reader.empty_inventory"
  // 原生双流列表的空态由 SDK 条目决定，Story 查询为空不代表整个列表为空。
  const showEmpty = !reader.nativeTimeline && !reader.loading && reader.page?.total === 0
  const showError = reader.failed || reader.page?.collectionSync?.status === "stale"
  if (!showEmpty && !showError && !reader.page?.latestAvailable) return null
  return (
    <div className="space-y-1 px-5 py-2 text-xs" onClick={(event) => event.stopPropagation()}>
      {showEmpty && (
        <p role="status" className="text-text-secondary">
          {t(emptyReason)}
          {!reader.nativeTimeline && reader.scope.mode === "smart" && (
            <button className="ml-2 text-accent" onClick={() => setMode("original")}>
              {t("processing.timeline_mode_original")}
            </button>
          )}
        </p>
      )}
      {reader.page?.latestAvailable && (
        <button className="text-accent" onClick={reader.refresh}>
          {t("processing.generated.apply_updates")}
        </button>
      )}
      {(reader.failed || reader.page?.collectionSync?.status === "stale") && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-red">
          <span>{t("processing.reader.error.request")}</span>
          <button onClick={reader.refresh}>{t("processing.generated.refresh")}</button>
          {!reader.nativeTimeline && reader.scope.mode === "smart" && (
            <button onClick={() => setMode("original")}>
              {t("processing.timeline_mode_original")}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** 延用原生 Popover 与 ActionButton，搜索、主题、日期不占用时间线高度。 */
export function NativeReaderFilterButton() {
  const reader = useNativeReader()
  const { t } = useTranslation("app")
  // AI 筛选仅作用于 Story，原生双流列表继续使用其已有搜索入口。
  if (!reader?.active || reader.nativeTimeline) return null
  const active = !!(reader.search || reader.topic || reader.since || reader.until)
  return (
    <Popover>
      <PopoverTrigger asChild>
        <ActionButton
          tooltip={t("processing.generated.filters")}
          aria-label={t("processing.generated.filters")}
          active={active}
        >
          <i className="i-mgc-filter-cute-re" />
        </ActionButton>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-3 text-xs">
        <form
          className="flex items-center gap-2"
          key={reader.search}
          onSubmit={(event) => {
            event.preventDefault()
            reader.setSearch(String(new FormData(event.currentTarget).get("search") ?? ""))
          }}
        >
          <Input
            name="search"
            defaultValue={reader.search}
            placeholder={t("processing.generated.search")}
            aria-label={t("processing.generated.search")}
            className="h-8 min-w-0 flex-1"
          />
          <button
            type="submit"
            aria-label={t("processing.generated.search")}
            className="size-8 rounded hover:bg-fill-secondary"
          >
            <i className="i-mgc-search-cute-re" />
          </button>
          <select
            value={reader.topic}
            aria-label={t("processing.generated.topic")}
            className="h-8 max-w-24 rounded bg-fill-secondary px-1"
            onChange={(event) => reader.setTopic(event.target.value)}
          >
            {["", "空投", "投资交易", "AI", "个人成长", "重要事件"].map((topic, index) => (
              <option key={topic} value={topic}>
                {t(
                  (
                    [
                      "processing.generated.topic_0",
                      "processing.generated.topic_1",
                      "processing.generated.topic_2",
                      "processing.generated.topic_3",
                      "processing.generated.topic_4",
                      "processing.generated.topic_5",
                    ] as const
                  )[index]!,
                )}
              </option>
            ))}
          </select>
        </form>
        <details>
          <summary className="cursor-pointer text-text-secondary">
            {t("processing.generated.apply_dates")}
          </summary>
          <form
            key={`${reader.since}:${reader.until}`}
            className="mt-2 flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              const data = new FormData(event.currentTarget)
              reader.setDates({
                since: String(data.get("since") ?? ""),
                until: String(data.get("until") ?? ""),
              })
            }}
          >
            <input
              name="since"
              type="date"
              defaultValue={reader.since}
              aria-label={t("processing.generated.since")}
              className="min-w-0 rounded bg-fill-secondary p-1"
            />
            <input
              name="until"
              type="date"
              defaultValue={reader.until}
              min={reader.since}
              aria-label={t("processing.generated.until")}
              className="min-w-0 rounded bg-fill-secondary p-1"
            />
            <button type="submit">{t("processing.generated.apply_dates")}</button>
          </form>
        </details>
      </PopoverContent>
    </Popover>
  )
}
