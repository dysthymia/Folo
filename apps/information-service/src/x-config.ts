import { randomUUID } from "node:crypto"
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"

import { dirname } from "pathe"
import { z } from "zod"

const diskSchema = z
  .object({
    enabled: z.boolean().default(false),
    bearerToken: z.string().min(1).nullable().default(null),
    access: z.enum(["recent_search", "full_archive"]).default("recent_search"),
    billingNotice: z.string().max(500).default("按 X Developer Console 的实际用量与权限执行"),
  })
  .strict()
const updateSchema = z
  .object({
    enabled: z.boolean().optional(),
    // 空字符串表示不改已有 token，不能因为表单提交清空私有凭据。
    bearerToken: z.string().max(10_000).optional(),
    access: z.enum(["recent_search", "full_archive"]).optional(),
    billingNotice: z.string().min(1).max(500).optional(),
  })
  .strict()

export type XConfig = z.infer<typeof diskSchema>
export type XConfigUpdate = z.infer<typeof updateSchema>
export type XPublicConfig = Pick<XConfig, "enabled" | "access" | "billingNotice"> & {
  configured: boolean
}
export class XConfigError extends Error {
  constructor(public readonly code: "incomplete") {
    super(code)
  }
}

// X 凭据单独保存在 0600 文件，绝不回传、打印或从其他应用配置推断。
export function readXConfig(path: string): XConfig | null {
  try {
    if (!existsSync(path) || (statSync(path).mode & 0o077) !== 0) return null
    return diskSchema.parse(JSON.parse(readFileSync(path, "utf8")))
  } catch {
    return null
  }
}

export function saveXConfig(path: string, value: unknown): XPublicConfig {
  const update = updateSchema.parse(value)
  const current = readXConfig(path) ?? diskSchema.parse({})
  const bearerToken = update.bearerToken?.trim() || current.bearerToken
  const next: XConfig = {
    enabled: update.enabled ?? current.enabled,
    bearerToken,
    access: update.access ?? current.access,
    billingNotice: update.billingNotice ?? current.billingNotice,
  }
  if (next.enabled && !next.bearerToken) throw new XConfigError("incomplete")
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  let fd: number | null = null
  try {
    fd = openSync(temporary, "wx", 0o600)
    writeFileSync(fd, JSON.stringify(next), "utf8")
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(temporary, path)
    chmodSync(path, 0o600)
  } catch (error) {
    if (fd !== null) closeSync(fd)
    if (existsSync(temporary)) unlinkSync(temporary)
    throw error
  }
  return publicXConfig(next)
}

export function publicXConfig(config: XConfig | null): XPublicConfig {
  const base = config ?? diskSchema.parse({})
  return {
    enabled: base.enabled,
    configured: Boolean(base.enabled && base.bearerToken),
    access: base.access,
    billingNotice: base.billingNotice,
  }
}
