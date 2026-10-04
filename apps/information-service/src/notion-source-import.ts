import { z } from "zod"

import type { Source } from "./folo"
import { missingMaterialContext } from "./material-context"
import type { Store } from "./store"

const accountSchema = z.object({
  id: z.string().min(1),
  username: z.string().optional(),
  userId: z.string().regex(/^\d+$/u).optional(),
  url: z.string().optional(),
  active: z.boolean().optional(),
  tags: z.array(z.string().trim().min(1).max(100)),
})
export type NotionSourceAccount = z.infer<typeof accountSchema>

// 显示名称不作为身份；统一 URL、@ 前缀与大小写后只匹配 X 账号。
export function normalizeXUsername(value: string | undefined): string | null {
  if (!value) return null
  let username = value.trim()
  if (/^https?:\/\//iu.test(username)) {
    try {
      const url = new URL(username)
      if (!/^(?:(?:www|mobile)\.)?(?:x\.com|twitter\.com)$/u.test(url.hostname)) return null
      username = url.pathname.split("/")[1] ?? ""
    } catch {
      return null
    }
  }
  username = username.replace(/^@/u, "").toLowerCase()
  return /^[a-z\d_]{1,15}$/u.test(username) &&
    !["i", "home", "search", "intent", "share"].includes(username)
    ? username
    : null
}

function sourceIdentity(source: Source) {
  const usernames = new Set<string>()
  for (const value of [source.xUsername, source.siteUrl]) {
    const username = normalizeXUsername(value ?? undefined)
    if (username) usernames.add(username)
  }
  let userId = source.xUserId ?? null
  try {
    const route = new URL(source.feedUrl ?? "").pathname
    // RSSHub route 是账号身份的依据，分类路由与 display title 不参与匹配。
    const match = /^\/(?:twitter|x)\/(user|user_by_id)\/([^/]+)/u.exec(route)
    if (match?.[1] === "user_by_id") userId ??= /^\d+$/u.test(match[2]!) ? match[2]! : null
    else if (match) {
      const username = normalizeXUsername(decodeURIComponent(match[2]!))
      if (username) usernames.add(username)
    }
  } catch {
    /* 无路由时保留已有稳定身份，不猜测标题。 */
  }
  return { usernames, userId }
}

// CSV 支持双引号、逗号与跨行字段；JSON 支持规范化数组及 Notion query 的 results。
export function parseNotionSourceAccounts(
  text: string,
  format: "json" | "csv",
): NotionSourceAccount[] {
  if (format === "json") {
    const value: unknown = JSON.parse(text)
    if (Array.isArray(value)) return z.array(accountSchema).parse(value)
    return z
      .array(z.unknown())
      .parse(Reflect.get(value as object, "results"))
      .map(notionPageAccount)
  }
  const rows: string[][] = []
  let row: string[] = [],
    cell = "",
    quoted = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"'
        index++
      } else quoted = !quoted
    } else if (!quoted && (char === "," || char === "\n")) {
      row.push(cell.replace(/\r$/u, ""))
      cell = ""
      if (char === "\n") {
        rows.push(row)
        row = []
      }
    } else cell += char
  }
  if (quoted) throw new Error("invalid_csv")
  if (cell || row.length) {
    row.push(cell.replace(/\r$/u, ""))
    rows.push(row)
  }
  const headers =
    rows.shift()?.map((header) =>
      header
        .replace(/^\uFEFF/u, "")
        .trim()
        .toLowerCase(),
    ) ?? []
  const field = (values: string[], names: string[]) =>
    values[headers.findIndex((header) => names.includes(header))]?.trim() || undefined
  return rows
    .filter((values) => values.some(Boolean))
    .map((values, index) =>
      accountSchema.parse({
        id: field(values, ["id", "page id"]) ?? `csv:${index + 2}`,
        username: field(values, ["username", "用户名"]),
        userId: field(values, ["userid", "user id", "x user id"]),
        url: field(values, ["url", "link", "链接"]),
        tags: (field(values, ["tags", "标签"]) ?? "")
          .split(/[,;|]/u)
          .map((tag) => tag.trim())
          .filter(Boolean),
      }),
    )
}

function notionPageAccount(value: unknown): NotionSourceAccount {
  const page = z
    .object({
      id: z.string(),
      archived: z.boolean().optional(),
      properties: z.record(z.string(), z.unknown()),
    })
    .parse(value)
  const property = (names: string[]) =>
    Object.entries(page.properties).find(([name]) => names.includes(name.toLowerCase()))?.[1]
  const plain = (value: unknown): string | undefined => {
    if (!value || typeof value !== "object") return undefined
    const url = Reflect.get(value, "url")
    if (typeof url === "string") return url
    const parts = Reflect.get(value, "rich_text") ?? Reflect.get(value, "title")
    if (Array.isArray(parts))
      return (
        parts
          .map((part) =>
            typeof part?.plain_text === "string" ? part.plain_text : (part?.text?.content ?? ""),
          )
          .join("") || undefined
      )
    return undefined
  }
  const tags = property(["tags", "标签"])
  const options = tags && typeof tags === "object" ? Reflect.get(tags, "multi_select") : []
  return accountSchema.parse({
    id: page.id,
    // 取关或归档记录仍出现在审计结果，但不再管理来源标签。
    active:
      page.archived ||
      ["已取关", "取关", "unfollowed"].some((name) => {
        const value = property([name])
        return value && typeof value === "object" && Reflect.get(value, "checkbox") === true
      })
        ? false
        : undefined,
    username: plain(property(["username", "用户名"])),
    userId: plain(property(["user id", "x user id", "userid"])),
    url: plain(property(["url", "link", "链接"])),
    tags: z
      .array(z.object({ name: z.string() }))
      .parse(options ?? [])
      .map((option) => option.name),
  })
}

export type SourceReconciliation = {
  accountId: string
  username: string | null
  sourceKeys: string[]
  status:
    | "source_missing"
    | "identity_conflict"
    | "fetch_error"
    | "not_in_plan"
    | "needs_context"
    | "ready"
    | "awaiting_fetch"
  tagNames: string[]
  add: string[]
  remove: string[]
  lastSuccessAt: string | null
  failure: string | null
  coverage: string | null
}

export function previewNotionSourceImport(
  store: Store,
  accounts: NotionSourceAccount[],
  manager = "notion:x-accounts",
) {
  const sources = store
    .sources()
    .filter((source) => source.kind === "feed" && source.origin !== "generated")
  const planned = new Set(store.schedule.snapshot().config?.sourceKeys ?? [])
  const snapshot = store.subscriptionTags.snapshot()
  const names = new Map(snapshot.tags.map((tag) => [tag.id, tag.name]))
  const bindings = new Map(
    store.subscriptionTags
      .sourceTagBindings()
      .bindings.map((binding) => [
        binding.sourceKey,
        binding.tagIds.map((id) => names.get(id)!).filter(Boolean),
      ]),
  )
  const duplicates = new Map<string, number>()
  for (const account of accounts) {
    const identity = account.userId
      ? `id:${account.userId}`
      : `username:${normalizeXUsername(account.username ?? account.url)}`
    duplicates.set(identity, (duplicates.get(identity) ?? 0) + 1)
  }
  const rows: SourceReconciliation[] = accounts.map((account) => {
    const username = normalizeXUsername(account.username ?? account.url)
    const matched = sources.filter((source) => {
      const identity = sourceIdentity(source)
      // 有稳定 ID 时不退回用户名匹配，避免改名后误绑另一个账号。
      return account.userId
        ? identity.userId === account.userId
        : username !== null && identity.usernames.has(username)
    })
    const identity = account.userId ? `id:${account.userId}` : `username:${username}`
    const conflict =
      matched.length > 1 ||
      (duplicates.get(identity) ?? 0) > 1 ||
      (!account.userId && matched.some((source) => sourceIdentity(source).usernames.size > 1))
    const source = !conflict ? matched[0] : undefined
    const state = source ? store.sourceSync.state(source.key) : null
    const inputs = source
      ? store.automation.inputs().filter((input) => input.sourceKey === source.key)
      : []
    const current = source ? (bindings.get(source.key) ?? []) : []
    const tagNames = [...new Set(account.tags)].sort()
    const status =
      account.active === false
        ? "not_in_plan"
        : conflict
          ? "identity_conflict"
          : !source
            ? "source_missing"
            : state?.failure
              ? "fetch_error"
              : !planned.has(source.key)
                ? "not_in_plan"
                : inputs.some(
                      (input) =>
                        missingMaterialContext(input.body).length ||
                        ["missing", "failed"].includes(store.processingState.material(input) ?? ""),
                    )
                  ? "needs_context"
                  : !state?.lastSuccessAt ||
                      state.pending ||
                      state.coverage === "timestamp_boundary"
                    ? "awaiting_fetch"
                    : "ready"
    return {
      accountId: account.id,
      username,
      sourceKeys: matched.map((item) => item.key),
      status,
      tagNames,
      add: tagNames.filter((name) => !current.includes(name)),
      remove: source
        ? store.subscriptionTags
            .managedTagNames(manager, source.key)
            .filter((name) => !tagNames.includes(name))
        : [],
      lastSuccessAt: state?.lastSuccessAt ?? null,
      failure: state?.failure ?? null,
      coverage: state?.coverage ?? null,
    }
  })
  return { revision: snapshot.revision, inventory: store.sourceSync.inventoryStatus(), rows }
}

// 仅同步无冲突的已匹配来源，不发起订阅、Notion 回写或逐条内容查询。
export function applyNotionSourceImport(
  store: Store,
  accounts: NotionSourceAccount[],
  expectedRevision: number,
  manager = "notion:x-accounts",
) {
  const preview = previewNotionSourceImport(store, accounts, manager)
  const matched = preview.rows.filter(
    (row) =>
      row.sourceKeys.length === 1 &&
      row.status !== "identity_conflict" &&
      accounts.find((account) => account.id === row.accountId)?.active !== false,
  )
  const result = store.subscriptionTags.replaceManagedBindings(
    manager,
    matched.map((row) => ({ sourceKey: row.sourceKeys[0]!, names: row.tagNames })),
    expectedRevision,
  )
  return { ...result, rows: previewNotionSourceImport(store, accounts, manager).rows }
}

// 分页读取账号清单而非逐条内容查询；页数与超时有明确上限，失败不导入半份清单。
export async function readNotionSourceAccounts(
  token: string,
  dataSourceId: string,
  fetcher = fetch,
): Promise<NotionSourceAccount[]> {
  if (!/^[a-f\d-]{32,36}$/iu.test(dataSourceId)) throw new Error("invalid_notion_data_source")
  const accounts: NotionSourceAccount[] = []
  let cursor: string | undefined
  for (let page = 0; page < 100; page++) {
    const response = await fetcher(`https://api.notion.com/v1/data_sources/${dataSourceId}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": "2026-03-11",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`notion_read_${response.status}`)
    const result = z
      .object({
        results: z.array(z.unknown()),
        has_more: z.boolean(),
        next_cursor: z.string().nullable(),
      })
      .parse(await response.json())
    accounts.push(...result.results.map(notionPageAccount))
    if (!result.has_more) return accounts
    if (!result.next_cursor || result.next_cursor === cursor)
      throw new Error("notion_cursor_invalid")
    cursor = result.next_cursor
  }
  throw new Error("notion_page_budget_exceeded")
}

// 数据库含多个 data source 时要求指定来源，避免把无关数据库分表一起导入。
export async function readNotionDatabaseSourceAccounts(
  token: string,
  databaseId: string,
  fetcher = fetch,
) {
  if (!/^[a-f\d-]{32,36}$/iu.test(databaseId)) throw new Error("invalid_notion_database")
  const response = await fetcher(`https://api.notion.com/v1/databases/${databaseId}`, {
    headers: { Authorization: `Bearer ${token}`, "Notion-Version": "2026-03-11" },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`notion_read_${response.status}`)
  const result = z
    .object({ data_sources: z.array(z.object({ id: z.string() })) })
    .parse(await response.json())
  if (result.data_sources.length !== 1) throw new Error("notion_data_source_ambiguous")
  return readNotionSourceAccounts(token, result.data_sources[0]!.id, fetcher)
}
