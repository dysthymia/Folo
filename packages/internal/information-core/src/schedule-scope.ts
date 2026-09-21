import { z } from "zod"

// §2 D4 运行范围三态：落库只存描述符；只有固定名单保存名单快照。
// 三种范围共用同一份解析（见 resolveScheduleSourceKeys），避免「全局说明不覆盖后来新增的订阅」。
export const scheduleScopeSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all") }).strict(),
  z
    .object({
      mode: z.literal("category"),
      view: z.number().int().min(0).max(5),
      category: z.string().trim().min(1).max(200),
    })
    .strict(),
  z
    .object({
      mode: z.literal("fixed"),
      sourceKeys: z.array(z.string().min(1).max(300)).min(1).max(10000),
    })
    .strict(),
])
export type ScheduleScope = z.infer<typeof scheduleScopeSchema>

// 客户端视角的源条目，用于把 all/category 解析成固定名单。
// 服务端若持有订阅清单（含 view/category）也可复用同一解析。
export type ScheduleSourceView = {
  key: string
  view: number
  category: string | null
}

const sourceKeySchema = z.string().min(1).max(300)

export const scheduleSourceKeysSchema = z.array(sourceKeySchema).min(1).max(10000)

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object"
}

function uniqueSorted(keys: string[]): string[] {
  return [...new Set(keys)].sort()
}

/**
 * 把范围描述符解析为实际 sourceKeys。这是运行范围读取与发布目标解析共用的唯一实现：
 * - fixed 直接用名单快照，不自动纳入新来源；
 * - all 展开为全部源；
 * - category 只展开落在指定 view/category 的源（该分类下的新来源会在重新解析时纳入）。
 *
 * 服务端不独立维护订阅分类体系；client 用本地订阅/分类数据解析并把结果一并落库，
 * 服务端读取「描述符 + 已解析结果」执行（详见开发输入文档 §9 偏离说明）。
 */
export function resolveScheduleSourceKeys(
  scope: ScheduleScope,
  sources: readonly ScheduleSourceView[],
): string[] {
  if (scope.mode === "fixed") return [...scope.sourceKeys]
  if (scope.mode === "all") {
    return uniqueSorted(sources.map((source) => source.key))
  }
  const category = scope.category
  return uniqueSorted(
    sources
      .filter((source) => source.view === scope.view && source.category === category)
      .map((source) => source.key),
  )
}

/**
 * 归一化范围描述符：旧记录只有扁平 sourceKeys（没有 mode），等价 fixed（§2 D4 向后兼容）。
 * 新记录在 sourceKeys 之外显式携带 mode 描述符。
 */
export function normalizeScheduleScope(raw: unknown): ScheduleScope {
  const withMode = scheduleScopeSchema.safeParse(raw)
  if (withMode.success) return withMode.data
  if (isRecord(raw) && Array.isArray(raw.sourceKeys)) {
    const keys = scheduleSourceKeysSchema.safeParse(raw.sourceKeys)
    if (keys.success) return { mode: "fixed", sourceKeys: keys.data }
  }
  throw new Error("invalid_schedule_scope")
}

/**
 * 从保存的配置（可能旧格式）取出范围描述符，并确保返回一个与描述符一致的 sourceKeys。
 * 旧记录（只有 sourceKeys）等价 fixed；fixed 模式的 sourceKeys 以描述符为准。
 */
export function normalizeScheduleScopeWithKeys(raw: unknown): {
  scope: ScheduleScope
  sourceKeys: string[]
} {
  const scope = normalizeScheduleScope(raw)
  if (scope.mode === "fixed") return { scope, sourceKeys: [...scope.sourceKeys] }
  // all / category 的已解析结果需由调用方用 resolveScheduleSourceKeys 补充。
  return { scope, sourceKeys: [] }
}
