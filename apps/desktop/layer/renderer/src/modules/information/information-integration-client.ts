import { z } from "zod"

import { oneTimeToken } from "~/lib/auth"

import { informationRequestInit } from "./request-init"
import { getOneTimeToken, InformationLoadError } from "./session"

const isoDateTime = z.iso.datetime({ offset: true })
const integrationSettingsSchema = z
  .object({
    integrations: z
      .object({
        notion: z.object({ enabled: z.boolean(), parentPageId: z.string().nullable() }).strict(),
      })
      .strict(),
  })
  .strict()
const exportSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(["story", "entry"]),
    storyId: z.uuid().nullable(),
    entry: z
      .object({
        inputSeq: z.number().int().positive(),
        sourceKey: z.string(),
        itemId: z.string(),
        contentVersion: z.string(),
        title: z.string(),
      })
      .strict()
      .nullable(),
    revision: z.number().int().positive(),
    destinationId: z.string().min(1),
    contentHash: z.string().min(1),
    operation: z.enum(["create", "append"]),
    status: z.enum(["prepared", "sending", "succeeded", "failed", "unknown", "retry_after"]),
    notionPageId: z.string().nullable(),
    retryAfter: isoDateTime.nullable(),
    error: z.string().nullable(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
  })
  .strict()
const previewSchema = z
  .object({
    storyId: z.uuid(),
    revision: z.number().int().positive(),
    title: z.string(),
    markdown: z.string(),
    references: z.array(
      z
        .object({
          inputSeq: z.number().int().positive(),
          sourceKey: z.string(),
          itemId: z.string(),
          title: z.string(),
          url: z.string().nullable(),
          quote: z.string(),
        })
        .strict(),
    ),
  })
  .strict()
export const integrationsSettingsResponseSchema = integrationSettingsSchema
export const exportsResponseSchema = z
  .object({
    exports: z.array(exportSchema),
    integrations: integrationSettingsSchema.shape.integrations,
  })
  .strict()
export const prepareExportResponseSchema = z.union([
  z
    .object({
      disabled: z.literal(true),
      integrations: integrationSettingsSchema.shape.integrations,
    })
    .strict(),
  z.object({ export: exportSchema, preview: previewSchema }).strict(),
])
export const exportResponseSchema = z.object({ export: exportSchema }).strict()
export type IntegrationSettings = z.infer<typeof integrationSettingsSchema>["integrations"]
export type ExternalExport = z.infer<typeof exportSchema>
export type ExportPreview = z.infer<typeof previewSchema>
export class IntegrationRequestError extends Error {
  constructor(readonly kind: "authorization" | "conflict" | "request") {
    super(kind)
    this.name = "IntegrationRequestError"
  }
}

async function request<T>(
  path: string,
  method: "GET" | "PUT" | "POST",
  schema: z.ZodType<T>,
  signal: AbortSignal,
  body?: object,
): Promise<T> {
  const token = await oneTimeToken
    .generate()
    .then(getOneTimeToken)
    .catch((error: unknown) => {
      throw new IntegrationRequestError(
        error instanceof InformationLoadError &&
          ["authorization", "account_mismatch"].includes(error.kind)
          ? "authorization"
          : "request",
      )
    })
  signal.throwIfAborted()
  const response = await fetch(
    `/information/v1/${path}`,
    informationRequestInit({
      method,
      signal,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "X-Folo-One-Time-Token": token,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
  if (!response.ok)
    throw new IntegrationRequestError(
      [401, 403].includes(response.status)
        ? "authorization"
        : response.status === 409
          ? "conflict"
          : "request",
    )
  const parsed = schema.safeParse(await response.json())
  if (!parsed.success) throw new IntegrationRequestError("request")
  signal.throwIfAborted()
  return parsed.data
}

export const loadIntegrationSettings = (signal: AbortSignal) =>
  request("integrations/settings", "GET", integrationsSettingsResponseSchema, signal)
export const saveIntegrationSettings = (
  input: { notion: { enabled: boolean; token?: string; parentPageId?: string } },
  signal: AbortSignal,
) => request("integrations/settings", "PUT", integrationsSettingsResponseSchema, signal, input)
export const loadExports = (signal: AbortSignal) =>
  request("exports", "GET", exportsResponseSchema, signal)
export const prepareExport = (
  storyId: string,
  destinationPageId: string | undefined,
  signal: AbortSignal,
) =>
  request("exports", "POST", prepareExportResponseSchema, signal, {
    storyId,
    ...(destinationPageId ? { destinationPageId } : {}),
  })
export const confirmExport = (id: string, signal: AbortSignal) =>
  request(`exports/${encodeURIComponent(id)}/confirm`, "POST", exportResponseSchema, signal, {})
export const reconcileExport = (id: string, signal: AbortSignal) =>
  request(`exports/${encodeURIComponent(id)}/reconcile`, "POST", exportResponseSchema, signal, {})
