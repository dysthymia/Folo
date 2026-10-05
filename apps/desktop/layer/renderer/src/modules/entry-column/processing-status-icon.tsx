import { cn } from "@follow/utils/utils"
import { useTranslation } from "react-i18next"

import { isLocalFoloHost } from "~/modules/ai-chat/local-provider"
import { useProcessingEntryStatus } from "~/modules/information/processing-entry-result-client"

/** 已完成的 AI 规则处理才点亮图标；未知状态保留明确的问号提示。 */
export function EntryProcessingStatusIcon({
  entryId,
  className,
}: {
  entryId: string
  className?: string
}) {
  const { t } = useTranslation("app")
  const processed = useProcessingEntryStatus(entryId)
  if (!isLocalFoloHost()) return null

  const label = t(
    processed === null
      ? "processing.status.unknown"
      : processed
        ? "processing.status.processed"
        : "processing.status.no_completed_result",
  )
  return (
    <span
      className={cn("mr-1 flex size-4 shrink-0 items-center justify-center", className)}
      role="img"
      aria-label={label}
      title={label}
    >
      <i
        aria-hidden="true"
        className={cn(
          processed === null
            ? "i-mgc-question-cute-re text-text-tertiary"
            : processed
              ? "i-mgc-check-circle-filled text-purple-600 dark:text-purple-400"
              : "i-mgc-magic-2-cute-re text-text-tertiary",
          "size-4",
        )}
      />
    </span>
  )
}
