import type { PopoverContentProps } from "@radix-ui/react-popover"
import { atom } from "jotai"
import type { ReactNode } from "react"

import { createAtomHooks, jotaiStore } from "~/lib/jotai"

// Atom

export interface PopoverProps extends Omit<PopoverContentProps, "children"> {
  /** Custom z-index for popover */
  zIndex?: number
  /** Whether the popover should use modal focus and pointer behavior */
  modal?: boolean
}

type PopoverState =
  | { open: false }
  | {
      open: true
      position: { x: number; y: number }
      content: ReactNode
      props?: PopoverProps
      // Just for abort callback
      abortController: AbortController
    }

export const [popoverAtom, usePopoverState, usePopoverValue, useSetPopover] = createAtomHooks(
  atom<PopoverState>({ open: false }),
)

export const showPopover = (
  mouseXY: { x: number; y: number },
  element: ReactNode,
  props?: PopoverProps,
) => {
  const currentPopover = jotaiStore.get(popoverAtom)
  if (currentPopover.open) {
    currentPopover.abortController.abort()
  }

  jotaiStore.set(popoverAtom, {
    open: true,
    position: mouseXY,
    content: element,
    props,
    abortController: new AbortController(),
  })
}

export const dismissPopover = () => {
  const currentPopover = jotaiStore.get(popoverAtom)
  if (!currentPopover.open) return

  currentPopover.abortController.abort()
  jotaiStore.set(popoverAtom, { open: false })
}
