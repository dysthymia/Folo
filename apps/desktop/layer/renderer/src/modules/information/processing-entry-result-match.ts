import type { SemanticEntity, SemanticTagId } from "@follow/information-core"

export type ProcessingEntryResult = {
  itemId: string
  sourceKey: string
  sourceId: string | null
  inputSeq: number
  decisionId: string
  contentVersion: string
  releaseVersion: number
  // 标签随当前决定的批量索引加载；旧服务没有此字段时保持原列表布局。
  semanticTags?: readonly SemanticTagId[]
  // 具体名称与标签共用批量索引，列表渲染无需逐条查询。
  semanticEntities?: readonly SemanticEntity[]
}

export type ProcessingEntryIdentity = Pick<
  ProcessingEntryResult,
  "itemId" | "sourceKey" | "sourceId"
>

// 状态只需证明有一个同源的已完成决定；多个清单结果不妨碍显示“已处理”。
export function hasProcessingEntry(
  entries: readonly ProcessingEntryIdentity[],
  entryId: string,
  sourceIds: readonly string[],
): boolean {
  return entries.some(
    (item) => item.itemId === entryId && !!item.sourceId && sourceIds.includes(item.sourceId),
  )
}

// 同一条目可能从多个清单进入处理服务；只接受能确定真实来源的唯一决定。
export function resolveProcessingEntryResult<T extends ProcessingEntryIdentity>(
  entries: readonly T[],
  entryId: string,
  sourceIds: readonly string[],
): T | null {
  const candidates = entries.filter(
    (item) => item.itemId === entryId && item.sourceId && sourceIds.includes(item.sourceId),
  )
  const direct = candidates.filter((item) => item.sourceKey === item.sourceId)
  if (direct.length === 1) return direct[0]!
  return candidates.length === 1 ? candidates[0]! : null
}
