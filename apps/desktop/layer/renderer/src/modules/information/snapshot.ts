import { z } from "zod"

// 在网络边界校验快照，避免把缺失或损坏的数据展示为正常结果。
export const informationSnapshotSchema = z.object({
  ownerId: z.string().nullable(),
  sources: z.array(
    z.object({
      key: z.string(),
      kind: z.enum(["feed", "list", "inbox", "x_search"]),
      id: z.string(),
      title: z.string(),
      view: z.number(),
      category: z.string().nullable(),
    }),
  ),
  items: z.array(
    z.object({
      id: z.string(),
      sourceKey: z.string(),
      title: z.string(),
      url: z.string().nullable(),
      publishedAt: z.string(),
    }),
  ),
  jobs: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(["scan", "process"]),
      status: z.enum(["queued", "running", "succeeded", "failed"]),
      error: z.string().nullable(),
      createdAt: z.string(),
      updatedAt: z.string(),
      sourceKey: z.string().nullable(),
      itemId: z.string().nullable(),
      // 扫描成功只代表本次任务结束，仍需保留分页覆盖范围。
      pages: z.number().int().nonnegative().optional(),
      coverage: z.enum(["pending", "budget", "end", "timestamp_boundary"]).optional(),
    }),
  ),
  results: z.array(
    z.object({
      id: z.string(),
      itemId: z.string(),
      sourceKey: z.string(),
      title: z.string(),
      model: z.string(),
      material: z.enum(["source_text", "description_only"]),
      createdAt: z.string(),
      payload: z.object({ summary: z.string(), points: z.array(z.string()), entryId: z.string() }),
    }),
  ),
})

export type InformationSnapshot = z.infer<typeof informationSnapshotSchema>

// 原文 URL 来自外部内容，只允许常规网页协议。
export function getInformationArticleUrl(value: string | null | undefined) {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null
  } catch {
    return null
  }
}
