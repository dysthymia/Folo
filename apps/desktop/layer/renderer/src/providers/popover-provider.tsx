// Import from the correct path
import { useSetGlobalFocusableScope } from "@follow/components/common/Focusable/hooks.js"
import { Spring } from "@follow/components/constants/spring.js"
import {
  Popover,
  PopoverArrow,
  PopoverContent,
  PopoverTrigger,
} from "@follow/components/ui/popover/index.jsx"
import { AnimatePresence, m } from "motion/react"
import { memo, useEffect } from "react"

import { dismissPopover, usePopoverValue } from "~/atoms/popover"
import { HotkeyScope } from "~/constants"

export const PopoverProvider: Component = ({ children }) => (
  <>
    {children}
    <Handler />
  </>
)

const Handler = memo(() => {
  const popoverState = usePopoverValue()
  const setGlobalFocusableScope = useSetGlobalFocusableScope()

  useEffect(() => {
    if (!popoverState.open) return

    setGlobalFocusableScope(HotkeyScope.DropdownMenu, "append")
    return () => {
      setGlobalFocusableScope(HotkeyScope.DropdownMenu, "remove")
    }
  }, [popoverState.open, setGlobalFocusableScope])

  const { modal, zIndex, ...contentProps } = popoverState.open ? (popoverState.props ?? {}) : {}

  return (
    <Popover
      open={popoverState.open}
      modal={modal}
      onOpenChange={(state) => {
        if (!state) {
          dismissPopover()
        }
      }}
    >
      <PopoverTrigger
        className="pointer-events-none"
        style={
          popoverState.open
            ? { position: "fixed", top: popoverState.position.y, left: popoverState.position.x }
            : {}
        }
      />
      <AnimatePresence>
        {popoverState.open && (
          <PopoverContent
            {...contentProps}
            asChild
            forceMount
            style={{ ...contentProps.style, zIndex }}
          >
            <m.div
              className="mr-2 rounded-xl border bg-material-ultra-thick p-2 shadow-2xl backdrop-blur-background"
              initial={{ opacity: 0, scale: 0.95, y: -10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: -10 }}
              transition={Spring.presets.smooth}
            >
              <PopoverArrow className="fill-border" />
              {popoverState.content}
            </m.div>
          </PopoverContent>
        )}
      </AnimatePresence>
    </Popover>
  )
})

Handler.displayName = "PopoverHandler"
