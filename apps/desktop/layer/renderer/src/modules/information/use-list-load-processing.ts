import { entryActions } from "@follow/store/entry/store"
import type { EntryModel } from "@follow/store/entry/types"
import { useUserStore } from "@follow/store/user/store"
import { useEffect, useMemo, useRef } from "react"

import type { ProcessingListEntry } from "~/modules/action/processing-client"
import { createProcessingClient } from "~/modules/action/processing-client"
import { getOneTimeToken, isLocalFoloHost } from "~/modules/ai-chat/local-provider"

const client = createProcessingClient(getOneTimeToken)
const LOAD_DEBOUNCE_MS = 400
const REPEAT_COOLDOWN_MS = 60_000
const MAX_ENTRIES_PER_REQUEST = 100
export type LoadedEntryRef = { entryId: string; sourceKey: string }

/** 只搬运加载结果的元信息；当前读态以官方 store 为准，正文继续交给后台水合。 */
export function listedProcessingEntries(
  refs: readonly LoadedEntryRef[],
  entries: Record<string, EntryModel>,
): ProcessingListEntry[] {
  const seen = new Set<string>()
  return refs.flatMap(({ entryId, sourceKey }) => {
    const entry = entries[entryId]
    const key = `${sourceKey}\u0000${entryId}`
    if (!entry || seen.has(key) || !/^(?:feed|list|inbox)\/[^/\s]+$/.test(sourceKey)) return []
    const publishedAt = new Date(entry.publishedAt)
    if (!Number.isFinite(publishedAt.getTime())) return []
    seen.add(key)
    // 无标题、无绝对URL的条目仍可能有有效正文，不能因此阻塞整批自动化。
    const url = entry.url && URL.canParse(entry.url) ? entry.url : null
    return [
      {
        id: entryId,
        sourceKey,
        title: (entry.title ?? "").slice(0, 2000),
        publishedAt: publishedAt.toISOString(),
        url,
        read: typeof entry.read === "boolean" ? entry.read : null,
        description: entry.description?.slice(0, 2000) ?? null,
      },
    ]
  })
}

/** 加载完成后异步排队，不等待模型结果，也不因处理角色轮询重复启动规则。 */
export function useListLoadProcessing({
  refs,
  owner,
  enabled,
  loadVersion,
}: {
  refs: readonly LoadedEntryRef[]
  owner?: string
  enabled: boolean
  loadVersion?: number
}) {
  const packets = useMemo(() => {
    // 相同ID重新加载时也读取最新读态；角色更新本身不改变这个加载版本。
    void loadVersion
    return enabled && owner
      ? listedProcessingEntries(refs, entryActions.getFlattenMapEntries())
      : []
  }, [refs, owner, enabled, loadVersion])
  const sentRef = useRef<{ owner?: string; signatures: Map<string, number> }>({
    signatures: new Map(),
  })
  useEffect(() => {
    if (sentRef.current.owner !== owner) sentRef.current = { owner, signatures: new Map() }
    if (!enabled || !owner || !isLocalFoloHost() || packets.length === 0) return
    const controller = new AbortController()
    // 账号切换立即中止令牌交换，不能把上一账号的加载内容提交给新账号。
    const unsubscribe = useUserStore.subscribe((state) => {
      if (state.whoami?.id !== owner) controller.abort()
    })
    const timer = setTimeout(async () => {
      const now = Date.now()
      // 新的一次加载交给服务端核对规则版本；本地冷却只抑制同一加载结果的重渲染与翻页重叠。
      const signature = (entry: ProcessingListEntry) => JSON.stringify([loadVersion, entry])
      const pending = packets.filter((entry) => {
        const at = sentRef.current.signatures.get(signature(entry))
        return at === undefined || now - at >= REPEAT_COOLDOWN_MS
      })
      for (
        let offset = 0;
        offset < pending.length && !controller.signal.aborted;
        offset += MAX_ENTRIES_PER_REQUEST
      ) {
        const batch = pending.slice(offset, offset + MAX_ENTRIES_PER_REQUEST)
        try {
          await client.notifyListLoaded(batch, controller.signal)
          if (controller.signal.aborted) break
          for (const entry of batch) sentRef.current.signatures.set(signature(entry), Date.now())
        } catch {
          // 网络失败不影响原文列表；下一次实际加载可重试，不在渲染期间循环请求。
          break
        }
      }
      // 仅保留短冷却记录，长时间阅读和翻页不会持续堆积正文元信息。
      for (const [signature, at] of sentRef.current.signatures)
        if (Date.now() - at >= REPEAT_COOLDOWN_MS) sentRef.current.signatures.delete(signature)
    }, LOAD_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
      unsubscribe()
    }
  }, [enabled, owner, packets, loadVersion])
}
