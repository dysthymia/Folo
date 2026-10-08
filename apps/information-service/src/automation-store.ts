import { createHash } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"

import type { AttentionSettings, AutomationRule, RuleSet } from "@follow/information-core"
import { ruleRequiresSemantics, ruleSetSchema } from "@follow/information-core"
import { z } from "zod"

import type { SourceEntry } from "./folo"

// 注意力发布只改变阅读提示；规则的内容指令、范围及策略仍须完全一致。
function attentionOnlyRuleChange(previous: RuleSet | null, next: RuleSet) {
  if (!previous) return false
  const objective = (config: RuleSet) => ({
    ...config,
    global: { markdown: config.global.markdown },
    rules: config.rules.flatMap((rule) => {
      const actions = rule.actions.filter((action) => action.type !== "attention")
      return actions.length ? [{ ...rule, version: 0, actions }] : []
    }),
  })
  const attention = (config: RuleSet) => ({
    global: config.global.attention ?? null,
    rules: config.rules.flatMap((rule) => {
      const actions = rule.actions.filter((action) => action.type === "attention")
      return actions.length ? [{ ...rule, version: 0, actions }] : []
    }),
  })
  return (
    JSON.stringify(objective(previous)) === JSON.stringify(objective(next)) &&
    JSON.stringify(attention(previous)) !== JSON.stringify(attention(next))
  )
}

export class AutomationError extends Error {
  constructor(
    public readonly code:
      | "revision_conflict"
      | "legacy_scope_migration_required"
      | "legacy_scope_upgrade_blocked"
      | "owner_required"
      | "invalid_rule_set"
      | "invalid_target"
      | "invalid_reconciliation",
  ) {
    super(code)
  }
}
export const publicationScopeSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("future") }).strict(),
  z.object({ mode: z.literal("recent"), since: z.iso.datetime({ offset: true }) }).strict(),
  z
    .object({
      mode: z.literal("selected"),
      inputIds: z.array(z.number().int().positive()).min(1).max(10000),
    })
    .strict(),
])
export type PublicationScope = z.infer<typeof publicationScopeSchema>
export type PublicationImpact = {
  newAssignments: number
  recalculated: number
  queuedUnchanged: number
  historicalUnchanged: number
}
export type PublicationPreview = {
  scope: PublicationScope
  targetInputIds: number[]
  impact: PublicationImpact
}
export type ProcessingInput = {
  seq: number
  sourceKey: string
  itemId: string
  contentVersion: string
  receivedAt: string
  releaseVersion: number | null
  generation: number
  status: string
  current: boolean
  body: SourceEntry
}

export type UnchangedInputReconciliation = {
  currentSeq: number
  historicalSeq: number
  sourceKey: string
  itemId: string
  contentVersion: string
  expectedHistoricalStatus: "succeeded" | "failed" | "pending"
  expectedCurrentStatus: "succeeded" | "failed" | "pending"
  expectedReleaseVersion: number
  expectedGeneration: number
  expectedDecisionId: string | null
  expectedCurrentDecisionId: string | null
  expectedSnapshotError: string | null
  expectedCurrentReceivedAt: string
}

export type UnchangedInputReconciliationGuard = {
  expectedCount: number
  minimumCurrentSeq: number
  minimumCurrentReceivedAt: string
  maximumHistoricalSeq: number
}

// 单条和批量激活都显式升级语义契约；旧规则与已有 v5 配置不降级。
export function promoteSemanticRuleSet(config: RuleSet): RuleSet {
  return config.formatVersion === 5 ||
    config.rules.some(
      (rule) =>
        ruleRequiresSemantics(rule) ||
        rule.actions.some((action) => action.type === "reading_decision"),
    )
    ? { ...config, formatVersion: 5 }
    : config
}

// 草稿、不可变发布和输入目标共用业务数据库，发布边界使用摄取序号而非文章来源日期。
export class AutomationStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly owner: () => string | null,
    private readonly validatePublication?: (config: RuleSet) => boolean,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS automation_draft (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rule_set_releases (version INTEGER PRIMARY KEY AUTOINCREMENT, draft_revision INTEGER NOT NULL, activation_seq INTEGER NOT NULL, body TEXT NOT NULL, scope TEXT NOT NULL, targets TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS processing_inputs (seq INTEGER PRIMARY KEY AUTOINCREMENT, source_key TEXT NOT NULL, item_id TEXT NOT NULL, content_version TEXT NOT NULL, body TEXT NOT NULL, received_at TEXT NOT NULL, release_version INTEGER, generation INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', current INTEGER NOT NULL DEFAULT 1, decision_id TEXT);
      CREATE INDEX IF NOT EXISTS processing_input_identity ON processing_inputs(source_key,item_id,current);
      CREATE TABLE IF NOT EXISTS entry_decisions (id TEXT PRIMARY KEY, input_seq INTEGER NOT NULL, generation INTEGER NOT NULL, release_version INTEGER NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rule_activation_requests (id TEXT PRIMARY KEY, request TEXT NOT NULL, response TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS publication_requests (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, scope TEXT NOT NULL, release_version INTEGER NOT NULL);
    `)
  }

  private transaction<T>(operation: () => T): T {
    // SAVEPOINT 可嵌入扫描页面事务，避免条目与版本状态发生半提交。
    this.db.exec("SAVEPOINT automation_write")
    try {
      const value = operation()
      this.db.exec("RELEASE automation_write")
      return value
    } catch (error) {
      this.db.exec("ROLLBACK TO automation_write; RELEASE automation_write")
      throw error
    }
  }

  draft(): { revision: number; config: RuleSet } {
    const ownerId = this.owner()
    if (!ownerId) throw new AutomationError("owner_required")
    const row = this.db.prepare("SELECT revision,body FROM automation_draft WHERE id=1").get()
    if (row)
      return {
        revision: Number(row.revision),
        config: ruleSetSchema.parse(JSON.parse(String(row.body))),
      }
    return {
      revision: 0,
      config: { formatVersion: 4, ownerId, global: { version: 1, markdown: "" }, rules: [] },
    }
  }

  saveDraft(input: unknown, expectedRevision: number) {
    const parsed = ruleSetSchema.safeParse(input)
    if (!parsed.success || parsed.data.ownerId !== this.owner())
      throw new AutomationError("invalid_rule_set")
    return this.transaction(() => {
      const previous = this.draft()
      if (previous.revision !== expectedRevision) throw new AutomationError("revision_conflict")
      const config = parsed.data
      config.global.version =
        previous.config.global.version +
        Number(config.global.markdown !== previous.config.global.markdown)
      config.rules = config.rules.map((rule) => {
        const old = previous.config.rules.find((candidate) => candidate.id === rule.id)
        const changed =
          old && JSON.stringify({ ...old, version: 0 }) !== JSON.stringify({ ...rule, version: 0 })
        return { ...rule, version: old ? old.version + Number(changed) : 1 }
      })
      const revision = previous.revision + 1
      this.db
        .prepare("INSERT OR REPLACE INTO automation_draft VALUES(1,?,?)")
        .run(revision, JSON.stringify(config))
      return { revision, config }
    })
  }

  effective(): { releaseVersion: number | null; config: RuleSet | null } {
    const row = this.db
      .prepare("SELECT version,body FROM rule_set_releases ORDER BY version DESC LIMIT 1")
      .get()
    return row
      ? {
          releaseVersion: Number(row.version),
          config: ruleSetSchema.parse(JSON.parse(String(row.body))),
        }
      : { releaseVersion: null, config: null }
  }

  activateRule(
    ruleId: string,
    rule: AutomationRule | null,
    expectedRevision: number,
    requestId: string,
    afterActivate?: () => void,
  ) {
    if (rule && (rule.id !== ruleId || rule.ownerId !== this.owner()))
      throw new AutomationError("invalid_rule_set")
    return this.activateChange(
      { type: "rule", ruleId, rule },
      expectedRevision,
      requestId,
      afterActivate,
    )
  }

  activateGlobal(
    markdown: string,
    expectedRevision: number,
    requestId: string,
    afterActivate?: () => void,
    attention?: AttentionSettings,
  ) {
    return this.activateChange(
      { type: "global", markdown, ...(attention === undefined ? {} : { attention }) },
      expectedRevision,
      requestId,
      afterActivate,
    )
  }

  activateRules(
    rules: AutomationRule[],
    expectedRevision: number,
    requestId: string,
    afterActivate?: () => void,
  ) {
    if (
      !rules.length ||
      new Set(rules.map((rule) => rule.id)).size !== rules.length ||
      rules.some((rule) => rule.ownerId !== this.owner())
    )
      throw new AutomationError("invalid_rule_set")
    return this.activateChange({ type: "rules", rules }, expectedRevision, requestId, afterActivate)
  }

  reorderRules(
    ruleIds: string[],
    expectedRevision: number,
    requestId: string,
    afterActivate?: () => void,
  ) {
    return this.activateChange(
      { type: "reorder", ruleIds },
      expectedRevision,
      requestId,
      afterActivate,
    )
  }

  upgradeRules(
    expectedRevision: number,
    expectedScheduleRevision: number,
    requestId: string,
    prepare: () => { config: RuleSet; effectiveConfig: RuleSet },
    afterUpgrade: () => void,
  ) {
    if (!z.uuid().safeParse(requestId).success) throw new AutomationError("invalid_target")
    type Result = {
      revision: number
      config: RuleSet
      effectiveConfig: RuleSet
      release: ReturnType<AutomationStore["releases"]>[number]
    }
    return this.transaction((): Result => {
      const request = JSON.stringify({
        type: "legacy_scope_upgrade",
        expectedRevision,
        expectedScheduleRevision,
      })
      const replay = this.db
        .prepare("SELECT request,response FROM rule_activation_requests WHERE id=?")
        .get(requestId)
      if (replay) {
        if (replay.request !== request) throw new AutomationError("revision_conflict")
        return JSON.parse(String(replay.response)) as Result
      }
      if (this.draft().revision !== expectedRevision) throw new AutomationError("revision_conflict")
      const prepared = prepare()
      const saved = this.saveDraft(prepared.config, expectedRevision)
      const effectiveConfig = ruleSetSchema.parse({
        ...prepared.effectiveConfig,
        rules: prepared.effectiveConfig.rules.map((rule) => {
          const previous = this.effective().config?.rules.find((item) => item.id === rule.id)
          const changed = JSON.stringify(previous) !== JSON.stringify(rule)
          // 无关的未发布草稿版本不能冒充历史有效规则的新版本。
          return {
            ...rule,
            version: changed
              ? (saved.config.rules.find((item) => item.id === rule.id)?.version ?? rule.version)
              : rule.version,
          }
        }),
      })
      if (this.validatePublication && !this.validatePublication(effectiveConfig))
        throw new AutomationError("invalid_rule_set")
      const activationSeq = Number(
        this.db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM processing_inputs").get()!.seq,
      )
      const createdAt = new Date().toISOString()
      const scope = { mode: "future" as const }
      // 升级只把既有范围写入规则，不重算历史输入，也不改写已有 Story 版本。
      const inserted = this.db
        .prepare(
          "INSERT INTO rule_set_releases(draft_revision,activation_seq,body,scope,targets,created_at) VALUES(?,?,?,?,?,?)",
        )
        .run(
          saved.revision,
          activationSeq,
          JSON.stringify(effectiveConfig),
          JSON.stringify(scope),
          "[]",
          createdAt,
        )
      const release = {
        version: Number(inserted.lastInsertRowid),
        draftRevision: saved.revision,
        activationSeq,
        createdAt,
        scope,
        targetInputIds: [],
      }
      afterUpgrade()
      const result = { ...saved, effectiveConfig, release }
      this.db
        .prepare("INSERT INTO rule_activation_requests VALUES(?,?,?)")
        .run(requestId, request, JSON.stringify(result))
      return result
    })
  }

  private activateChange(
    change:
      | { type: "rule"; ruleId: string; rule: AutomationRule | null }
      | { type: "global"; markdown: string; attention?: AttentionSettings }
      | { type: "rules"; rules: AutomationRule[] }
      | { type: "reorder"; ruleIds: string[] },
    expectedRevision: number,
    requestId: string,
    afterActivate?: () => void,
  ) {
    if (!z.uuid().safeParse(requestId).success) throw new AutomationError("invalid_target")
    type Result = {
      revision: number
      config: RuleSet
      effectiveConfig: RuleSet
      release: ReturnType<AutomationStore["releases"]>[number]
    }
    return this.transaction((): Result => {
      const request = JSON.stringify({ change, expectedRevision })
      const replay = this.db
        .prepare("SELECT request,response FROM rule_activation_requests WHERE id=?")
        .get(requestId)
      if (replay) {
        if (replay.request !== request) throw new AutomationError("revision_conflict")
        return JSON.parse(String(replay.response)) as Result
      }
      const previous = this.draft()
      if (previous.revision !== expectedRevision) throw new AutomationError("revision_conflict")
      const active = this.effective().config ?? {
        formatVersion: 4 as const,
        ownerId: previous.config.ownerId,
        global: { version: 1, markdown: "" },
        rules: [],
      }
      let draftConfig = previous.config
      let effectiveConfig = active
      if (change.type === "global") {
        // 旧客户端仅提交正文时保留关注配置；显式提交才同步更新草稿与生效配置。
        const attention = change.attention === undefined ? {} : { attention: change.attention }
        draftConfig = {
          ...draftConfig,
          global: { ...draftConfig.global, markdown: change.markdown, ...attention },
        }
        effectiveConfig = {
          ...active,
          global: {
            ...active.global,
            markdown: change.markdown,
            ...attention,
            version: active.global.version + Number(active.global.markdown !== change.markdown),
          },
        }
      } else if (change.type === "reorder") {
        if (
          new Set(change.ruleIds).size !== change.ruleIds.length ||
          change.ruleIds.length !== active.rules.length ||
          change.ruleIds.some((id) => !active.rules.some((rule) => rule.id === id))
        )
          throw new AutomationError("invalid_rule_set")
        // 顺序发布只读取旧的有效规则内容，草稿中的其它编辑保持未发布。
        effectiveConfig = {
          ...active,
          rules: change.ruleIds.map((id, order) => ({
            ...active.rules.find((rule) => rule.id === id)!,
            order,
          })),
        }
        const draftOnly = draftConfig.rules.filter((rule) => !change.ruleIds.includes(rule.id))
        draftConfig = {
          ...draftConfig,
          rules: [
            ...change.ruleIds.flatMap((id, order) => {
              const rule = draftConfig.rules.find((rule) => rule.id === id)
              return rule ? [{ ...rule, order }] : []
            }),
            ...draftOnly.map((rule, index) => ({ ...rule, order: change.ruleIds.length + index })),
          ],
        }
      } else if (change.type === "rules") {
        const selected = new Map(change.rules.map((rule) => [rule.id, rule]))
        const replace = (config: RuleSet) => {
          let order = Math.max(-1, ...config.rules.map((rule) => rule.order)) + 1
          return {
            ...config,
            rules: [
              ...config.rules.map((old) =>
                selected.has(old.id) ? { ...selected.get(old.id)!, order: old.order } : old,
              ),
              ...change.rules
                .filter((rule) => !config.rules.some((old) => old.id === rule.id))
                .map((rule) => ({ ...rule, order: order++ })),
            ],
          }
        }
        draftConfig = replace(draftConfig)
        effectiveConfig = replace(active)
      } else {
        const existing = previous.config.rules.find((rule) => rule.id === change.ruleId)
        const published = active.rules.find((rule) => rule.id === change.ruleId)
        if (!change.rule && !existing && !published) throw new AutomationError("invalid_target")
        // 位置沿用各自列表；新增规则追加。避免单条保存偷偷重排其他未发布草稿。
        const replace = (config: RuleSet) => {
          const old = config.rules.find((rule) => rule.id === change.ruleId)
          const next = change.rule
            ? {
                ...change.rule,
                order: old?.order ?? Math.max(-1, ...config.rules.map((rule) => rule.order)) + 1,
              }
            : null
          return {
            ...config,
            rules: old
              ? config.rules.flatMap((rule) =>
                  rule.id === change.ruleId ? (next ? [next] : []) : [rule],
                )
              : next
                ? [...config.rules, next]
                : config.rules,
          }
        }
        draftConfig = replace(draftConfig)
        effectiveConfig = replace(active)
      }
      draftConfig = promoteSemanticRuleSet(draftConfig)
      effectiveConfig = promoteSemanticRuleSet(effectiveConfig)
      const saved = this.saveDraft(draftConfig, expectedRevision)
      if (change.type === "rule" && change.rule) {
        const savedRule = saved.config.rules.find((rule) => rule.id === change.ruleId)!
        effectiveConfig = {
          ...effectiveConfig,
          rules: effectiveConfig.rules.map((rule) =>
            rule.id === change.ruleId ? { ...savedRule, order: rule.order } : rule,
          ),
        }
      }
      if (change.type === "rules") {
        const selected = new Set(change.rules.map((rule) => rule.id))
        effectiveConfig = {
          ...effectiveConfig,
          rules: effectiveConfig.rules.map((rule) =>
            selected.has(rule.id)
              ? {
                  ...saved.config.rules.find((savedRule) => savedRule.id === rule.id)!,
                  order: rule.order,
                }
              : rule,
          ),
        }
      }
      effectiveConfig = ruleSetSchema.parse(effectiveConfig)
      if (this.validatePublication && !this.validatePublication(effectiveConfig))
        throw new AutomationError("invalid_rule_set")
      const activationSeq = Number(
        this.db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM processing_inputs").get()!.seq,
      )
      const scope = { mode: "future" as const }
      const createdAt = new Date().toISOString()
      // 普通激活（含纯关注配置）只保存未来版本；既有输入的状态、代数与发布绑定均不变。
      const inserted = this.db
        .prepare(
          "INSERT INTO rule_set_releases(draft_revision,activation_seq,body,scope,targets,created_at) VALUES(?,?,?,?,?,?)",
        )
        .run(
          saved.revision,
          activationSeq,
          JSON.stringify(effectiveConfig),
          JSON.stringify(scope),
          "[]",
          createdAt,
        )
      const release = {
        version: Number(inserted.lastInsertRowid),
        draftRevision: saved.revision,
        activationSeq,
        scope,
        targetInputIds: [],
        createdAt,
      }
      afterActivate?.()
      const result = { ...saved, effectiveConfig, release }
      this.db
        .prepare("INSERT INTO rule_activation_requests VALUES(?,?,?)")
        .run(requestId, request, JSON.stringify(result))
      return result
    })
  }

  capture(entry: SourceEntry) {
    const contentVersion = createHash("sha256")
      .update(
        JSON.stringify([
          entry.id,
          entry.title,
          entry.url,
          entry.publishedAt,
          entry.content,
          entry.description,
          entry.author ?? null,
          entry.language ?? null,
          entry.updatedAt ?? null,
          entry.mediaLength ?? null,
          entry.attachmentsDuration ?? null,
          // 上下文补齐会产生新材料版本，避免沿用旧待补状态。
          entry.context ?? null,
          entry.imageCount ?? null,
          // 外链正文与明确获取状态也是材料版本，失败不能沿用旧完整快照。
          entry.linkedMaterials ?? null,
          entry.collected ?? null,
          // List 返回的原始 feed 身份补齐后需要重新匹配来源条件。
          entry.feedId,
          entry.feedKind,
        ]),
      )
      .digest("hex")
    return this.transaction(() => {
      const previous = this.db
        .prepare(
          "SELECT seq,content_version,release_version FROM processing_inputs WHERE source_key=? AND item_id=? AND current=1 ORDER BY seq DESC LIMIT 1",
        )
        .get(entry.sourceKey, entry.id)
      if (previous?.content_version === contentVersion) {
        // 未分配任务可刷新原文状态；已分配输入保持运行快照，阅读变化不产生新内容版本。
        if (previous.release_version === null)
          this.db
            .prepare("UPDATE processing_inputs SET body=? WHERE seq=?")
            .run(JSON.stringify(entry), previous.seq!)
        return Number(previous.seq)
      }
      this.db
        .prepare(
          "UPDATE processing_inputs SET current=0 WHERE source_key=? AND item_id=? AND current=1",
        )
        .run(entry.sourceKey, entry.id)
      const result = this.db
        .prepare(
          "INSERT INTO processing_inputs(source_key,item_id,content_version,body,received_at) VALUES(?,?,?,?,?)",
        )
        .run(
          entry.sourceKey,
          entry.id,
          contentVersion,
          JSON.stringify(entry),
          new Date().toISOString(),
        )
      return Number(result.lastInsertRowid)
    })
  }

  inputs(inputSeqs?: readonly number[]): ProcessingInput[] {
    // 详情只读取当前组的输入，避免解析全库正文；未传范围时保持原有队列口径。
    return this.db
      .prepare(
        inputSeqs
          ? "SELECT * FROM processing_inputs WHERE current=1 AND seq IN (SELECT value FROM json_each(?)) ORDER BY seq"
          : "SELECT * FROM processing_inputs WHERE current=1 ORDER BY seq",
      )
      .all(...(inputSeqs ? [JSON.stringify(inputSeqs)] : []))
      .map((row) => this.inputFromRow(row))
  }

  // 分类启用水位以首次入库为准；只读取历史元数据，正文水合换代不会伪装成新文。
  firstReceivedAt(sourceKey: string, itemId: string): string | null {
    const row = this.db
      .prepare(
        "SELECT MIN(received_at) AS first_received_at FROM processing_inputs WHERE source_key=? AND item_id=?",
      )
      .get(sourceKey, itemId)
    return row?.first_received_at == null ? null : String(row.first_received_at)
  }

  current(sourceKey: string, itemId: string): ProcessingInput | null {
    const row = this.db
      .prepare(
        "SELECT * FROM processing_inputs WHERE source_key=? AND item_id=? AND current=1 ORDER BY seq DESC LIMIT 1",
      )
      .get(sourceKey, itemId)
    return row ? this.inputFromRow(row) : null
  }

  invalidateSources(sourceKeys: string[]) {
    // 来源元数据改变时只更新受影响输入代际；既有不可变决策保留作历史。
    return this.transaction(() => {
      const keys = new Set(sourceKeys)
      const targets = this.inputs().filter(
        (input) =>
          keys.has(input.sourceKey) ||
          (input.body.feedId && keys.has(`${input.body.feedKind ?? "feed"}/${input.body.feedId}`)),
      )
      const update = this.db.prepare(
        "UPDATE processing_inputs SET generation=generation+1,status='pending' WHERE seq=? AND release_version IS NOT NULL",
      )
      for (const target of targets) update.run(target.seq)
      return targets.map((target) => target.seq)
    })
  }

  private inputFromRow(row: Record<string, unknown>): ProcessingInput {
    return {
      seq: Number(row.seq),
      sourceKey: String(row.source_key),
      itemId: String(row.item_id),
      contentVersion: String(row.content_version),
      receivedAt: String(row.received_at),
      releaseVersion: row.release_version === null ? null : Number(row.release_version),
      generation: Number(row.generation),
      status: String(row.status),
      current: Boolean(row.current),
      body: JSON.parse(String(row.body)) as SourceEntry,
    }
  }

  releases() {
    return this.db
      .prepare(
        "SELECT version,draft_revision,activation_seq,scope,targets,created_at FROM rule_set_releases ORDER BY version DESC",
      )
      .all()
      .map((row) => ({
        version: Number(row.version),
        draftRevision: Number(row.draft_revision),
        activationSeq: Number(row.activation_seq),
        scope: publicationScopeSchema.parse(JSON.parse(String(row.scope))),
        targetInputIds: JSON.parse(String(row.targets)) as number[],
        createdAt: String(row.created_at),
      }))
  }

  release(version: number): RuleSet | null {
    const row = this.db.prepare("SELECT body FROM rule_set_releases WHERE version=?").get(version)
    return row ? ruleSetSchema.parse(JSON.parse(String(row.body))) : null
  }

  releaseSnapshot(version: number) {
    const release = this.releases().find((item) => item.version === version)
    const config = this.release(version)
    return release && config ? { release, config } : null
  }

  previewPublication(rawScope: unknown): PublicationPreview {
    return this.publicationPlan(this.normalizePublicationScope(rawScope))
  }

  publish(expectedRevision: number, rawScope: unknown, requestId: string) {
    const scope = this.normalizePublicationScope(rawScope)
    if (!z.uuid().safeParse(requestId).success) throw new AutomationError("invalid_target")
    return this.transaction(() => {
      // HTTP 响应丢失后重发同一请求，返回原来的冻结范围，不再次发布或扩大目标集。
      const previous = this.db
        .prepare("SELECT * FROM publication_requests WHERE id=?")
        .get(requestId)
      if (previous) {
        if (
          Number(previous.revision) !== expectedRevision ||
          previous.scope !== JSON.stringify(scope)
        )
          throw new AutomationError("revision_conflict")
        return this.releases().find(
          (release) => release.version === Number(previous.release_version),
        )!
      }
      const draft = this.draft()
      if (draft.revision !== expectedRevision) throw new AutomationError("revision_conflict")
      // 草稿可保留待修复身份；只有发布不可变版本时才要求当前已知身份全部有效。
      if (this.validatePublication && !this.validatePublication(draft.config))
        throw new AutomationError("invalid_rule_set")
      const plan = this.publicationPlan(scope)
      const targets = new Set(plan.targetInputIds)
      const activationSeq = Number(
        this.db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM processing_inputs").get()!.seq,
      )
      const targetInputIds = plan.targetInputIds
      const createdAt = new Date().toISOString()
      const result = this.db
        .prepare(
          "INSERT INTO rule_set_releases(draft_revision,activation_seq,body,scope,targets,created_at) VALUES(?,?,?,?,?,?)",
        )
        .run(
          draft.revision,
          activationSeq,
          JSON.stringify(draft.config),
          JSON.stringify(scope),
          JSON.stringify(targetInputIds),
          createdAt,
        )
      const version = Number(result.lastInsertRowid)
      this.db
        .prepare("INSERT INTO publication_requests VALUES(?,?,?,?)")
        .run(requestId, draft.revision, JSON.stringify(scope), version)
      const update = this.db.prepare(
        "UPDATE processing_inputs SET release_version=?,generation=generation+1,status='pending' WHERE seq=? AND current=1",
      )
      for (const input of this.inputs()) if (targets.has(input.seq)) update.run(version, input.seq)
      return {
        version,
        draftRevision: draft.revision,
        activationSeq,
        scope,
        targetInputIds,
        createdAt,
      }
    })
  }

  private normalizePublicationScope(rawScope: unknown): PublicationScope {
    const parsed = publicationScopeSchema.safeParse(rawScope)
    if (!parsed.success) throw new AutomationError("invalid_target")
    if (parsed.data.mode !== "selected") return parsed.data
    return {
      mode: "selected",
      inputIds: [...new Set(parsed.data.inputIds)].sort((left, right) => left - right),
    }
  }

  private publicationPlan(scope: PublicationScope): PublicationPreview {
    const inputs = this.inputs()
    const selected = scope.mode === "selected" ? new Set(scope.inputIds) : null
    if (selected && [...selected].some((id) => !inputs.some((input) => input.seq === id)))
      throw new AutomationError("invalid_target")
    // 即便用户选了既有内容，纯注意力变更也不换代或重排模型任务。
    const attentionOnly = attentionOnlyRuleChange(this.effective().config, this.draft().config)
    const targets = inputs.filter(
      (input) =>
        !attentionOnly &&
        (input.releaseVersion === null ||
          (scope.mode === "selected" && selected!.has(input.seq)) ||
          (scope.mode === "recent" && Date.parse(input.receivedAt) >= Date.parse(scope.since))),
    )
    const targetIds = new Set(targets.map((input) => input.seq))
    const unchanged = inputs.filter(
      (input) => input.releaseVersion !== null && !targetIds.has(input.seq),
    )
    return {
      scope,
      targetInputIds: targets.map((input) => input.seq),
      impact: {
        newAssignments: targets.filter((input) => input.releaseVersion === null).length,
        recalculated: targets.filter((input) => input.releaseVersion !== null).length,
        queuedUnchanged: unchanged.filter((input) => ["pending", "running"].includes(input.status))
          .length,
        historicalUnchanged: unchanged.filter(
          (input) => !["pending", "running"].includes(input.status),
        ).length,
      },
    }
  }

  assign(seq: number) {
    return this.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM processing_inputs WHERE seq=? AND current=1")
        .get(seq)
      if (!row) throw new AutomationError("invalid_target")
      if (row.release_version === null) {
        const release = this.db
          .prepare("SELECT MAX(version) AS version FROM rule_set_releases")
          .get()
        if (release?.version == null) throw new AutomationError("invalid_target")
        this.db
          .prepare(
            "UPDATE processing_inputs SET release_version=?,generation=generation+1 WHERE seq=?",
          )
          .run(release.version, seq)
      }
      return this.inputFromRow(
        this.db.prepare("SELECT * FROM processing_inputs WHERE seq=?").get(seq)!,
      )
    })
  }

  // 仅把用户本次加载的未读条目交给当前分类规则，不扫描或迁移其他历史输入。
  assignLoadedRelease(input: ProcessingInput, releaseVersion: number): boolean {
    this.owner()
    if (
      input.body.read !== false ||
      !input.current ||
      input.status === "running" ||
      input.status === "pending" ||
      releaseVersion !== this.effective().releaseVersion
    )
      return false
    const result = this.db
      .prepare(
        "UPDATE processing_inputs SET generation=generation+1,release_version=?,status='pending',decision_id=NULL WHERE seq=? AND current=1 AND content_version=? AND generation=? AND release_version IS ? AND status IN ('succeeded','skipped','failed')",
      )
      .run(releaseVersion, input.seq, input.contentVersion, input.generation, input.releaseVersion)
    return result.changes === 1
  }

  recalculate(target: ProcessingInput, decision: object, releaseVersion = target.releaseVersion) {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM processing_inputs WHERE seq=?").get(target.seq)
      if (
        !row ||
        !row.current ||
        !target.current ||
        row.content_version !== target.contentVersion ||
        Number(row.generation) !== target.generation ||
        (row.release_version === null ? null : Number(row.release_version)) !==
          target.releaseVersion
      ) {
        throw new AutomationError("revision_conflict")
      }
      if (releaseVersion === null || !this.release(releaseVersion))
        throw new AutomationError("invalid_target")
      // 策略重算只更换决策代际和发布引用，不修改材料、已读状态或不可变历史。
      this.db
        .prepare(
          "UPDATE processing_inputs SET generation=generation+1,release_version=?,status='pending',decision_id=NULL WHERE seq=?",
        )
        .run(releaseVersion, target.seq)
      const input = this.inputFromRow(
        this.db.prepare("SELECT * FROM processing_inputs WHERE seq=?").get(target.seq)!,
      )
      const completed = this.complete(input, decision)
      return { input: { ...input, status: "succeeded" }, ...completed }
    })
  }

  complete(target: ProcessingInput, decision: object) {
    return this.transaction(() => {
      if (target.releaseVersion === null) throw new AutomationError("invalid_target")
      // 同一目标只接受第一个完成结果；重发不能替换已经保存的不可变决策。
      const id = createHash("sha256")
        .update(JSON.stringify([target.seq, target.generation, target.releaseVersion]))
        .digest("hex")
      this.db
        .prepare("INSERT OR IGNORE INTO entry_decisions VALUES(?,?,?,?,?,?)")
        .run(
          id,
          target.seq,
          target.generation,
          target.releaseVersion,
          JSON.stringify(decision),
          new Date().toISOString(),
        )
      // 晚到任务保留历史，但不能覆盖新内容、新发布范围或重算后的当前结果。
      const result = this.db
        .prepare(
          "UPDATE processing_inputs SET status='succeeded',decision_id=? WHERE seq=? AND current=1 AND content_version=? AND generation=? AND release_version=?",
        )
        .run(id, target.seq, target.contentVersion, target.generation, target.releaseVersion)
      return { id, published: result.changes === 1 }
    })
  }

  reconcileUnchangedInput(
    manifest: readonly UnchangedInputReconciliation[],
    guard: UnchangedInputReconciliationGuard,
  ) {
    // 该入口只用于经逐项核对的事故清单；全部守卫在同一事务内成立后才迁回旧指针。
    return this.transaction(() => {
      const invalid = (): never => {
        throw new AutomationError("invalid_reconciliation")
      }
      if (
        manifest.length !== guard.expectedCount ||
        manifest.length === 0 ||
        new Set(manifest.map((item) => item.currentSeq)).size !== manifest.length ||
        new Set(manifest.map((item) => item.historicalSeq)).size !== manifest.length
      )
        invalid()
      if (
        Number(
          this.db
            .prepare("SELECT count(*) AS n FROM processing_inputs WHERE status='running'")
            .get()?.n ?? 0,
        ) !== 0
      )
        invalid()
      const duplicateCurrent = this.db
        .prepare(
          "SELECT 1 FROM processing_inputs WHERE current=1 GROUP BY source_key,item_id HAVING count(*)<>1 LIMIT 1",
        )
        .get()
      if (duplicateCurrent) invalid()
      const currentCount = Number(
        this.db.prepare("SELECT count(*) AS n FROM processing_inputs WHERE current=1").get()?.n ??
          0,
      )
      const selectInput = this.db.prepare("SELECT * FROM processing_inputs WHERE seq=?")
      const selectDecision = this.db.prepare("SELECT * FROM entry_decisions WHERE id=?")
      const selectRelease = this.db.prepare("SELECT 1 FROM rule_set_releases WHERE version=?")
      const selectSnapshot = this.db.prepare(
        "SELECT error FROM processing_target_snapshots WHERE input_seq=? AND generation=?",
      )
      const selectCache = this.db.prepare(
        "SELECT body FROM processing_model_cache WHERE fingerprint=?",
      )
      const selectMaterial = this.db.prepare(
        "SELECT status FROM processing_material_state WHERE source_key=? AND item_id=? AND content_version=?",
      )
      const demote = this.db.prepare(
        "UPDATE processing_inputs SET current=0 WHERE seq=? AND current=1",
      )
      const promote = this.db.prepare(
        "UPDATE processing_inputs SET current=1 WHERE seq=? AND current=0",
      )
      const restored = { succeeded: 0, failed: 0, pending: 0 }
      for (const item of manifest) {
        const current = selectInput.get(item.currentSeq)
        const historical = selectInput.get(item.historicalSeq)
        if (!current || !historical) invalid()
        const currentRow = current as Record<string, unknown>
        const historicalRow = historical as Record<string, unknown>
        const currentReceivedAt = Date.parse(String(currentRow.received_at))
        const minimumCurrentReceivedAt = Date.parse(guard.minimumCurrentReceivedAt)
        if (
          item.currentSeq < guard.minimumCurrentSeq ||
          item.historicalSeq > guard.maximumHistoricalSeq ||
          String(currentRow.received_at) !== item.expectedCurrentReceivedAt ||
          !Number.isFinite(currentReceivedAt) ||
          !Number.isFinite(minimumCurrentReceivedAt) ||
          currentReceivedAt < minimumCurrentReceivedAt ||
          Number(currentRow.current) !== 1 ||
          Number(historicalRow.current) !== 0 ||
          String(currentRow.source_key) !== item.sourceKey ||
          String(historicalRow.source_key) !== item.sourceKey ||
          String(currentRow.item_id) !== item.itemId ||
          String(historicalRow.item_id) !== item.itemId ||
          String(currentRow.content_version) !== item.contentVersion ||
          String(historicalRow.content_version) !== item.contentVersion ||
          String(currentRow.status) !== item.expectedCurrentStatus ||
          String(historicalRow.status) !== item.expectedHistoricalStatus ||
          Number(historicalRow.release_version) !== item.expectedReleaseVersion ||
          Number(historicalRow.generation) !== item.expectedGeneration ||
          (currentRow.decision_id === null ? null : String(currentRow.decision_id)) !==
            item.expectedCurrentDecisionId ||
          (historicalRow.decision_id === null ? null : String(historicalRow.decision_id)) !==
            item.expectedDecisionId ||
          !selectRelease.get(item.expectedReleaseVersion)
        )
          invalid()
        const currentBody = parseObject(currentRow.body)
        const historicalBody = parseObject(historicalRow.body)
        if (!currentBody || !historicalBody || !equalExceptRead(currentBody, historicalBody))
          invalid()
        if (
          String(
            selectMaterial.get(item.sourceKey, item.itemId, item.contentVersion)?.status ?? "",
          ) !== "complete"
        )
          invalid()
        if (item.expectedHistoricalStatus === "succeeded") {
          if (!item.expectedDecisionId || item.expectedSnapshotError !== null) invalid()
          const decision = selectDecision.get(item.expectedDecisionId)
          if (!decision) invalid()
          const decisionRow = decision as Record<string, unknown>
          if (
            Number(decisionRow.input_seq) !== item.historicalSeq ||
            Number(decisionRow.generation) !== item.expectedGeneration ||
            Number(decisionRow.release_version) !== item.expectedReleaseVersion
          )
            invalid()
          const decisionBody = parseObject(decisionRow.body)
          const fingerprint = decisionBody?.fingerprint
          if (
            decisionBody?.schemaVersion !== 1 ||
            typeof fingerprint !== "string" ||
            !/^[a-f0-9]{64}$/u.test(fingerprint)
          )
            invalid()
          const verifiedFingerprint = fingerprint as string
          const cacheBody = parseObject(selectCache.get(verifiedFingerprint)?.body)
          if (cacheBody?.schemaVersion !== 1 || cacheBody.fingerprint !== verifiedFingerprint)
            invalid()
        } else {
          if (item.expectedDecisionId !== null || !item.expectedSnapshotError) invalid()
          const snapshot = selectSnapshot.get(item.historicalSeq, item.expectedGeneration)
          if (!snapshot || snapshot.error !== item.expectedSnapshotError) invalid()
        }
        // 历史已分配输入保持不可变；实时 read 继续由 entries 表提供。
        if (demote.run(item.currentSeq).changes !== 1) invalid()
        if (promote.run(item.historicalSeq).changes !== 1) invalid()
        restored[item.expectedHistoricalStatus] += 1
      }
      const finalCurrentCount = Number(
        this.db.prepare("SELECT count(*) AS n FROM processing_inputs WHERE current=1").get()?.n ??
          0,
      )
      const finalDuplicateCurrent = this.db
        .prepare(
          "SELECT 1 FROM processing_inputs WHERE current=1 GROUP BY source_key,item_id HAVING count(*)<>1 LIMIT 1",
        )
        .get()
      if (finalCurrentCount !== currentCount || finalDuplicateCurrent) invalid()
      return { total: manifest.length, ...restored }
    })
  }
}

function parseObject(value: unknown): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(String(value)) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function equalExceptRead(left: Record<string, unknown>, right: Record<string, unknown>) {
  const { read: _leftRead, ...leftStable } = left
  const { read: _rightRead, ...rightStable } = right
  return JSON.stringify(leftStable) === JSON.stringify(rightStable)
}
