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

const rawConfigSchema = z
  .object({
    notion: z
      .object({
        enabled: z.boolean().optional(),
        token: z.string().min(1).nullable().optional(),
        parentPageId: z.uuid().nullable().optional(),
      })
      .strict(),
  })
  .strict()

const settingsSchema = z
  .object({
    notion: z
      .object({
        enabled: z.boolean().optional(),
        token: z.string().max(10_000).optional(),
        parentPageId: z.uuid().optional(),
      })
      .strict(),
  })
  .strict()

export type ExternalConfig = {
  notion: { enabled: boolean; token: string | null; parentPageId: string | null }
}
export type ExternalSettingsInput = z.infer<typeof settingsSchema>
export type PublicIntegrationSettings = {
  notion: { enabled: boolean; parentPageId: string | null }
}

// 外接凭据仅从独立 0600 文件读取；公共设置永远不会回传 token。
export function readExternalConfig(path: string): ExternalConfig | null {
  try {
    if (!existsSync(path) || (statSync(path).mode & 0o077) !== 0) return null
    return normalize(rawConfigSchema.parse(JSON.parse(readFileSync(path, "utf8"))))
  } catch {
    return null
  }
}

// 设置写入在同目录临时文件完成后原子替换，避免半写入的私有配置被服务读取。
export function saveExternalConfig(path: string, value: unknown): PublicIntegrationSettings {
  const input = settingsSchema.parse(value).notion
  const current = readExternalConfig(path)
  const token = input.token?.trim() || current?.notion.token || null
  const parentPageId = input.parentPageId ?? current?.notion.parentPageId ?? null
  const enabled = input.enabled ?? current?.notion.enabled ?? false
  if (enabled && (!token || !parentPageId)) throw new ExternalConfigError("notion_incomplete")

  const next: ExternalConfig = { notion: { enabled, token, parentPageId } }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  let descriptor: number | null = null
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600)
    writeFileSync(descriptor, JSON.stringify(next), "utf8")
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = null
    renameSync(temporaryPath, path)
    chmodSync(path, 0o600)
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor)
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
    throw error
  }
  return toPublic(next)
}

export function publicSettings(path: string): PublicIntegrationSettings {
  const config = readExternalConfig(path)
  return toPublic(config)
}

function normalize(value: z.infer<typeof rawConfigSchema>): ExternalConfig {
  return {
    notion: {
      enabled: value.notion.enabled ?? true,
      token: value.notion.token ?? null,
      parentPageId: value.notion.parentPageId ?? null,
    },
  }
}

function toPublic(config: ExternalConfig | null): PublicIntegrationSettings {
  return {
    notion: {
      enabled: Boolean(config?.notion.enabled && config.notion.token && config.notion.parentPageId),
      parentPageId: config?.notion.parentPageId ?? null,
    },
  }
}

export class ExternalConfigError extends Error {
  constructor(public readonly code: "notion_incomplete") {
    super(code)
  }
}
