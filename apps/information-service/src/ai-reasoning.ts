import { z } from "zod"

export const reasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
])
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>

// 无字段的旧设置固定 low；外部模型保留当前协议行为，不能假装支持 Codex 的强度。
export function aiReasoningEffort(config: {
  provider?: string
  reasoningEffort?: ReasoningEffort
}): ReasoningEffort {
  return config.provider === "codex" ? (config.reasoningEffort ?? "low") : "low"
}

// low 与旧缓存兼容，其他强度必须分开缓存，不能复用不同推理预算的结果。
export function reasoningFingerprint(effort: ReasoningEffort | undefined) {
  return effort && effort !== "low" ? effort : undefined
}
