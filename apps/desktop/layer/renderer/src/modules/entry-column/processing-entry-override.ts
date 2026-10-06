import { useWhoami } from "@follow/store/user/hooks"
import { useCallback, useEffect, useRef, useState } from "react"

import {
  loadEntryOverrides,
  mutationSchemas,
  readingRequest,
} from "~/modules/information/processing-reader-client"
import { refreshServiceProcessingRoles } from "~/modules/information/processing-role-client"

export type ProcessingEntryOverrideMode = "restore" | "hide" | "automatic"

/**
 * 时间线里的条目级覆盖（§2 D3「条目级恢复」）。
 *
 * 复用阅读页同一套 `processing/entries/{seq}/override` 接口：覆盖仍由处理服务落库，
 * 客户端只负责带上当前的 `expectedRevision`（乐观锁），成功后强制重新拉一次角色投影，
 * 让「AI 处理后」视图立刻反映恢复/隐藏结果。
 *
 * 失败不再只置一个内部标志就作罢——角标会把 `failed` 显示出来，避免用户点了没反应又不知道为什么。
 */
export function useProcessingEntryOverride() {
  const owner = useWhoami()?.id
  const ownerRef = useRef(owner)
  ownerRef.current = owner
  const requestRef = useRef<AbortController | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    setBusy(false)
    setFailed(false)
    return () => requestRef.current?.abort()
  }, [owner])

  const setMode = useCallback(
    async (
      inputSeq: number,
      mode: ProcessingEntryOverrideMode,
      expectedRevision?: number,
    ): Promise<boolean> => {
      if (!owner) return false
      requestRef.current?.abort()
      setBusy(true)
      setFailed(false)
      const controller = new AbortController()
      requestRef.current = controller
      const current = () => !controller.signal.aborted && ownerRef.current === owner
      try {
        // 组内已读取版本时不再加载全库覆盖；旧调用方仍走原有版本查询。
        const overrides =
          expectedRevision === undefined ? await loadEntryOverrides(controller.signal) : null
        // 账号切换后不能用旧条目版本继续提交下一步人工覆盖。
        if (!current()) return false
        const revision = expectedRevision ?? overrides?.get(inputSeq)?.override?.revision ?? 0
        await readingRequest(
          `processing/entries/${inputSeq}/override`,
          mutationSchemas.override,
          controller.signal,
          { mode, expectedRevision: revision },
        )
        if (!current()) return false
        await refreshServiceProcessingRoles(controller.signal)
        return current()
      } catch {
        if (current()) setFailed(true)
        return false
      } finally {
        if (current()) setBusy(false)
      }
    },
    [owner],
  )

  return { setMode, busy, failed }
}
