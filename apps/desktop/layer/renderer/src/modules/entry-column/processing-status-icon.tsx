import { cn } from "@follow/utils/utils"
import { useTranslation } from "react-i18next"

import { useModalStack } from "~/components/ui/modal/stacked/hooks"
import { isLocalFoloHost } from "~/modules/ai-chat/local-provider"
import {
  useProcessingEntryResult,
  useProcessingEntryStatus,
} from "~/modules/information/processing-entry-result-client"
import { ProcessingEntryResultPanel } from "~/modules/information/ProcessingEntryResultPanel"

/** 已完成的 AI 规则处理才点亮图标；未知状态保留明确的问号提示。 */
export function EntryProcessingStatusIcon({
  entryId,
  className,
}: {
  entryId: string
  className?: string
}) {
  const { t } = useTranslation("app")
  const dialog = useModalStack()
  const processed = useProcessingEntryStatus(entryId)
  const result = useProcessingEntryResult(entryId)
  if (!isLocalFoloHost()) return null

  const label = t(
    processed === null
      ? "processing.status.unknown"
      : processed
        ? "processing.status.processed"
        : "processing.status.no_completed_result",
  )
  const icon = (
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
  )
  const classes = cn("mr-1 flex size-4 shrink-0 items-center justify-center", className)
  // 状态图标直接打开已保存的结果，拦截条目导航，避免点击详情时把原文标记为已读。
  if (result)
    return (
      <button
        type="button"
        className={cn(
          classes,
          "cursor-button rounded focus-visible:ring-2 focus-visible:ring-accent",
        )}
        aria-label={`${label} · ${t("processing.result.view")}`}
        title={`${label} · ${t("processing.result.view")}`}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          dialog.present({
            title: t("processing.result.view"),
            content: () => <ProcessingEntryResultPanel {...result} />,
            clickOutsideToDismiss: true,
            modalClassName: "max-w-2xl",
          })
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {icon}
      </button>
    )

  return (
    <span className={classes} role="img" aria-label={label} title={label}>
      {icon}
    </span>
  )
}
