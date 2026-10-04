import { randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"

export const subscriptionTagFormatVersion = 1

export type SubscriptionTag = {
  id: string
  name: string
  createdAt: string
  updatedAt: string
}

export type SubscriptionTagSnapshot = {
  formatVersion: typeof subscriptionTagFormatVersion
  revision: number
  tags: SubscriptionTag[]
}

export type SourceTagBinding = {
  sourceKey: string
  tagIds: string[]
}

export type SubscriptionTagErrorCode =
  | "owner_required"
  | "revision_conflict"
  | "invalid_tag"
  | "invalid_tag_set"
  | "invalid_source_keys"
  | "duplicate_tag_name"
  | "tag_referenced"

export class SubscriptionTagError extends Error {
  constructor(
    public readonly code: SubscriptionTagErrorCode,
    public readonly ruleIds: string[] = [],
  ) {
    super(code)
    this.name = "SubscriptionTagError"
  }
}

type BindingUpdate = {
  expectedRevision: number
  sourceKeys: readonly string[]
  tagIds: readonly string[]
  operation: "add" | "remove"
}

type DraftRule = { id?: unknown; when?: unknown; actions?: unknown }

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function validRevision(value: number): boolean {
  return Number.isInteger(value) && value >= 0
}

function tagName(value: string): string {
  const name = value.trim()
  if (!name || name.length > 100) throw new SubscriptionTagError("invalid_tag")
  return name
}

function sourceKeys(values: readonly string[]): string[] {
  const keys = uniqueStrings(values)
  if (!keys.length || keys.some((key) => !isSourceKey(key)))
    throw new SubscriptionTagError("invalid_source_keys")
  return keys
}

function isSourceKey(value: string): boolean {
  // List 只是来源集合；标签只能绑定实际 feed 或 inbox，避免容器标签隐式传播给成员。
  return /^(?:feed|inbox)\/[^/\s]+$/u.test(value) && value.length <= 300
}

function tagIds(values: readonly string[]): string[] {
  const ids = uniqueStrings(values)
  if (!ids.length || ids.some((id) => !id.trim() || id.length > 200))
    throw new SubscriptionTagError("invalid_tag_set")
  return ids
}

function ruleReferencesTag(conditionSet: unknown, tagId: string): boolean {
  if (!conditionSet || typeof conditionSet !== "object") return false
  const conditions = Reflect.get(conditionSet, "anyOf")
  if (!Array.isArray(conditions)) return false
  return conditions.some((group) => {
    const allOf = group && typeof group === "object" ? Reflect.get(group, "allOf") : null
    return (
      Array.isArray(allOf) &&
      allOf.some(
        (condition) =>
          condition &&
          typeof condition === "object" &&
          Reflect.get(condition, "field") === "subscription_tag" &&
          Array.isArray(Reflect.get(condition, "value")) &&
          Reflect.get(condition, "value").includes(tagId),
      )
    )
  })
}

function actionsReferenceTag(actions: unknown, tagId: string): boolean {
  if (!Array.isArray(actions)) return false
  return actions.some(
    (action) =>
      action &&
      typeof action === "object" &&
      Reflect.get(action, "type") === "ai_aggregate" &&
      ruleReferencesTag(Reflect.get(action, "scope"), tagId),
  )
}

// 私人来源标签独立于公开订阅和 List；调用方传入的 owner 只能来自已核验会话。
export class SubscriptionTagStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly owner: () => string | null,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS subscription_tag_metadata (
        id INTEGER PRIMARY KEY CHECK(id=1),
        format_version INTEGER NOT NULL,
        revision INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS subscription_tags (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(owner_id, name)
      );
      CREATE TABLE IF NOT EXISTS source_tag_bindings (
        owner_id TEXT NOT NULL,
        source_key TEXT NOT NULL,
        tag_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(owner_id, source_key, tag_id)
      );
      CREATE TABLE IF NOT EXISTS managed_source_tag_bindings (
        owner_id TEXT NOT NULL, manager TEXT NOT NULL, source_key TEXT NOT NULL, tag_id TEXT NOT NULL,
        PRIMARY KEY(owner_id, manager, source_key, tag_id)
      );
      CREATE INDEX IF NOT EXISTS source_tag_bindings_owner_source
        ON source_tag_bindings(owner_id, source_key);
      CREATE INDEX IF NOT EXISTS source_tag_bindings_owner_tag
        ON source_tag_bindings(owner_id, tag_id);
      INSERT OR IGNORE INTO subscription_tag_metadata VALUES(1, ${subscriptionTagFormatVersion}, 0);
    `)
  }

  private transaction<T>(operation: () => T): T {
    // SAVEPOINT 可嵌入 Store 的页面事务，保证标签版本和绑定关系同时提交。
    this.db.exec("SAVEPOINT subscription_tag_write")
    try {
      const value = operation()
      this.db.exec("RELEASE subscription_tag_write")
      return value
    } catch (error) {
      this.db.exec("ROLLBACK TO subscription_tag_write; RELEASE subscription_tag_write")
      throw error
    }
  }

  private ownerId(): string {
    const ownerId = this.owner()
    if (!ownerId) throw new SubscriptionTagError("owner_required")
    return ownerId
  }

  private metadata(): { formatVersion: typeof subscriptionTagFormatVersion; revision: number } {
    const row = this.db
      .prepare("SELECT format_version,revision FROM subscription_tag_metadata WHERE id=1")
      .get()
    if (!row || Number(row.format_version) !== subscriptionTagFormatVersion)
      throw new SubscriptionTagError("invalid_tag")
    return { formatVersion: subscriptionTagFormatVersion, revision: Number(row.revision) }
  }

  private expectRevision(expectedRevision: number): number {
    if (!validRevision(expectedRevision)) throw new SubscriptionTagError("revision_conflict")
    const { revision } = this.metadata()
    if (revision !== expectedRevision) throw new SubscriptionTagError("revision_conflict")
    return revision
  }

  private bumpRevision(revision: number): number {
    const next = revision + 1
    this.db.prepare("UPDATE subscription_tag_metadata SET revision=? WHERE id=1").run(next)
    return next
  }

  private tagFromRow(row: Record<string, unknown>): SubscriptionTag {
    return {
      id: String(row.id),
      name: String(row.name),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
  }

  snapshot(): SubscriptionTagSnapshot {
    const ownerId = this.ownerId()
    const metadata = this.metadata()
    return {
      ...metadata,
      tags: this.db
        .prepare(
          "SELECT id,name,created_at,updated_at FROM subscription_tags WHERE owner_id=? ORDER BY name,id",
        )
        .all(ownerId)
        .map((row) => this.tagFromRow(row)),
    }
  }

  create(name: string, expectedRevision: number): SubscriptionTagSnapshot {
    const normalizedName = tagName(name)
    return this.transaction(() => {
      const ownerId = this.ownerId()
      const revision = this.expectRevision(expectedRevision)
      const now = new Date().toISOString()
      try {
        this.db
          .prepare("INSERT INTO subscription_tags VALUES(?,?,?,?,?)")
          .run(randomUUID(), ownerId, normalizedName, now, now)
      } catch {
        throw new SubscriptionTagError("duplicate_tag_name")
      }
      this.bumpRevision(revision)
      return this.snapshot()
    })
  }

  rename(id: string, name: string, expectedRevision: number): SubscriptionTagSnapshot {
    const normalizedName = tagName(name)
    return this.transaction(() => {
      const ownerId = this.ownerId()
      const revision = this.expectRevision(expectedRevision)
      const existing = this.db
        .prepare("SELECT name FROM subscription_tags WHERE id=? AND owner_id=?")
        .get(id, ownerId)
      if (!existing) throw new SubscriptionTagError("invalid_tag")
      if (String(existing.name) === normalizedName) return this.snapshot()
      try {
        this.db
          .prepare("UPDATE subscription_tags SET name=?,updated_at=? WHERE id=? AND owner_id=?")
          .run(normalizedName, new Date().toISOString(), id, ownerId)
      } catch {
        throw new SubscriptionTagError("duplicate_tag_name")
      }
      this.bumpRevision(revision)
      return this.snapshot()
    })
  }

  delete(id: string, expectedRevision: number): SubscriptionTagSnapshot {
    return this.transaction(() => {
      const ownerId = this.ownerId()
      const revision = this.expectRevision(expectedRevision)
      const existing = this.db
        .prepare("SELECT id FROM subscription_tags WHERE id=? AND owner_id=?")
        .get(id, ownerId)
      if (!existing) throw new SubscriptionTagError("invalid_tag")
      const ruleIds = this.ruleReferences(id)
      // 条件删除后不能静默退化为 ALL；API 接线层应展示 ruleIds 并要求用户先修复规则。
      if (ruleIds.length) throw new SubscriptionTagError("tag_referenced", ruleIds)
      this.db
        .prepare("DELETE FROM source_tag_bindings WHERE owner_id=? AND tag_id=?")
        .run(ownerId, id)
      this.db.prepare("DELETE FROM subscription_tags WHERE id=? AND owner_id=?").run(id, ownerId)
      this.bumpRevision(revision)
      return this.snapshot()
    })
  }

  updateBindings(input: BindingUpdate): {
    revision: number
    changedBindings: number
    sourceKeys: string[]
  } {
    const keys = sourceKeys(input.sourceKeys)
    const ids = tagIds(input.tagIds)
    return this.transaction(() => {
      const ownerId = this.ownerId()
      const revision = this.expectRevision(input.expectedRevision)
      const available = this.db
        .prepare(
          `SELECT id FROM subscription_tags WHERE owner_id=? AND id IN (${ids.map(() => "?").join(",")})`,
        )
        .all(ownerId, ...ids)
        .map((row) => String(row.id))
      if (available.length !== ids.length) throw new SubscriptionTagError("invalid_tag_set")

      let changedBindings = 0
      let changedOwnership = 0
      if (input.operation === "add") {
        const insert = this.db.prepare("INSERT OR IGNORE INTO source_tag_bindings VALUES(?,?,?,?)")
        const now = new Date().toISOString()
        for (const sourceKey of keys)
          for (const id of ids) {
            changedBindings += Number(insert.run(ownerId, sourceKey, id, now).changes)
            // 手工再次添加受管理标签意味着用户要保留它，后续导入不能删除。
            changedOwnership += Number(
              this.db
                .prepare(
                  "DELETE FROM managed_source_tag_bindings WHERE owner_id=? AND source_key=? AND tag_id=?",
                )
                .run(ownerId, sourceKey, id).changes,
            )
          }
      } else {
        const remove = this.db.prepare(
          "DELETE FROM source_tag_bindings WHERE owner_id=? AND source_key=? AND tag_id=?",
        )
        for (const sourceKey of keys)
          for (const id of ids)
            changedBindings += Number(remove.run(ownerId, sourceKey, id).changes)
      }
      return {
        revision: changedBindings || changedOwnership ? this.bumpRevision(revision) : revision,
        changedBindings,
        sourceKeys: keys,
      }
    })
  }

  managedTagNames(manager: string, sourceKey: string): string[] {
    // 差异预览只显示此管理器拥有的标签，不能把手工标签列成待删除。
    return this.db
      .prepare(
        "SELECT t.name FROM managed_source_tag_bindings b JOIN subscription_tags t ON t.id=b.tag_id AND t.owner_id=b.owner_id WHERE b.owner_id=? AND b.manager=? AND b.source_key=? ORDER BY t.name",
      )
      .all(this.ownerId(), manager, sourceKey)
      .map((row) => String(row.name))
  }

  // 每个来源只替换此管理器此前写入的标签；历史与手工绑定保持原样。
  replaceManagedBindings(
    manager: string,
    bindings: Array<{ sourceKey: string; names: string[] }>,
    expectedRevision: number,
  ) {
    if (!manager.trim() || manager.length > 200) throw new SubscriptionTagError("invalid_tag")
    if (new Set(bindings.map((binding) => binding.sourceKey)).size !== bindings.length)
      throw new SubscriptionTagError("invalid_source_keys")
    for (const binding of bindings) {
      sourceKeys([binding.sourceKey])
      binding.names.forEach(tagName)
    }
    return this.transaction(() => {
      const ownerId = this.ownerId()
      const revision = this.expectRevision(expectedRevision)
      const now = new Date().toISOString()
      let changedBindings = 0
      let createdTags = 0
      for (const binding of bindings) {
        const ids = [...new Set(binding.names.map(tagName))].map((name) => {
          const existing = this.db
            .prepare("SELECT id FROM subscription_tags WHERE owner_id=? AND name=?")
            .get(ownerId, name)
          if (existing) return String(existing.id)
          const id = randomUUID()
          this.db
            .prepare("INSERT INTO subscription_tags VALUES(?,?,?,?,?)")
            .run(id, ownerId, name, now, now)
          createdTags++
          return id
        })
        const previous = this.db
          .prepare(
            "SELECT tag_id FROM managed_source_tag_bindings WHERE owner_id=? AND manager=? AND source_key=?",
          )
          .all(ownerId, manager, binding.sourceKey)
        for (const row of previous) {
          const id = String(row.tag_id)
          if (ids.includes(id)) continue
          this.db
            .prepare(
              "DELETE FROM managed_source_tag_bindings WHERE owner_id=? AND manager=? AND source_key=? AND tag_id=?",
            )
            .run(ownerId, manager, binding.sourceKey, id)
          // 其他管理器仍持有的标签不能一起删掉。
          if (
            !this.db
              .prepare(
                "SELECT 1 FROM managed_source_tag_bindings WHERE owner_id=? AND source_key=? AND tag_id=?",
              )
              .get(ownerId, binding.sourceKey, id)
          )
            changedBindings += Number(
              this.db
                .prepare(
                  "DELETE FROM source_tag_bindings WHERE owner_id=? AND source_key=? AND tag_id=?",
                )
                .run(ownerId, binding.sourceKey, id).changes,
            )
        }
        for (const id of ids) {
          const result = this.db
            .prepare("INSERT OR IGNORE INTO source_tag_bindings VALUES(?,?,?,?)")
            .run(ownerId, binding.sourceKey, id, now)
          changedBindings += Number(result.changes)
          // 已存在的非受管理标签属于手工数据，不夺取它的所有权。
          if (result.changes || previous.some((row) => row.tag_id === id))
            this.db
              .prepare("INSERT OR IGNORE INTO managed_source_tag_bindings VALUES(?,?,?,?)")
              .run(ownerId, manager, binding.sourceKey, id)
        }
      }
      return {
        revision: changedBindings || createdTags ? this.bumpRevision(revision) : revision,
        changedBindings,
        createdTags,
      }
    })
  }

  sourceTagBindings(sourceKeys?: readonly string[]): {
    revision: number
    bindings: SourceTagBinding[]
  } {
    const ownerId = this.ownerId()
    const metadata = this.metadata()
    const keys =
      sourceKeys === undefined ? null : sourceKeys.length ? uniqueStrings(sourceKeys) : []
    if (keys?.some((key) => !isSourceKey(key)))
      throw new SubscriptionTagError("invalid_source_keys")
    if (keys?.length === 0) return { revision: metadata.revision, bindings: [] }
    const rows = keys
      ? this.db
          .prepare(
            `SELECT source_key,tag_id FROM source_tag_bindings WHERE owner_id=? AND source_key IN (${keys.map(() => "?").join(",")}) ORDER BY source_key,tag_id`,
          )
          .all(ownerId, ...keys)
      : this.db
          .prepare(
            "SELECT source_key,tag_id FROM source_tag_bindings WHERE owner_id=? ORDER BY source_key,tag_id",
          )
          .all(ownerId)
    // 指定来源已完成标签读取时，空数组表示确定无标签，不能与未读取混为一谈。
    const grouped = new Map<string, string[]>(keys?.map((key) => [key, []]) ?? [])
    for (const row of rows) {
      const sourceKey = String(row.source_key)
      grouped.set(sourceKey, [...(grouped.get(sourceKey) ?? []), String(row.tag_id)])
    }
    return {
      revision: metadata.revision,
      bindings: [...grouped].map(([sourceKey, ids]) => ({ sourceKey, tagIds: ids })),
    }
  }

  private ruleReferences(tagId: string): string[] {
    const tables = new Set(
      this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('automation_draft','rule_set_releases')",
        )
        .all()
        .map((row) => String(row.name)),
    )
    let rules: DraftRule[] = []
    if (tables.has("automation_draft")) {
      const row = this.db.prepare("SELECT body FROM automation_draft WHERE id=1").get()
      if (row) rules = [...rules, ...this.rulesFromBody(row.body)]
    }
    if (tables.has("rule_set_releases")) {
      // 仅最新发布版本仍决定新任务；更早版本只服务于历史结果，不能永久阻止标签维护。
      const row = this.db
        .prepare("SELECT body FROM rule_set_releases ORDER BY version DESC LIMIT 1")
        .get()
      if (row) rules = [...rules, ...this.rulesFromBody(row.body)]
    }
    return uniqueStrings(
      rules
        .filter(
          (rule) =>
            typeof rule.id === "string" &&
            (ruleReferencesTag(rule.when, tagId) || actionsReferenceTag(rule.actions, tagId)),
        )
        .map((rule) => String(rule.id)),
    ).sort()
  }

  private rulesFromBody(body: unknown): DraftRule[] {
    try {
      const parsed: unknown = JSON.parse(String(body))
      if (parsed && typeof parsed === "object" && Array.isArray(Reflect.get(parsed, "rules")))
        return Reflect.get(parsed, "rules") as DraftRule[]
      throw new Error("invalid_rule_set")
    } catch {
      // 配置损坏时不能误判为可安全删除；保存层会在下一次写入时拒绝该草稿。
      throw new SubscriptionTagError("tag_referenced")
    }
  }
}
