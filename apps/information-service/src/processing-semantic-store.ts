import { randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"

import type { SemanticEntity, SemanticTagId, TagAssessment } from "@follow/information-core"
import {
  matchConditions,
  SEMANTIC_ENTITY_VERSION,
  semanticEntitiesSchema,
  semanticEntityId,
  semanticTagDefinition,
  semanticTagIds,
  semanticTagIdSchema,
} from "@follow/information-core"
import { z } from "zod"

import type { AutomationStore, ProcessingInput } from "./automation-store"
import { AutomationError } from "./automation-store"
import type { EntrySemanticProfile, ProcessingDecision } from "./processing-decision"
import { effectiveSemanticAssessments } from "./processing-semantic-decision"
import { entitiesHaveEvidence } from "./processing-semantic-entities"

// 查询快照只用于短期分页，限制时效与数量，避免逐次筛选永久增长。
const snapshotMaxAgeMs = 24 * 60 * 60 * 1000
const snapshotMaxCount = 100

export const semanticQuerySchema = z
  .object({
    includeTagIds: z.array(semanticTagIdSchema).max(semanticTagIds.length).default([]),
    excludeTagIds: z.array(semanticTagIdSchema).max(semanticTagIds.length).default([]),
    match: z.enum(["any", "all"]).default("any"),
    sourceKeys: z.array(z.string().min(1).max(300)).max(10000).optional(),
    state: z.enum(["matched", "unknown"]).default("matched"),
    snapshotId: z.uuid().optional(),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(50).default(30),
  })
  .strict()
export const semanticOverrideSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    expectedContentVersion: z.string().min(1),
    requestId: z.uuid(),
    changes: z
      .array(
        z
          .object({
            tagId: semanticTagIdSchema,
            state: z.enum(["present", "absent", "automatic"]),
          })
          .strict(),
      )
      .min(1)
      .max(semanticTagIds.length),
  })
  .strict()
  .refine(
    (request) =>
      new Set(request.changes.map((change) => change.tagId)).size === request.changes.length,
    "duplicate_override_tag",
  )
export type SemanticQuery = z.infer<typeof semanticQuerySchema>
export type SemanticOverrideRequest = z.infer<typeof semanticOverrideSchema>
export type EntrySemanticsView = {
  profile: EntrySemanticProfile | null
  assessments: TagAssessment[]
  overrideRevision: number
  decisionId: string | null
}

// 标签索引是不可变语义档案和人工覆盖的投影，所有表沿用当前账号数据库。
export class ProcessingSemanticStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly automation: AutomationStore,
    private readonly ownerId: () => string | null,
    private readonly onPublished?: (
      input: ProcessingInput,
      decision: ProcessingDecision,
      decisionId: string,
    ) => void,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS entry_semantic_profiles(input_seq INTEGER PRIMARY KEY,content_version TEXT NOT NULL,decision_id TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entry_tag_index(input_seq INTEGER NOT NULL,tag_id TEXT NOT NULL,state TEXT NOT NULL,definition_version INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(input_seq,tag_id));
      CREATE INDEX IF NOT EXISTS entry_tag_lookup ON entry_tag_index(tag_id,state,definition_version,input_seq);
      CREATE TABLE IF NOT EXISTS entry_entity_index(input_seq INTEGER NOT NULL,entity_id TEXT NOT NULL,entity_version INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(input_seq,entity_id));
      CREATE INDEX IF NOT EXISTS entry_entity_lookup ON entry_entity_index(entity_id,entity_version,input_seq);
      CREATE TABLE IF NOT EXISTS semantic_field_overrides(source_key TEXT NOT NULL,item_id TEXT NOT NULL,content_version TEXT NOT NULL,tag_id TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(source_key,item_id,content_version,tag_id));
      CREATE TABLE IF NOT EXISTS semantic_override_revisions(source_key TEXT NOT NULL,item_id TEXT NOT NULL,content_version TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(source_key,item_id,content_version));
      CREATE TABLE IF NOT EXISTS semantic_override_requests(id TEXT PRIMARY KEY,request TEXT NOT NULL,response TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS semantic_query_snapshots(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,query TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS semantic_snapshot_created ON semantic_query_snapshots(created_at);
    `)
  }

  publish(input: ProcessingInput, decision: ProcessingDecision) {
    this.requireOwner()
    return this.transaction(() => {
      const result = this.automation.complete(input, decision)
      if (result.published) this.index(input, decision, result.id)
      return result
    })
  }

  index(input: ProcessingInput, decision: ProcessingDecision, decisionId: string) {
    this.requireOwner()
    // 只能索引当前已发布指针；重发沿用首个不可变结果，不采用后到模型的新内容。
    const row = this.db
      .prepare(
        "SELECT decisions.body FROM processing_inputs current JOIN entry_decisions decisions ON decisions.id=current.decision_id AND decisions.input_seq=current.seq AND decisions.generation=current.generation AND decisions.release_version=current.release_version WHERE current.seq=? AND current.current=1 AND current.status='succeeded' AND current.content_version=? AND current.generation=? AND current.release_version=? AND current.decision_id=?",
      )
      .get(input.seq, input.contentVersion, input.generation, input.releaseVersion, decisionId)
    if (!row) return
    const committed = JSON.parse(String(row.body)) as ProcessingDecision
    // 事件与语义索引共用当前决定边界，旧格式的单事件结果也能原子登记。
    this.onPublished?.(input, committed, decisionId)
    const profile = committed.semanticProfile
    if (!profile || profile.contentVersion !== input.contentVersion) return
    this.db
      .prepare(
        "INSERT INTO entry_semantic_profiles VALUES(?,?,?,?) ON CONFLICT(input_seq) DO UPDATE SET content_version=excluded.content_version,decision_id=excluded.decision_id,body=excluded.body",
      )
      .run(input.seq, input.contentVersion, decisionId, JSON.stringify(profile))
    const assessments = this.assessments(input, profile)
    this.db.prepare("DELETE FROM entry_tag_index WHERE input_seq=?").run(input.seq)
    const insert = this.db.prepare("INSERT INTO entry_tag_index VALUES(?,?,?,?,?)")
    for (const assessment of assessments)
      insert.run(
        input.seq,
        assessment.tagId,
        assessment.state,
        assessment.definitionVersion,
        JSON.stringify(assessment),
      )
    // 实体只索引经过正文校验的高置信结果；旧档案没有实体字段时不推断名称。
    this.db.prepare("DELETE FROM entry_entity_index WHERE input_seq=?").run(input.seq)
    const entities = semanticEntitiesSchema.safeParse(profile.entities)
    if (
      profile.entityVersion === SEMANTIC_ENTITY_VERSION &&
      entities.success &&
      entitiesHaveEvidence(entities.data, (id) => profile.evidence[id] ?? null)
    ) {
      const insertEntity = this.db.prepare("INSERT INTO entry_entity_index VALUES(?,?,?,?)")
      for (const entity of entities.data.filter((item) => item.confidence >= 0.9))
        insertEntity.run(
          input.seq,
          semanticEntityId(entity),
          SEMANTIC_ENTITY_VERSION,
          JSON.stringify(entity),
        )
    }
  }

  assessments(input: ProcessingInput, profile?: EntrySemanticProfile): TagAssessment[] {
    this.requireOwner()
    if (profile && profile.contentVersion !== input.contentVersion) return []
    const changes = this.db
      .prepare(
        "SELECT tag_id,state FROM semantic_field_overrides WHERE source_key=? AND item_id=? AND content_version=?",
      )
      .all(input.sourceKey, input.itemId, input.contentVersion)
      .map((row) => ({
        tagId: String(row.tag_id),
        state: String(row.state) as "present" | "absent",
      }))
    return effectiveSemanticAssessments(
      profile?.assessments ?? this.view(input).profile?.assessments ?? [],
      changes,
    )
  }

  // 列表批量读取当前有效标签，复用包含人工纠错的索引，不逐条解析完整证据或发起查询。
  presentTagIdsByInput(): Map<number, SemanticTagId[]> {
    this.requireOwner()
    const result = new Map<number, SemanticTagId[]>()
    for (const row of this.db
      .prepare(
        `SELECT tags.input_seq,tags.tag_id,tags.definition_version FROM entry_tag_index tags
         JOIN entry_semantic_profiles profile ON profile.input_seq=tags.input_seq
         JOIN processing_inputs current ON current.seq=tags.input_seq AND current.current=1
           AND current.content_version=profile.content_version AND current.decision_id=profile.decision_id
         JOIN entry_decisions decision ON decision.id=current.decision_id AND decision.input_seq=current.seq
           AND decision.generation=current.generation AND decision.release_version=current.release_version
         WHERE current.status='succeeded' AND tags.state='present' ORDER BY tags.input_seq,tags.tag_id`,
      )
      .all()) {
      const tag = semanticTagIdSchema.safeParse(row.tag_id)
      if (
        !tag.success ||
        semanticTagDefinition(tag.data)?.definitionVersion !== Number(row.definition_version)
      )
        continue
      const inputSeq = Number(row.input_seq)
      const tags = result.get(inputSeq) ?? []
      tags.push(tag.data)
      result.set(inputSeq, tags)
    }
    return result
  }

  // 与标签一样一次读取身份投影，不为列表每个条目查询或解析完整语义档案。
  presentEntitiesByInput(): Map<number, SemanticEntity[]> {
    this.requireOwner()
    const result = new Map<number, SemanticEntity[]>()
    const rows = this.db
      .prepare(
        `SELECT entities.input_seq,entities.body FROM entry_entity_index entities
      JOIN entry_semantic_profiles profile ON profile.input_seq=entities.input_seq
      JOIN processing_inputs current ON current.seq=entities.input_seq AND current.current=1
        AND current.content_version=profile.content_version AND current.decision_id=profile.decision_id
      JOIN entry_decisions decision ON decision.id=current.decision_id AND decision.input_seq=current.seq
        AND decision.generation=current.generation AND decision.release_version=current.release_version
      WHERE current.status='succeeded' AND entities.entity_version=? ORDER BY entities.input_seq,entities.entity_id`,
      )
      .all(SEMANTIC_ENTITY_VERSION)
    for (const row of rows) {
      const seq = Number(row.input_seq)
      const entities = result.get(seq) ?? []
      entities.push(JSON.parse(String(row.body)) as SemanticEntity)
      result.set(seq, entities)
    }
    return result
  }

  view(input: ProcessingInput): EntrySemanticsView {
    this.requireOwner()
    const row = this.db
      .prepare(
        "SELECT profile.body,profile.decision_id FROM entry_semantic_profiles profile JOIN processing_inputs current ON current.seq=profile.input_seq AND current.content_version=profile.content_version AND current.decision_id=profile.decision_id WHERE current.seq=? AND current.current=1 AND current.content_version=? AND current.source_key=? AND current.item_id=?",
      )
      .get(input.seq, input.contentVersion, input.sourceKey, input.itemId)
    const profile = row ? (JSON.parse(String(row.body)) as EntrySemanticProfile) : null
    const revision = this.db
      .prepare(
        "SELECT revision FROM semantic_override_revisions WHERE source_key=? AND item_id=? AND content_version=?",
      )
      .get(input.sourceKey, input.itemId, input.contentVersion)
    return {
      profile,
      assessments: profile ? this.assessments(input, profile) : [],
      overrideRevision: Number(revision?.revision ?? 0),
      decisionId: row ? String(row.decision_id) : null,
    }
  }

  correct(
    input: ProcessingInput,
    request: SemanticOverrideRequest,
    recompute: () => void,
  ): EntrySemanticsView {
    this.requireOwner()
    request = semanticOverrideSchema.parse(request)
    return this.transaction(() => {
      const encoded = JSON.stringify({ seq: input.seq, ...request })
      const prior = this.db
        .prepare("SELECT request,response FROM semantic_override_requests WHERE id=?")
        .get(request.requestId)
      if (prior) {
        if (prior.request !== encoded) throw new AutomationError("revision_conflict")
        return JSON.parse(String(prior.response)) as EntrySemanticsView
      }
      const current = this.automation.current(input.sourceKey, input.itemId)
      if (
        !current ||
        current.seq !== input.seq ||
        current.contentVersion !== input.contentVersion ||
        current.generation !== input.generation ||
        current.releaseVersion !== input.releaseVersion
      ) {
        throw new AutomationError("revision_conflict")
      }
      const view = this.view(input)
      if (
        input.contentVersion !== request.expectedContentVersion ||
        view.overrideRevision !== request.expectedRevision
      )
        throw new AutomationError("revision_conflict")
      if (!view.profile) throw new AutomationError("invalid_target")
      const set = this.db.prepare(
        "INSERT INTO semantic_field_overrides VALUES(?,?,?,?,?) ON CONFLICT(source_key,item_id,content_version,tag_id) DO UPDATE SET state=excluded.state",
      )
      const clear = this.db.prepare(
        "DELETE FROM semantic_field_overrides WHERE source_key=? AND item_id=? AND content_version=? AND tag_id=?",
      )
      for (const change of request.changes) {
        if (change.state === "automatic")
          clear.run(input.sourceKey, input.itemId, input.contentVersion, change.tagId)
        else
          set.run(input.sourceKey, input.itemId, input.contentVersion, change.tagId, change.state)
      }
      this.db
        .prepare(
          "INSERT INTO semantic_override_revisions VALUES(?,?,?,?) ON CONFLICT(source_key,item_id,content_version) DO UPDATE SET revision=excluded.revision",
        )
        .run(input.sourceKey, input.itemId, input.contentVersion, request.expectedRevision + 1)
      // 覆盖、阅读重算与索引更新同一事务提交，晚到模型结果仍从覆盖层构建投影。
      recompute()
      const result = this.view(input)
      this.db
        .prepare("INSERT INTO semantic_override_requests VALUES(?,?,?)")
        .run(request.requestId, encoded, JSON.stringify(result))
      return result
    })
  }

  query(
    request: SemanticQuery,
    availableSources: ReadonlySet<string>,
    excludedInputSeqs: ReadonlySet<number> = new Set(),
  ) {
    const ownerId = this.requireOwner()
    const { snapshotId, offset, limit, ...filter } = request
    const queryKey = JSON.stringify({
      ...filter,
      sourceKeys: filter.sourceKeys?.slice().sort(),
      availableSources: [...availableSources].sort(),
      excludedInputSeqs: [...excludedInputSeqs].sort((a, b) => a - b),
    })
    // 分页继续使用冻结来源授权；授权改变后重新查询，不能沿用旧计数或先分页再删条目。
    this.cleanSnapshots()
    let id = snapshotId
    let body: {
      entries: Array<{
        inputSeq: number
        sourceKey: string
        itemId: string
        title: string
        url: string | null
        publishedAt: string
        assessments: TagAssessment[]
      }>
      counts: { matched: number; unknown: number; indexed: number; scopeTotal: number }
    }
    if (id) {
      const row = this.db
        .prepare("SELECT query,body FROM semantic_query_snapshots WHERE id=? AND owner_id=?")
        .get(id, ownerId)
      if (!row || row.query !== queryKey) throw new AutomationError("invalid_target")
      body = JSON.parse(String(row.body)) as typeof body
    } else {
      const sourceKeys = filter.sourceKeys ? new Set(filter.sourceKeys) : null
      if (filter.sourceKeys?.some((key) => !availableSources.has(key)))
        throw new AutomationError("invalid_target")
      const scope = this.automation
        .inputs()
        .filter(
          (input) =>
            input.current &&
            !excludedInputSeqs.has(input.seq) &&
            availableSources.has(input.sourceKey) &&
            (!sourceKeys || sourceKeys.has(input.sourceKey)),
        )
      const indexed = new Map<number, TagAssessment[]>()
      for (const row of this.db
        .prepare(
          "SELECT tags.input_seq,tags.body FROM entry_tag_index tags JOIN entry_semantic_profiles profile ON profile.input_seq=tags.input_seq JOIN processing_inputs current ON current.seq=tags.input_seq AND current.current=1 AND current.content_version=profile.content_version AND current.decision_id=profile.decision_id",
        )
        .all()) {
        const seq = Number(row.input_seq)
        const assessments = indexed.get(seq) ?? []
        assessments.push(JSON.parse(String(row.body)) as TagAssessment)
        indexed.set(seq, assessments)
      }
      const conditions = [
        ...(filter.includeTagIds.length
          ? [
              {
                field: "entry_tag" as const,
                operator:
                  filter.match === "all" ? ("contains_all" as const) : ("contains_any" as const),
                value: filter.includeTagIds,
              },
            ]
          : []),
        ...(filter.excludeTagIds.length
          ? [
              {
                field: "entry_tag" as const,
                operator: "not_contains_any" as const,
                value: filter.excludeTagIds,
              },
            ]
          : []),
      ]
      const states = scope.map((input) => ({
        input,
        assessments: indexed.get(input.seq) ?? [],
        state: conditions.length
          ? matchConditions(
              { anyOf: [{ allOf: conditions }] },
              {
                source_id: input.sourceKey,
                contextId: input.sourceKey,
                entry_tag: indexed.get(input.seq),
              },
            ).state
          : ("match" as const),
      }))
      body = {
        counts: {
          matched: states.filter((item) => item.state === "match").length,
          unknown: states.filter((item) => item.state === "unknown").length,
          indexed: scope.filter((input) => indexed.has(input.seq)).length,
          scopeTotal: scope.length,
        },
        entries: states
          .filter((item) => item.state === (filter.state === "unknown" ? "unknown" : "match"))
          .sort(
            (left, right) =>
              right.input.body.publishedAt.localeCompare(left.input.body.publishedAt) ||
              right.input.seq - left.input.seq,
          )
          .map(({ input, assessments }) => ({
            inputSeq: input.seq,
            sourceKey: input.sourceKey,
            itemId: input.itemId,
            title: input.body.title,
            url: input.body.url,
            publishedAt: input.body.publishedAt,
            assessments,
          })),
      }
      id = randomUUID()
      this.db
        .prepare("INSERT INTO semantic_query_snapshots VALUES(?,?,?,?,?)")
        .run(id, ownerId, queryKey, JSON.stringify(body), new Date().toISOString())
      this.cleanSnapshots()
    }
    // 先筛选完整索引范围，再冻结分页；未分析项独立计数，不能冒充明确不匹配。
    return {
      snapshotId: id,
      entries: body.entries.slice(offset, offset + limit),
      counts: body.counts,
      nextOffset: offset + limit < body.entries.length ? offset + limit : null,
    }
  }

  private cleanSnapshots() {
    this.db
      .prepare("DELETE FROM semantic_query_snapshots WHERE created_at<=?")
      .run(new Date(Date.now() - snapshotMaxAgeMs).toISOString())
    this.db
      .prepare(
        "DELETE FROM semantic_query_snapshots WHERE id IN (SELECT id FROM semantic_query_snapshots ORDER BY created_at DESC,rowid DESC LIMIT -1 OFFSET ?)",
      )
      .run(snapshotMaxCount)
  }

  private requireOwner() {
    const ownerId = this.ownerId()
    if (!ownerId) throw new AutomationError("owner_required")
    return ownerId
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("SAVEPOINT semantic_write")
    try {
      const result = operation()
      this.db.exec("RELEASE semantic_write")
      return result
    } catch (error) {
      this.db.exec("ROLLBACK TO semantic_write; RELEASE semantic_write")
      throw error
    }
  }
}
