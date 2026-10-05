import type { GeneratedReaderItem } from "./generated-feed-client"

/** 原文与综述使用显式目标类型，综述身份不能进入官方 entryId。 */
export type ReaderTarget =
  | { kind: "entry"; entryId: string; sourceKey?: string }
  | { kind: "story"; storyId: string; revision?: number }

export function readReaderTarget(
  entryId: string | undefined,
  params: URLSearchParams,
): ReaderTarget | null {
  const storyId = params.get("story")
  if (storyId) return { kind: "story", storyId }
  if (entryId && entryId !== "pending") return { kind: "entry", entryId }
  // 旧链接仅作为兼容输入，选中后由原生路径承载原文身份。
  const legacy = params.get("item")
  if (legacy?.startsWith("story:") && legacy.length > 6)
    return { kind: "story", storyId: legacy.slice(6) }
  const entry = legacy?.match(/^entry:([^:]+):(.+)$/u)
  return entry ? { kind: "entry", sourceKey: entry[1], entryId: entry[2]! } : null
}

export const targetForReaderItem = (item: GeneratedReaderItem): ReaderTarget =>
  item.kind === "story"
    ? { kind: "story", storyId: item.storyId, revision: item.revision }
    : { kind: "entry", entryId: item.id, sourceKey: item.sourceKey }

export function readerItemMatchesTarget(item: GeneratedReaderItem, target: ReaderTarget | null) {
  if (!target) return false
  return target.kind === "story"
    ? item.kind === "story" && item.storyId === target.storyId
    : item.kind === "entry" &&
        item.id === target.entryId &&
        (!target.sourceKey || item.sourceKey === target.sourceKey)
}

/** 切换综述仅调整目标参数，保留搜索日期等范围；原生 entryId 回到 pending。 */
export function storyReaderLocation(pathname: string, params: URLSearchParams, storyId: string) {
  const search = new URLSearchParams(params)
  search.delete("item")
  search.set("story", storyId)
  const segments = pathname.split("/")
  const nextPath =
    segments[1] === "timeline" && segments.length >= 4
      ? [...segments.slice(0, 4), "pending"].join("/")
      : pathname
  return { pathname: nextPath, search: `?${search}` }
}

/** 严格校验日历日期，避免无效日期进位或在渲染期间抛错。 */
export function validReaderDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return ""
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : ""
}
