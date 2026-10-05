import {
  useFocusActions,
  useGlobalFocusableScopeSelector,
} from "@follow/components/common/Focusable/hooks.js"
import { useScrollViewElement } from "@follow/components/ui/scroll-area/hooks.js"
import { useRefValue } from "@follow/hooks"
import { nextFrame } from "@follow/utils/dom"
import { EventBus } from "@follow/utils/event-bus"
import type { FC } from "react"
import { memo, useEffect } from "react"
import { toast } from "sonner"

import { FocusablePresets } from "~/components/common/Focusable"
import { useNavigateEntry } from "~/hooks/biz/useNavigateEntry"
import { getRouteParams, useRouteEntryId } from "~/hooks/biz/useRouteParams"

import { COMMAND_ID } from "../command/commands/id"
import { useCommandBinding } from "../command/hooks/use-command-binding"
import { useCommandHotkey } from "../command/hooks/use-register-hotkey"
import { generatedItemKey } from "../information/generated-feed-identity"
import { useNativeReader } from "../information/native-reader-context"
import { readerItemMatchesTarget } from "../information/reader-target"

export const EntryColumnShortcutHandler: FC<{
  refetch: () => void
  data: readonly string[]
  handleScrollTo: (index: number) => void
}> = memo(({ data, refetch, handleScrollTo }) => {
  const reader = useNativeReader()
  const readerRef = useRefValue(reader)
  const dataRef = useRefValue(data!)

  const when = useGlobalFocusableScopeSelector(FocusablePresets.isTimeline)

  const currentEntryIdRef = useRefValue(useRouteEntryId())
  const navigate = useNavigateEntry()

  useCommandBinding({
    commandId: COMMAND_ID.timeline.switchToNext,
    when,
  })

  useCommandBinding({
    commandId: COMMAND_ID.timeline.switchToPrevious,
    when,
  })

  useCommandBinding({
    commandId: COMMAND_ID.timeline.refetch,
    when,
  })

  useCommandHotkey({
    commandId: COMMAND_ID.layout.focusToEntryRender,
    shortcut: "Enter, L, ArrowRight",
    when,
  })

  useCommandHotkey({
    commandId: COMMAND_ID.layout.focusToSubscription,
    shortcut: "Backspace, Escape, H, ArrowLeft",
    when,
  })

  useEffect(() => {
    return EventBus.subscribe(COMMAND_ID.timeline.switchToNext, () => {
      const data = dataRef.current
      const activeReader = readerRef.current
      if (activeReader?.active && activeReader.locating) return
      const selectedItem = activeReader?.active
        ? activeReader.items.find((item) => readerItemMatchesTarget(item, activeReader.target))
        : undefined
      const currentActiveEntryIndex = data.indexOf(
        selectedItem ? generatedItemKey(selectedItem) : currentEntryIdRef.current || "",
      )

      if (activeReader?.active && activeReader.target && !selectedItem) return
      if (!data.length) return
      const nextIndex = Math.min(currentActiveEntryIndex + 1, data.length - 1)

      if (currentActiveEntryIndex === nextIndex) {
        toast.info("You are already at the last entry")
        return
      }

      handleScrollTo(nextIndex)
      const nextId = data![nextIndex]
      const { view } = getRouteParams()

      if (activeReader?.active) {
        const item = activeReader.items[nextIndex]
        if (item) activeReader.selectItem(item)
      } else navigate({ entryId: nextId, view })
    })
  }, [currentEntryIdRef, dataRef, handleScrollTo, navigate, readerRef, when])

  useEffect(() => {
    return EventBus.subscribe(COMMAND_ID.timeline.switchToPrevious, () => {
      const data = dataRef.current
      const activeReader = readerRef.current
      if (activeReader?.active && activeReader.locating) return
      const selectedItem = activeReader?.active
        ? activeReader.items.find((item) => readerItemMatchesTarget(item, activeReader.target))
        : undefined
      const currentActiveEntryIndex = data.indexOf(
        selectedItem ? generatedItemKey(selectedItem) : currentEntryIdRef.current || "",
      )

      if (activeReader?.active && activeReader.target && !selectedItem) return
      if (!data.length) return
      const nextIndex =
        currentActiveEntryIndex === -1 ? data.length - 1 : Math.max(0, currentActiveEntryIndex - 1)

      if (currentActiveEntryIndex === nextIndex) {
        toast.info("You are already at the first entry")
        return
      }

      handleScrollTo(nextIndex)
      const nextId = data![nextIndex]

      const { view } = getRouteParams()

      if (activeReader?.active) {
        const item = activeReader.items[nextIndex]
        if (item) activeReader.selectItem(item)
      } else navigate({ entryId: nextId, view })
    })
  }, [currentEntryIdRef, dataRef, handleScrollTo, navigate, readerRef])

  useEffect(() => {
    return EventBus.subscribe(COMMAND_ID.timeline.refetch, () => {
      refetch()
    })
  }, [refetch])

  const $scrollArea = useScrollViewElement()
  const { highlightBoundary } = useFocusActions()
  useEffect(() => {
    return EventBus.subscribe(
      COMMAND_ID.layout.focusToTimeline,
      ({ highlightBoundary: highlight }) => {
        $scrollArea?.focus()
        if (highlight) {
          nextFrame(highlightBoundary)
        }
      },
    )
  }, [$scrollArea, highlightBoundary])

  return null
})
