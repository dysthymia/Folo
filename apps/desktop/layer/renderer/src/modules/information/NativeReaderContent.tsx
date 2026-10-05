import { ScrollArea } from "@follow/components/ui/scroll-area/index.js"
import { useIsEntryStarred } from "@follow/store/collection/hooks"
import { useEntry } from "@follow/store/entry/hooks"
import { cn } from "@follow/utils/utils"
import type { ComponentProps } from "react"
import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Link, useLocation, useSearchParams } from "react-router"

import { Focusable } from "~/components/common/Focusable"
import { HotkeyScope } from "~/constants"
import { readableContentMaxWidthClassName } from "~/constants/ui"
import { useRenderStyle } from "~/hooks/biz/useRenderStyle"
import { EntryContent } from "~/modules/entry-content/components/entry-content"
import { EntryScrollingAndNavigationHandler } from "~/modules/entry-content/components/entry-content/EntryScrollingAndNavigationHandler"
import { WrappedElementProvider } from "~/providers/wrapped-element-provider"

import { GeneratedEntryControls } from "./GeneratedEntryControls"
import { InformationIntegration } from "./InformationIntegration"
import { useNativeReader } from "./native-reader-context"
import { storyReaderLocation } from "./reader-target"
import { ResearchPanel } from "./ResearchPanel"
import { StoryDigestPanel } from "./StoryDigestPanel"

/** 原文仍由原生内容布局渲染，Story 使用同一阅读焦点和滚动命令。 */
export function NativeReaderContent({
  entryId,
  className,
}: {
  entryId: string
  className?: string
}) {
  const reader = useNativeReader()
  if (reader?.target?.kind === "story")
    return <NativeStoryContent key={reader.storyId} className={className} />
  return <NativeOriginalReaderContent entryId={entryId} className={className} />
}

function NativeOriginalReaderContent({
  entryId,
  className,
}: {
  entryId: string
  className?: string
}) {
  const reader = useNativeReader()
  const syncOriginalState = reader?.syncOriginalState
  const { t } = useTranslation("app")
  const entry = useEntry(entryId, (entry) => ({ read: entry.read }))
  const starred = useIsEntryStarred(entryId)
  const exists = !!entry
  useEffect(() => {
    // 深链正文不依赖虚拟行挂载，原生工具栏和快捷键的 SDK 变更也更新冻结投影。
    if (exists && entryId) syncOriginalState?.({ kind: "entry", entryId })
  }, [entryId, exists, entry?.read, starred, syncOriginalState])
  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      {reader?.active &&
        !reader.nativeTimeline &&
        reader.entryState &&
        reader.entryState.status !== "ready" && (
          <p role="status" className="border-b px-4 py-2 text-xs text-text-secondary">
            {t(`processing.reader.entry_${reader.entryState.status}`)}
            {reader.entryState.reason && ` · ${reader.entryState.reason}`}
          </p>
        )}
      {reader?.active && reader.selected?.kind === "entry" && reader.selected.inputSeq !== null && (
        <GeneratedEntryControls inputSeq={reader.selected.inputSeq} />
      )}
      <EntryContent entryId={entryId} className="min-h-0 flex-1" />
    </div>
  )
}

function NativeStoryContent({ className }: { className?: string }) {
  const { pathname } = useLocation()
  const [params] = useSearchParams()
  const reader = useNativeReader()
  const { t } = useTranslation("app")
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const animationRef =
    useRef<
      ComponentProps<typeof EntryScrollingAndNavigationHandler>["scrollAnimationRef"]["current"]
    >(null)
  const renderStyle = useRenderStyle()
  const [tools, setTools] = useState(false)
  if (!reader?.storyId) return null
  const link = reader.deepState?.link
  return (
    <Focusable
      scope={HotkeyScope.EntryRender}
      className={cn("relative flex min-h-0 flex-1 flex-col overflow-hidden @container", className)}
    >
      <EntryScrollingAndNavigationHandler
        scrollerRef={scrollRef}
        scrollAnimationRef={animationRef}
      />
      <ScrollArea.ScrollArea
        focusable
        mask={false}
        flex
        rootClassName="min-h-0 flex-1"
        ref={scrollRef}
      >
        <WrappedElementProvider boundingDetection>
          {/* 为原生固定工具栏保留足够起始间距，避免首行标题被遮挡。 */}
          <div
            className={cn(readableContentMaxWidthClassName, "mx-auto mb-32 mt-20 px-4")}
            style={renderStyle}
          >
            {link?.kind === "merged" ? (
              <Link
                className="text-accent underline"
                to={storyReaderLocation(pathname, params, link.mergedInto)}
              >
                {t("processing.generated.choose")}
              </Link>
            ) : link?.kind === "split" ? (
              link.splitInto.map((id) => (
                <Link
                  key={id}
                  className="mr-3 text-accent underline"
                  to={storyReaderLocation(pathname, params, id)}
                >
                  {t("processing.generated.choose")}
                </Link>
              ))
            ) : (
              <StoryDigestPanel
                storyId={reader.storyId}
                storyTitle={reader.selected?.title}
                revision={reader.selected?.kind === "story" ? reader.selected.revision : undefined}
                embedded
              />
            )}
            <button
              className="mt-5 text-xs text-text-secondary"
              onClick={() => setTools((previous) => !previous)}
            >
              {t("processing.generated.tools")}
            </button>
            {tools && (
              <div className="mt-3 space-y-4">
                <InformationIntegration storyId={reader.storyId} />
                <ResearchPanel
                  target={{ kind: "story", storyId: reader.storyId }}
                  targetTitle={reader.selected?.title ?? ""}
                />
              </div>
            )}
          </div>
        </WrappedElementProvider>
      </ScrollArea.ScrollArea>
    </Focusable>
  )
}
