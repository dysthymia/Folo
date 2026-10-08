import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@follow/components/ui/hover-card/index.js"
import { Popover, PopoverContent, PopoverTrigger } from "@follow/components/ui/popover/index.js"
import {
  useEntryProcessingRole,
  useEntryProcessingRoleRelatedEntries,
} from "@follow/store/entry/processing-role"
import { useWhoami } from "@follow/store/user/hooks"
import { cn } from "@follow/utils/utils"
import type { KeyboardEvent, MouseEvent, PointerEvent } from "react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"

import { RelativeTime } from "~/components/ui/datetime"
import { useModalStack } from "~/components/ui/modal/stacked/hooks"
import { useProcessingEntryResult } from "~/modules/information/processing-entry-result-client"
import { ProcessingEntryExplanation } from "~/modules/information/ProcessingEntryExplanation"
import { ProcessingEntryResultPanel } from "~/modules/information/ProcessingEntryResultPanel"
import { smartReadingPath } from "~/modules/information/reading-mode-link"
import { StoryDigestPanel } from "~/modules/information/StoryDigestPanel"

import { processingButtonClass } from "../action/processing-condition-editor"
import { DuplicateEntriesPanel } from "./DuplicateEntriesPanel"
import { cachedDuplicateGroup, duplicateGroupCacheKey } from "./processing-duplicates-cache"
import { useProcessingEntryOverride } from "./processing-entry-override"

const stopEntryNavigation = (event: KeyboardEvent | MouseEvent | PointerEvent) => {
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
 * - `keeper`：完整关系计数的「+N」角标，点击展开组员并逐条恢复。
 * - `merged`：在代表条目中查看，不误把代表身份计作折叠数量。
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
  const processingResult = useProcessingEntryResult(entryId)
  const mergedEntries = useEntryProcessingRoleRelatedEntries(entryId)
  // 只跟随本组身份和元信息；其他文章的后台处理不能让当前组缓存失效。
  const revision = JSON.stringify([role, mergedEntries])
  const owner = useWhoami()?.id
  const [duplicateOpen, setDuplicateOpen] = useState(false)
  const [duplicateHover, setDuplicateHover] = useState(false)
  const [overrideOpen, setOverrideOpen] = useState(false)
  const [overrideHover, setOverrideHover] = useState(false)
  const [openingInputSeq, setOpeningInputSeq] = useState<number | undefined>()
  useEffect(() => {
    setDuplicateOpen(false)
    setDuplicateHover(false)
    setOverrideOpen(false)
    setOverrideHover(false)
  }, [entryId, owner])
  useEffect(() => {
    // 角色切换后关闭旧操作面板，避免继续展示已经失效的恢复入口。
    setOverrideOpen(false)
    setOverrideHover(false)
  }, [role?.kind])
  const { setMode, busy, failed } = useProcessingEntryOverride()
  const isStory = role?.kind === "story" && Boolean(role.storyId)
  const isHidden = role?.kind === "hidden"
  const isRestored = role?.kind === "restored"
  const inputSeq = role?.inputSeq
  // 计数来自完整关系身份，浏览器尚未缓存的条目也应计入 +N。
  const memberIds = [...new Set(role?.relatedEntryIds ?? [])].filter((id) => id !== entryId)
  const duplicateCount = role?.kind === "keeper" ? memberIds.length : 0
  const cachedGroup = cachedDuplicateGroup(
    owner,
    duplicateGroupCacheKey(inputSeq, entryId, memberIds, revision),
  )

  const openDigest = () => {
    if (!role?.storyId) return
    dialog.present({
      title: t("processing.digest.title"),
      content: () => <StoryDigestPanel storyId={role.storyId!} storyTitle={role.storyTitle} />,
      clickOutsideToDismiss: true,
      modalClassName: "max-w-2xl",
    })
  }

  const openResult = () => {
    if (!processingResult) return
    dialog.present({
      title: t("processing.result.view"),
      content: () => (
        <ProcessingEntryResultPanel
          inputSeq={processingResult.inputSeq}
          decisionId={processingResult.decisionId}
          sourceKey={processingResult.sourceKey}
          itemId={processingResult.itemId}
          contentVersion={processingResult.contentVersion}
        />
      ),
      clickOutsideToDismiss: true,
      modalClassName: "max-w-2xl",
    })
  }

  if (!isStory && !isHidden && !isRestored && duplicateCount === 0 && !duplicateOpen)
    // 普通条目的处理详情统一由左侧状态图标打开，右侧仅保留综述与重复关系角标。
    return null

  if (isHidden || isRestored) {
    const content = (
      <div className="space-y-2">
        <p className="text-text-secondary">
          {isRestored
            ? t("processing.badge.restored_hint")
            : (role?.reason ?? t("processing.badge.hidden_hint"))}
        </p>
        {inputSeq !== undefined && <ProcessingEntryExplanation inputSeq={inputSeq} />}
        {processingResult && (
          <button type="button" className={processingButtonClass} onClick={openResult}>
            {t("processing.result.view")}
          </button>
        )}
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
    )
    return (
      <HoverCard
        open={overrideHover && !overrideOpen}
        onOpenChange={setOverrideHover}
        openDelay={120}
        closeDelay={120}
      >
        <Popover open={overrideOpen} onOpenChange={setOverrideOpen}>
          <HoverCardTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={
                  isRestored ? t("processing.badge.restored") : t("processing.badge.hidden")
                }
                className={chipClass(cn("cursor-button", className))}
                // 点击和键盘激活均可打开固定面板，触屏也能撤销手动保留。
                onClick={(event) => {
                  preventEntryNavigation(event)
                  setOverrideHover(false)
                  setOverrideOpen(!overrideOpen)
                }}
                onPointerDown={stopEntryNavigation}
                // 保留按钮默认键盘激活，阻止时间线 Enter 快捷键抢走事件。
                onKeyDown={stopEntryNavigation}
              >
                {isRestored ? t("processing.badge.restored") : t("processing.badge.hidden")}
              </button>
            </PopoverTrigger>
          </HoverCardTrigger>
          <HoverCardContent
            align="end"
            className="w-80 p-3 text-xs"
            onClick={stopEntryNavigation}
            onPointerDown={stopEntryNavigation}
            onKeyDown={stopEntryNavigation}
            side="top"
          >
            {content}
          </HoverCardContent>
          <PopoverContent
            align="end"
            side="bottom"
            className="w-80 p-3 text-xs"
            onClick={stopEntryNavigation}
            onPointerDown={stopEntryNavigation}
            onKeyDown={stopEntryNavigation}
          >
            {content}
          </PopoverContent>
        </Popover>
      </HoverCard>
    )
  }

  if (!isStory)
    return (
      <HoverCard
        open={duplicateHover && !duplicateOpen}
        onOpenChange={setDuplicateHover}
        openDelay={120}
        closeDelay={120}
      >
        <Popover open={duplicateOpen} onOpenChange={setDuplicateOpen}>
          <HoverCardTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={t("processing.badge.merged_entries", { count: duplicateCount })}
                className={chipClass(cn("cursor-button", className))}
                onPointerDown={stopEntryNavigation}
                onKeyDown={stopEntryNavigation}
                onClick={(event) => {
                  preventEntryNavigation(event)
                  setDuplicateHover(false)
                  if (!duplicateOpen) setOpeningInputSeq(inputSeq)
                  setDuplicateOpen(!duplicateOpen)
                }}
              >
                <span className="tabular-nums">
                  {duplicateCount ? `+${duplicateCount}` : t("processing.duplicates.title")}
                </span>
              </button>
            </PopoverTrigger>
          </HoverCardTrigger>
          {/* 悬停只读已有元信息，不触发请求；点击才展开可操作的完整详情。 */}
          <HoverCardContent
            align="end"
            side="top"
            className="w-80 p-3 text-xs"
            onClick={stopEntryNavigation}
            onPointerDown={stopEntryNavigation}
            onKeyDown={stopEntryNavigation}
          >
            <p className="font-semibold">{t("processing.duplicates.title")}</p>
            <p className="mt-1 text-text-tertiary">
              {t("processing.duplicates.total", { count: duplicateCount })}
            </p>
            <div className="mt-2 max-h-60 space-y-2 overflow-y-auto">
              {memberIds.slice(0, 5).map((id) => {
                const detail = cachedGroup?.members.find((member) => member.itemId === id)
                const entry = mergedEntries.find((entry) => entry.id === id)
                return (
                  <div key={id}>
                    <p className="line-clamp-2 font-medium">
                      {detail?.title ?? entry?.title ?? t("processing.duplicates.unavailable")}
                    </p>
                    <p className="mt-1 truncate text-[11px] text-text-tertiary">
                      {detail?.sourceTitle ?? entry?.feedTitle}
                    </p>
                  </div>
                )
              })}
            </div>
            <p className="mt-2 text-text-secondary">{t("processing.duplicates.preview_hint")}</p>
          </HoverCardContent>
          <PopoverContent
            align="end"
            side="bottom"
            // 长折叠理由按当前侧实际可用高度滚动，避免弹窗标题被顶出视口。
            className="max-h-[min(32rem,var(--radix-popover-content-available-height))] w-96 max-w-[calc(100vw-2rem)] overflow-y-auto p-0"
            collisionPadding={8}
            aria-label={t("processing.duplicates.title")}
            onClick={stopEntryNavigation}
            onPointerDown={stopEntryNavigation}
            onKeyDown={stopEntryNavigation}
          >
            <DuplicateEntriesPanel
              entryId={entryId}
              inputSeq={openingInputSeq}
              memberIds={memberIds}
              cachedEntries={mergedEntries}
            />
          </PopoverContent>
        </Popover>
      </HoverCard>
    )

  const sourceCount = role?.materialCount ?? memberIds.length + 1
  const label = isStory
    ? t("processing.badge.story_related", { count: Math.max(0, sourceCount - 1) })
    : t("processing.badge.merged_entries", { count: duplicateCount })

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
          <span className="tabular-nums">{sourceCount}</span>
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
        {!isStory && processingResult && (
          <button className="px-2 text-xs text-accent underline" onClick={openResult} type="button">
            {t("processing.result.view")}
          </button>
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
