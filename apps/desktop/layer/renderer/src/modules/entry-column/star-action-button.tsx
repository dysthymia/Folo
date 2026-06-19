import type { FeedViewType } from "@follow/constants"
import { useIsEntryStarred } from "@follow/store/collection/hooks"
import { cn } from "@follow/utils/utils"
import { useMemo } from "react"

import { CommandActionButton } from "~/components/ui/button/CommandActionButton"
import { useRequireLogin } from "~/hooks/common/useRequireLogin"
import { COMMAND_ID } from "~/modules/command/commands/id"
import { useRunCommandFn } from "~/modules/command/hooks/use-command"
import { useCommandShortcuts } from "~/modules/command/hooks/use-command-binding"

export const EntryStarActionButton = ({
  entryId,
  view,
  className,
}: {
  entryId: string
  view: FeedViewType
  className?: string
}) => {
  const isStarred = useIsEntryStarred(entryId)
  const shortcuts = useCommandShortcuts()
  const runCmdFn = useRunCommandFn()
  const { withLoginGuard } = useRequireLogin()

  const runStarCommand = useMemo(
    () => runCmdFn(COMMAND_ID.entry.star, [{ entryId, view }]),
    [entryId, runCmdFn, view],
  )

  return (
    <div
      className={cn(
        "mr-1 flex shrink-0 justify-center pt-px",
        !isStarred && "text-text-quaternary hover:text-text-tertiary",
        className,
      )}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
      onDoubleClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
      onPointerDown={(event) => {
        event.stopPropagation()
      }}
    >
      <CommandActionButton
        aria-pressed={isStarred}
        active={isStarred}
        commandId={COMMAND_ID.entry.star}
        disableTriggerShortcut
        onClick={withLoginGuard(runStarCommand)}
        shortcut={shortcuts[COMMAND_ID.entry.star]}
        size="xs"
      />
    </div>
  )
}
