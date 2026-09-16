import { z } from "zod"

import { oneTimeToken } from "~/lib/auth"

import { informationRequestInit } from "./request-init"
import { getOneTimeToken } from "./session"

export const xQueryStatusSchema = z.enum([
  "idle",
  "pending",
  "complete",
  "budget",
  "unconfigured",
  "rate_limited",
  "forbidden",
  "insufficient_access",
  "billing",
  "failed",
])

const xQueryStateSchema = z
  .object({
    queryId: z.string().uuid(),
    nextToken: z.string().nullable(),
    scanSinceId: z.string().nullable(),
    candidateHighWaterId: z.string().nullable(),
    highWaterId: z.string().nullable(),
    pending: z.boolean(),
    status: xQueryStatusSchema,
    failure: z.string().nullable(),
    retryAt: z.iso.datetime().nullable(),
    updatedAt: z.iso.datetime(),
  })
  .strict()

const xQueryBaseSchema = z
  .object({
    id: z.string().uuid(),
    sourceKey: z.string().min(1),
    query: z.string().min(1).max(512),
    title: z.string().min(1).max(120),
    view: z.number().int().nonnegative(),
    category: z.string().min(1).max(120).nullable(),
    enabled: z.boolean(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict()

export const xQuerySchema = xQueryBaseSchema.extend({ state: xQueryStateSchema }).strict()

export const xSettingsSchema = z
  .object({
    enabled: z.boolean(),
    configured: z.boolean(),
    access: z.enum(["recent_search", "full_archive"]),
    billingNotice: z.string(),
  })
  .strict()

export const xQueriesSchema = z
  .object({
    queries: z.array(xQuerySchema),
    sources: z.array(
      z
        .object({
          key: z.string().min(1),
          kind: z.literal("x_search"),
          id: z.string().uuid(),
          title: z.string(),
          view: z.number().int().nonnegative(),
          category: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict()

const xMutationQuerySchema = xQueryBaseSchema
const xDeletedSchema = z.object({ deleted: z.literal(true) }).strict()
const xSyncSchema = z
  .object({
    results: z.array(
      z
        .object({
          queryId: z.string().uuid(),
          entries: z.number().int().nonnegative(),
          pages: z.number().int().nonnegative(),
          status: xQueryStatusSchema,
          pending: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict()

export type XSettings = z.infer<typeof xSettingsSchema>
export type XQuery = z.infer<typeof xQuerySchema>
export type XQueryInput = {
  query: string
  title: string
  view: number
  category: string | null
  enabled: boolean
}
export type XSettingsInput = {
  enabled: boolean
  bearerToken?: string
  access: XSettings["access"]
}

export class XRequestError extends Error {
  constructor(readonly kind: "authorization" | "request") {
    super(kind)
  }
}

async function request<T>(
  path: string,
  method: "DELETE" | "GET" | "POST" | "PUT",
  schema: z.ZodType<T>,
  signal: AbortSignal,
  body?: object,
): Promise<T> {
  // 每个请求都获取新的主站一次性凭据，不能跨请求或账号复用。
  const token = await oneTimeToken.generate().then(getOneTimeToken)
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
  if (!response.ok) {
    throw new XRequestError([401, 403].includes(response.status) ? "authorization" : "request")
  }
  const parsed = schema.safeParse(await response.json())
  if (!parsed.success) throw new XRequestError("request")
  return parsed.data
}

export const loadX = (signal: AbortSignal) =>
  Promise.all([
    request("x/settings", "GET", xSettingsSchema, signal),
    request("x/queries", "GET", xQueriesSchema, signal),
  ])

export const saveXSettings = (value: XSettingsInput, signal: AbortSignal) =>
  request("x/settings", "PUT", xSettingsSchema, signal, value)

export const createXQuery = (value: XQueryInput, signal: AbortSignal) =>
  request("x/queries", "POST", xMutationQuerySchema, signal, value)

export const updateXQuery = (id: string, value: XQueryInput, signal: AbortSignal) =>
  request(`x/queries/${id}`, "PUT", xMutationQuerySchema, signal, value)

export const deleteXQuery = (id: string, signal: AbortSignal) =>
  request(`x/queries/${id}`, "DELETE", xDeletedSchema, signal)

export const syncX = (signal: AbortSignal) =>
  // 同步只能由用户显式触发，空对象由服务端严格校验，不能夹带搜索参数。
  request("x/sync", "POST", xSyncSchema, signal, {})
