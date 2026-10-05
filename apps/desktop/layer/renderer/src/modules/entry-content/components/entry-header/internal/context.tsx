import { useHasEntry } from "@follow/store/entry/hooks"
import { cn } from "@follow/utils/utils"
import type { MotionStyle } from "motion/react"
import type { ReactNode } from "react"
import { createContext, memo, use, useMemo } from "react"

import { m } from "~/components/common/Motion"

import { useEntryContentScrollToTop, useEntryTitleMeta } from "../../../atoms"
import type { EntryHeaderProps } from "../types"

interface EntryHeaderContextValue {
  entryId: string
}

const EntryHeaderContext = createContext<EntryHeaderContextValue | null>(null)

export function useEntryHeaderContext() {
  const ctx = use(EntryHeaderContext)
  if (!ctx) throw new Error("EntryHeader components must be used within <EntryHeaderRoot />")
  return ctx
}

export interface EntryHeaderRootProps extends EntryHeaderProps {
  children: ReactNode
  style?: MotionStyle
}

function EntryHeaderRootImpl({
  entryId,
  className,
  compact,
  children,
  style,
}: EntryHeaderRootProps) {
  const hasEntry = useHasEntry(entryId)
  const entryTitleMeta = useEntryTitleMeta()
  const isAtTop = !!useEntryContentScrollToTop()

  const shouldShowMeta = !isAtTop && !!entryTitleMeta?.entryTitle

  const contextValue = useMemo(() => ({ entryId, compact }), [entryId, compact])
  if (!hasEntry) return null

  return (
    <EntryHeaderContext value={contextValue}>
      <EntryHeaderFrame className={className} style={style} showBorder={shouldShowMeta}>
        {children}
      </EntryHeaderFrame>
    </EntryHeaderContext>
  )
}

export const EntryHeaderRoot = memo(EntryHeaderRootImpl)

/** 原文与 Story 共用标题栏外壳，不向官方 store 注入私人身份。 */
export function EntryHeaderFrame({
  children,
  className,
  style,
  showBorder,
}: {
  children: ReactNode
  className?: string
  style?: MotionStyle
  showBorder?: boolean
}) {
  return (
    <m.div
      data-hide-in-print
      className={cn(
        "relative flex min-w-0 items-center justify-between gap-3 overflow-hidden border-b border-transparent text-lg text-text-secondary duration-200 macos-left-column-hidden:pl-margin-macos-traffic-light-x",
        showBorder && "border-border",
        className,
      )}
      style={style}
    >
      {children}
    </m.div>
  )
}
