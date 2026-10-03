export type ProcessingEntryResult = {
  itemId: string
  sourceKey: string
  sourceId: string | null
  inputSeq: number
  decisionId: string
  contentVersion: string
  releaseVersion: number
}

// 同一条目可能从多个清单进入处理服务；只接受能确定真实来源的唯一决定。
export function resolveProcessingEntryResult(
  entries: readonly ProcessingEntryResult[],
  entryId: string,
  sourceIds: readonly string[],
): ProcessingEntryResult | null {
  const candidates = entries.filter(
    (item) => item.itemId === entryId && item.sourceId && sourceIds.includes(item.sourceId),
  )
  const direct = candidates.filter((item) => item.sourceKey === item.sourceId)
  if (direct.length === 1) return direct[0]!
  return candidates.length === 1 ? candidates[0]! : null
}
