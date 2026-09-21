import { useCallback, useState } from "react"

import {
  loadEntryOverrides,
  mutationSchemas,
  readingRequest,
} from "~/modules/information/processing-reader-client"
import { syncServiceProcessingRoles } from "~/modules/information/processing-role-client"

export type ProcessingEntryOverrideMode = "restore" | "hide" | "automatic"

/**
 * 时间线里的条目级覆盖（§2 D3「条目级恢复」）。
 *
 * 复用阅读页同一套 `processing/entries/{seq}/override` 接口：覆盖仍由处理服务落库，
 * 客户端只负责带上当前的 `expectedRevision`（乐观锁），成功后重新拉一次角色投影，
 * 让「AI 处理后」视图立刻反映恢复/隐藏结果。
 */
export function useProcessingEntryOverride() {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  const setMode = useCallback(
    async (inputSeq: number, mode: ProcessingEntryOverrideMode): Promise<boolean> => {
      setBusy(true)
      setFailed(false)
      const controller = new AbortController()
      try {
        const overrides = await loadEntryOverrides(controller.signal)
        const expectedRevision = overrides.get(inputSeq)?.override?.revision ?? 0
        await readingRequest(
          `processing/entries/${inputSeq}/override`,
          mutationSchemas.override,
          controller.signal,
          { mode, expectedRevision },
        )
        await syncServiceProcessingRoles()
        return true
      } catch {
        setFailed(true)
        return false
      } finally {
        setBusy(false)
      }
    },
    [],
  )

  return { setMode, busy, failed }
}
