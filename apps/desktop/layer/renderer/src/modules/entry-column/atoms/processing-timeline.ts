import { atom } from "jotai"

/**
 * 时间线内容口径（§2 D3）。
 *
 * - `processed`：显示 AI 处理后的结果，被隐藏与被并入的条目不占位（默认）。
 * - `original`：同一范围、同一排序，但恢复显示全部条目，计数随之恢复。
 *
 * 两态都只影响渲染层的角色过滤，不改任何一条原文的 read 状态（§5.2），
 * 也不改服务端的决策。
 */
export type TimelineContentMode = "processed" | "original"

export const timelineContentModeAtom = atom<TimelineContentMode>("processed")
