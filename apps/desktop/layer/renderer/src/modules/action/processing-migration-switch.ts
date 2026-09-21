import { z } from "zod"

const pendingLocalSwitchSchema = z
  .object({
    migratedRuleId: z.string().min(1),
    index: z.number().int().nonnegative(),
    name: z.string().min(1),
    condition: z.unknown(),
    result: z.unknown(),
  })
  .strict()

export type LocalMigrationSwitchTarget = Omit<
  z.infer<typeof pendingLocalSwitchSchema>,
  "migratedRuleId"
>
export type PendingLocalMigrationSwitch = z.infer<typeof pendingLocalSwitchSchema>

const storageKey = (ownerId: string) => `follow:processing-migration-switch:v1:${ownerId}`

export const loadPendingLocalMigrationSwitches = (
  ownerId: string,
): PendingLocalMigrationSwitch[] => {
  try {
    const raw = window.localStorage.getItem(storageKey(ownerId))
    if (!raw) return []
    return z.array(pendingLocalSwitchSchema).parse(JSON.parse(raw) as unknown)
  } catch {
    return []
  }
}

export const savePendingLocalMigrationSwitches = (
  ownerId: string,
  targets: readonly PendingLocalMigrationSwitch[],
) => {
  // 空集合直接清理，避免换账号或删除迁移草稿后残留停用意图。
  if (targets.length === 0) {
    window.localStorage.removeItem(storageKey(ownerId))
    return
  }
  window.localStorage.setItem(storageKey(ownerId), JSON.stringify(targets))
}
