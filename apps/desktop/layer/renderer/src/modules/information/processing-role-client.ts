import type { EntryProcessingServiceRole } from "@follow/store/entry/processing-role"
import { entryProcessingRoleActions } from "@follow/store/entry/processing-role"
import { useEffect } from "react"
import { z } from "zod"

import { isLocalFoloHost } from "~/modules/ai-chat/local-provider"

import { readingRequest, ReadingRequestError } from "./processing-reader-client"

const entryRoleSchema = z
  .object({
    itemId: z.string().min(1),
    inputSeq: z.number().int().positive(),
    // `keeper` 来自服务端的语义去重：它保留了内容，角标列出被并入的条目。
    // `restored` 是用户手动恢复的条目，它豁免隐藏与并入，时间线要照常显示。
    kind: z.enum(["hidden", "story", "merged", "keeper", "restored"]),
    reason: z.string().nullable(),
    relatedEntryIds: z.array(z.string().min(1)),
    storyId: z.string().nullable(),
    storyTitle: z.string().nullable(),
  })
  .strict()
export const processingEntryRolesResponseSchema = z
  .object({ roles: z.array(entryRoleSchema) })
  .strict()

export type ProcessingEntryRole = z.infer<typeof entryRoleSchema>

export const loadProcessingEntryRoles = (signal: AbortSignal) =>
  readingRequest("processing/roles", processingEntryRolesResponseSchema, signal)

/**
 * 服务端角色只是搬运：判定（隐藏、综述成员、同内容转载）全部由处理服务给出，
 * 客户端不再重算，避免出现第二套口径。
 */
export function toServiceProcessingRoles(
  roles: ProcessingEntryRole[],
): EntryProcessingServiceRole[] {
  return roles.map((role) => ({
    entryId: role.itemId,
    kind: role.kind,
    reason: role.reason,
    relatedEntryIds: role.relatedEntryIds,
    inputSeq: role.inputSeq,
    ...(role.storyId ? { storyId: role.storyId } : {}),
    ...(role.storyTitle ? { storyTitle: role.storyTitle } : {}),
  }))
}

// 角色是全局状态：同一时刻只允许一个请求，重入复用同一次结果。
let pendingSync: Promise<void> | null = null

export function syncServiceProcessingRoles(): Promise<void> {
  pendingSync ??= loadProcessingEntryRoles(new AbortController().signal)
    .then((response) => {
      entryProcessingRoleActions.replaceServiceRoles(toServiceProcessingRoles(response.roles))
    })
    .catch((error: unknown) => {
      // 换账号后旧角色的归属已经无效，其余失败保留上一次结果，避免时间线闪烁。
      if (error instanceof ReadingRequestError && error.kind === "authorization")
        entryProcessingRoleActions.clearServiceRoles()
    })
    .finally(() => {
      pendingSync = null
    })

  return pendingSync
}

/**
 * 写入覆盖（恢复／隐藏）之后的强制刷新。
 *
 * 不能直接复用 `syncServiceProcessingRoles`：它为了让「同一时刻只发一次请求」而做了重入门闩，
 * 覆盖写入后如果恰好有一次轮询在途，就会拿到写入**之前**发起的响应，界面上表现为「点了没反应」，
 * 要等下一次轮询（最长 60s）才生效。这里先等在途请求收尾，再发起一次全新的读取。
 */
export async function refreshServiceProcessingRoles(): Promise<void> {
  const inFlight = pendingSync
  if (inFlight) await inFlight.catch(() => {})
  pendingSync = null
  await syncServiceProcessingRoles()
}

/**
 * 把处理服务的决策接进时间线。只在处理服务可用的部署（`local.folo.is`）下工作，
 * 正式站点不请求本地服务。
 *
 * 后台跑完一轮不会主动通知渲染层，因此除挂载与切回标签页之外，可见期间按固定间隔
 * 轮询一次：间隔远大于一轮处理的耗时量级，代价是每分钟一个本机请求。
 */
const ROLE_POLL_INTERVAL_MS = 60_000

export function useServiceProcessingRoles() {
  useEffect(() => {
    if (!isLocalFoloHost()) return

    void syncServiceProcessingRoles()
    const handleVisibilityChange = () => {
      // 后台跑完一轮或切回标签页时刷新，阅读期间不主动跳位。
      if (document.visibilityState === "visible") void syncServiceProcessingRoles()
    }
    document.addEventListener("visibilitychange", handleVisibilityChange)
    // 后台任务没有推送通道，只能在可见时轮询；隐藏时停表，避免无意义的本机请求。
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void syncServiceProcessingRoles()
    }, ROLE_POLL_INTERVAL_MS)

    return () => {
      clearInterval(timer)
      document.removeEventListener("visibilitychange", handleVisibilityChange)
    }
  }, [])
}
