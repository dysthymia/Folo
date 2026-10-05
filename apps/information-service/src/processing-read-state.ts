import type { ProcessingInput } from "./automation-store"

export type ProcessingReadStateLookup = (
  sourceKey: string,
  itemId: string,
) => { read?: boolean | null } | null | undefined

// 日常 AI 只接受明确未读。已提供实时查询却查不到条目时，不回退到输入里的旧未读快照。
export function inputReadState(
  input: ProcessingInput,
  currentEntry?: ProcessingReadStateLookup,
): boolean | null {
  const entry = currentEntry ? currentEntry(input.sourceKey, input.itemId) : input.body
  return entryReadState(entry)
}

// 未知读态保留为 null，不能暗中当成未读而产生模型费用。
export function entryReadState(
  entry: { read?: boolean | null } | null | undefined,
): boolean | null {
  return typeof entry?.read === "boolean" ? entry.read : null
}
