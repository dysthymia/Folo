import { stopPropagation } from "@follow/utils/dom"
import { useAtom } from "jotai"
import { useTranslation } from "react-i18next"

import { timelineContentModeAtom } from "../atoms/processing-timeline"

/**
 * 时间线头部的「AI 处理后 / 原始内容」两态切换（§2 D3）。
 *
 * 就地切换，不跳转信息工作台：两态共用同一份查询范围与排序，只切换角色过滤，
 * 因此切到「原始内容」时被隐藏与被并入的条目连同计数一起恢复。
 */
export function ProcessingTimelineModeSwitch() {
  const { t } = useTranslation("app")
  const [mode, setMode] = useAtom(timelineContentModeAtom)

  return (
    <nav
      aria-label={t("processing.timeline_mode")}
      className="flex shrink-0 items-center gap-1 rounded-lg bg-fill-quaternary p-1 text-xs"
      onClick={stopPropagation}
    >
      {(["processed", "original"] as const).map((value) => (
        <button
          key={value}
          type="button"
          aria-current={mode === value ? "true" : undefined}
          className={
            mode === value
              ? "rounded-md bg-background px-2 py-1 font-medium"
              : "rounded-md px-2 py-1 text-text-secondary hover:bg-fill"
          }
          onClick={() => setMode(value)}
        >
          {t(`processing.timeline_mode_${value}`)}
        </button>
      ))}
    </nav>
  )
}
