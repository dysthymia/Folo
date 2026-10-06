import { randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"

import type { PresentationPolicy } from "@follow/information-core"
import { compileInstructions, matchConditions } from "@follow/information-core"

import type { AutomationStore, ProcessingInput } from "./automation-store"
import { contentIdentity } from "./content-identity"
import type { Source, SourceEntry } from "./folo"
import type {
  GeneratedFeedQuery,
  GeneratedFeedScope,
  GeneratedReaderItem,
  GeneratedReaderProjection,
} from "./generated-feeds"
import {
  GENERATED_EVENTS_FEED_ID,
  generatedEventsFeed,
  GeneratedFeedStore,
  matchesGeneratedItem,
} from "./generated-feeds"
import { processingRuleInput } from "./processing-context"
import type { ProcessingDecision, PublishedDecision } from "./processing-decision"
import type { ProcessingDedupeStore } from "./processing-dedupe"
import { activeDedupeActions } from "./processing-dedupe"
import type { ProcessingScheduleConfig } from "./processing-schedule"
import type { ProcessingStateStore } from "./processing-state"
import { dedupeContentEvidence, SEMANTIC_DUPLICATE_CONFIDENCE_THRESHOLD } from "./semantic-dedupe"
import { sourceText } from "./service"
import type { Store } from "./store"
import type { Story, StoryRevision, StoryStore } from "./story-store"

export type ReadingView =
  "smart" | "standalone" | "all" | "hidden" | "pending" | "skipped" | "failed" | "stories"
export type ReadingSnapshotAudit = {
  cutoffAt: string
  maxSeq: number
  appliedRelease: number | null
  currentDecisionId: string | null
  storyRevision: number | null
}
export type ReadingSnapshot = {
  id: string
  cutoffAt: string
  maxSeq: number
  createdAt: string
  latestAvailable: boolean
}
export type ReadingSnapshotCounts = {
  standalone: number
  stories: number
  hidden: number
  pending: number
  skipped: number
  failed: number
}
export type ReadingEntry = {
  kind: "entry"
  state: "ready"
  ordinal: number
  inputSeq: number
  sourceKey: string
  itemId: string
  title: string
  url: string | null
  read: boolean | null
  receivedAt: string
  decision: Pick<
    ProcessingDecision,
    "status" | "title" | "summary" | "reason" | "labels" | "policy"
  > & { id: string }
  audit: ReadingSnapshotAudit
}
export type ReadingStory = {
  kind: "story"
  state: "ready"
  ordinal: number
  story: Story
  revision: number
  title: string
  body: string
  audit: ReadingSnapshotAudit
}
export type ReadingRepairing = {
  kind: "entry" | "story"
  state: "repairing"
  ordinal: number
  inputSeq: number | null
  storyId: string | null
  audit: ReadingSnapshotAudit
}
export type ReadingPending = {
  kind: "entry"
  state: "pending"
  ordinal: number
  inputSeq: number
  sourceKey: string
  itemId: string
  title: string
  url: string | null
  read: boolean | null
  receivedAt: string
  status: string
  decision: null
  audit: ReadingSnapshotAudit
}
export type ReadingSnapshotItem = ReadingEntry | ReadingStory | ReadingPending | ReadingRepairing
export type ReadingSnapshotPage = {
  snapshot: ReadingSnapshot
  view: ReadingView
  offset: number
  limit: number
  total: number
  items: ReadingSnapshotItem[]
}
/**
 * 时间线角色投影。
 *
 * 阅读快照只覆盖计划的 `sourceKeys + historySince`，而时间线要覆盖全部订阅，
 * 因此角色单独投影一次：判定口径与快照一致（同一个 `entryHidden`），但范围取全部
 * current input。`hidden` 是显式隐藏，`story` 代表整篇综述、`merged` 表示内容已在
 * 别处呈现（综述的其他成员、语义去重判定的重复条目，或与成员同内容的转载），
 * `keeper` 是语义去重里保留了内容的那一条，`restored` 是被用户手动恢复、重新独立
 * 显示的条目——它优先于隐藏与并入，否则"恢复"在界面上看不出来。
 */
export type ProcessingEntryRoleKind = "hidden" | "story" | "merged" | "keeper" | "restored"
export type ProcessingEntryRole = {
  /** Folo 条目 id，渲染层用它作为角色层的键。 */
  itemId: string
  inputSeq: number
  kind: ProcessingEntryRoleKind
  /** 隐藏原因取决定自身的 reason；合并角色取综述标题或判重理由。 */
  reason: string | null
  /** `story`/`keeper` 指向被并入的成员，`merged` 指向保留了内容的那一条。 */
  relatedEntryIds: string[]
  storyId: string | null
  storyTitle: string | null
  materialCount?: number
  /** 列表携带少量元信息，悬停预览无需再请求正文或组明细。 */
  relatedEntryPreviews?: Array<{
    itemId: string
    title: string | null
    sourceTitle: string | null
    publishedAt: string | null
    url: string | null
  }>
}
export type ResearchPackReference = {
  inputSeq: number
  sourceKey: string
  itemId: string
  title: string
  url: string | null
  quote: string
}
export type ResearchPack =
  | {
      status: "ready"
      storyId: string
      revision: number
      title: string
      markdown: string
      references: ResearchPackReference[]
    }
  | {
      status: "repairing" | "missing"
      storyId: string
      revision: null
      title: null
      markdown: null
      references: []
    }

/**
 * 时间线内联综述摘要（§6 场景二）。
 *
 * 与 `ResearchPack` 的区别：研究包是「把综述交给研究流程」的输入，按来源片段平铺引用；
 * 这里是「在列表里就地读综述」，需要按句子分组引用，并给出更新时间与来源数。
 */
export type StoryDigestCitation = {
  id: string
  quote: string
  sourceKey: string
  sourceTitle: string
  sourceUrl: string | null
}
export type StoryDigestSentence = {
  id: string
  text: string
  citations: StoryDigestCitation[]
}
export type StoryDigestSource = {
  inputSeq: number
  sourceKey: string
  itemId: string
  title: string
  url: string | null
}
export type StoryDigest =
  | {
      status: "ready"
      storyId: string
      revision: number
      title: string
      body: string
      updatedAt: string
      /** 参与这篇综述的来源条目数（同一来源多条按条目计）。 */
      sourceCount: number
      sources: StoryDigestSource[]
      sentences: StoryDigestSentence[]
      /** 句子中未被任何引用支撑的条数，用于提示「分歧与未证实」需人工核对。 */
      uncitedSentenceCount: number
    }
  | {
      status: "repairing" | "missing"
      storyId: string
      revision: null
      title: null
      body: null
      updatedAt: null
      sourceCount: 0
      sources: []
      sentences: []
      uncitedSentenceCount: 0
    }

export class ProcessingReadingError extends Error {
  constructor(
    public readonly code:
      "owner_required" | "snapshot_not_found" | "invalid_snapshot" | "invalid_pagination",
  ) {
    super(code)
    this.name = "ProcessingReadingError"
  }
}

type SnapshotMember = {
  snapshotId: string
  ordinal: number
  kind: "entry" | "story"
  inputSeq: number | null
  decisionId: string | null
  releaseVersion: number | null
  storyId: string | null
  storyRevision: number | null
  entryStatus: string | null
  hidden: boolean
  represented: boolean
}
type SnapshotRow = Record<string, unknown>

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
}

// 阅读快照只保存不可变指针和展示顺序，正文与决定仍从已验证的当前版本读取。
export class ProcessingReadingStore {
  private readonly generated: GeneratedFeedStore
  // 时间线保留完整角色缓存；详情走独立的组关系查询，不触发全库重建。
  private roleProjection?: {
    version: string
    roles: ProcessingEntryRole[]
  }
  constructor(
    private readonly db: DatabaseSync,
    private readonly ownerId: () => string | null,
    private readonly automation: AutomationStore,
    private readonly processingState: ProcessingStateStore,
    private readonly stories: StoryStore,
    private readonly dedupe: ProcessingDedupeStore,
    private readonly processingScope?: () => Pick<
      ProcessingScheduleConfig,
      "sourceKeys" | "historySince"
    > | null,
    private readonly contextStore?: Pick<Store, "sourceSync" | "sources" | "subscriptionTags">,
  ) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS processing_dedupe_decisions_keep_seq
        ON processing_dedupe_decisions(keep_input_seq,config_fingerprint);
      CREATE INDEX IF NOT EXISTS processing_dedupe_decisions_hide_seq
        ON processing_dedupe_decisions(hide_input_seq,config_fingerprint);
      CREATE TABLE IF NOT EXISTS processing_reading_snapshots (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        cutoff_at TEXT NOT NULL,
        max_seq INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS processing_reading_snapshot_members (
        snapshot_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('entry','story')),
        input_seq INTEGER,
        decision_id TEXT,
        release_version INTEGER,
        story_id TEXT,
        story_revision INTEGER,
        entry_status TEXT,
        hidden INTEGER NOT NULL,
        represented INTEGER NOT NULL,
        PRIMARY KEY(snapshot_id, ordinal)
      );
      CREATE INDEX IF NOT EXISTS processing_reading_snapshot_owner
        ON processing_reading_snapshots(owner_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS processing_reading_snapshot_view
        ON processing_reading_snapshot_members(snapshot_id, kind, hidden, represented, ordinal);
      CREATE TABLE IF NOT EXISTS official_collection_entries (
        owner_id TEXT NOT NULL, item_id TEXT NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY(owner_id,item_id)
      );
      CREATE TABLE IF NOT EXISTS official_collection_sync (
        owner_id TEXT PRIMARY KEY, synced_at TEXT NOT NULL
      );
    `)
    this.generated = new GeneratedFeedStore(
      db,
      ownerId,
      stories,
      (query) => this.generatedProjection(query),
      (item) => this.generatedLiveState(item),
    )
    // 早期快照表没有 pending 占位状态；迁移只追加列，不修改已固定成员。
    const columns = new Set(
      db
        .prepare("PRAGMA table_info(processing_reading_snapshot_members)")
        .all()
        .map((row) => String((row as SnapshotRow).name)),
    )
    if (!columns.has("entry_status"))
      db.exec("ALTER TABLE processing_reading_snapshot_members ADD COLUMN entry_status TEXT")
  }

  generatedFeeds() {
    this.requireOwner()
    return { feeds: [generatedEventsFeed] }
  }

  // 私人生成源统计直接读取当前安全投影，不创建阅读快照或把虚拟来源交给官方 API。
  generatedStats() {
    const projection = this.generatedProjection({
      mode: "stories",
      unreadOnly: false,
      collectedOnly: false,
    })
    return {
      feedId: GENERATED_EVENTS_FEED_ID,
      total: projection.items.length,
      unread: projection.items.filter((item) => !item.read).length,
      collected: projection.items.filter((item) => item.collected).length,
    }
  }

  generatedPage(query: GeneratedFeedQuery) {
    this.requireOwner()
    try {
      return this.generated.page(query)
    } catch (error) {
      if (error instanceof Error && error.message === "invalid_generated_cursor")
        throw new ProcessingReadingError("invalid_pagination")
      if (error instanceof Error && error.message === "generated_snapshot_not_found")
        throw new ProcessingReadingError("snapshot_not_found")
      throw error
    }
  }

  // 收藏采集独立保存，不 capture 成 AI 输入，也不触发付费处理或计划范围扩大。
  replaceOfficialCollections(entries: SourceEntry[]) {
    const owner = this.requireOwner()
    this.db.exec("SAVEPOINT official_collections")
    try {
      this.db.prepare("DELETE FROM official_collection_entries WHERE owner_id=?").run(owner)
      const insert = this.db.prepare("INSERT INTO official_collection_entries VALUES(?,?,?)")
      for (const entry of entries) insert.run(owner, entry.id, JSON.stringify(entry))
      this.db
        .prepare("INSERT OR REPLACE INTO official_collection_sync VALUES(?,?)")
        .run(owner, new Date().toISOString())
      this.db.exec("RELEASE official_collections")
    } catch (error) {
      this.db.exec("ROLLBACK TO official_collections; RELEASE official_collections")
      throw error
    }
  }

  officialCollectionsSyncedAt() {
    const row = this.db
      .prepare("SELECT synced_at FROM official_collection_sync WHERE owner_id=?")
      .get(this.requireOwner())
    return row ? String(row.synced_at) : null
  }

  locateGenerated(query: GeneratedFeedQuery, target: { entryId?: string; storyId?: string }) {
    try {
      return this.generated.locate(query, target)
    } catch (error) {
      if (error instanceof Error && error.message === "invalid_generated_cursor")
        throw new ProcessingReadingError("invalid_pagination")
      if (error instanceof Error && error.message === "generated_snapshot_not_found")
        throw new ProcessingReadingError("snapshot_not_found")
      throw error
    }
  }

  generatedEntryState(entryId: string) {
    this.requireOwner()
    const inputs = this.automation
      .inputs()
      .filter(
        (input) =>
          input.current && input.itemId === entryId && this.sourceAvailable(input.sourceKey),
      )
    const input = inputs.sort((left, right) => right.seq - left.seq)[0]
    const published = input
      ? this.processingState.published().find((item) => item.input.seq === input.seq)
      : null
    const role = this.roles().find((item) => item.itemId === entryId)
    const status = !input
      ? "unprocessed"
      : published?.decision.status === "needs_context"
        ? "needs_context"
        : role?.kind === "hidden"
          ? "hidden"
          : published
            ? "ready"
            : input.status === "failed"
              ? "failed"
              : "pending"
    const item = input
      ? this.generatedEntryItem(
          input.body,
          input.seq,
          published?.decisionId ?? null,
          published?.decision,
          role?.storyId ? [role.storyId] : [],
        )
      : null
    return {
      entryId,
      status,
      reason: published?.decision.reason ?? role?.reason ?? null,
      item,
      target:
        status === "ready"
          ? this.locateGenerated(
              { mode: "smart", limit: 30, unreadOnly: false, collectedOnly: false, refresh: true },
              { entryId },
            )
          : null,
    }
  }

  private generatedEntryItem(
    entry: SourceEntry,
    inputSeq: number | null,
    decisionId: string | null,
    decision?: ProcessingDecision,
    storyIds: string[] = [],
  ): GeneratedReaderItem & { kind: "entry" } {
    return {
      kind: "entry",
      origin: "original",
      id: entry.id,
      inputSeq,
      sourceKey: entry.sourceKey,
      decisionId,
      storyIds,
      title: decision?.title ?? entry.title,
      summary: decision?.summary ?? "",
      publishedAt: entry.publishedAt,
      updatedAt: entry.updatedAt ?? entry.publishedAt,
      read: entry.read === true,
      collected: entry.collected === true,
      collectedAt: entry.collectedAt ?? null,
      materialCount: 1,
      topics: decision?.labels ?? [],
      sourceKeys: [entry.sourceKey],
      view: entry.view,
    }
  }

  generatedStoryState(
    storyId: string,
    changes?: { read?: boolean; collected?: boolean; revision?: number },
  ) {
    return this.generated.readerState(storyId, changes)
  }

  // 快照资格只受显式纠错或来源撤回影响；后台模型新决定不能改变已经固定的行。
  private generatedLiveState(item: GeneratedReaderItem) {
    if (item.kind === "story") {
      const revision = this.stories.currentSnapshot(item.storyId)
      const frozen = this.stories.revision(item.storyId, item.revision)
      return {
        allowed: Boolean(
          revision &&
          frozen &&
          this.generatedRevisionSafe(frozen) &&
          item.sourceKeys.every((key) => this.sourceAvailable(key)),
        ),
        restored: false,
        read: item.read,
        collected: item.collected,
      }
    }
    // 用户明确收藏的官方原文保持可见；AI 隐藏、待补和折叠不会撤销收藏意图。
    const collection = this.db
      .prepare("SELECT body FROM official_collection_entries WHERE owner_id=? AND item_id=?")
      .get(this.requireOwner(), item.id)
    if (item.officialCollection) {
      const state = collection ? (JSON.parse(String(collection.body)) as SourceEntry) : null
      return {
        allowed: Boolean(state),
        restored: false,
        read: state?.read === true,
        collected: Boolean(state),
      }
    }
    const override = this.db
      .prepare("SELECT mode FROM processing_source_item_overrides WHERE source_key=? AND item_id=?")
      .get(item.sourceKey, item.id)
    const entry = this.db
      .prepare("SELECT body FROM entries WHERE source_key=? AND id=?")
      .get(item.sourceKey, item.id)
    const state = entry
      ? (JSON.parse(String(entry.body)) as { read?: boolean | null; collected?: boolean | null })
      : { read: item.read, collected: item.collected }
    return {
      allowed:
        this.sourceAvailable(item.sourceKey) &&
        override?.mode !== "hide" &&
        (item.inputSeq === null || !this.stories.isMaterialWithdrawn(item.inputSeq)),
      restored: override?.mode === "restore",
      read: state?.read === true,
      collected: state?.collected === true,
    }
  }

  // 冻结正文也要即时尊重成员撤回、人工移除和原文内容换代。
  private generatedRevisionSafe(revision: StoryRevision) {
    return revision.members.every((member) => {
      const input = this.db
        .prepare("SELECT current FROM processing_inputs WHERE seq=?")
        .get(member.inputSeq)
      const excluded = this.db
        .prepare(
          "SELECT 1 FROM story_member_exclusions WHERE story_id=? AND input_seq=? AND active=1",
        )
        .get(revision.storyId, member.inputSeq)
      return input?.current === 1 && !excluded && !this.stories.isMaterialWithdrawn(member.inputSeq)
    })
  }

  // 原文与 Story 在同一个范围内排序、过滤和折叠，不在浏览器拼接两个分页结果。
  private generatedProjection(query: GeneratedFeedScope): GeneratedReaderProjection {
    const ownerId = this.requireOwner()
    const sources = this.db
      .prepare("SELECT body FROM sources WHERE active=1")
      .all()
      .map((row) => JSON.parse(String(row.body)) as Source)
    const sourceByKey = new Map(sources.map((source) => [source.key, source]))
    const scoped = (sourceKey: string) => {
      if (sourceKey.startsWith("generated:")) return false
      if (query.sourceKeys && !query.sourceKeys.includes(sourceKey)) return false
      if (query.category) {
        const source = sourceByKey.get(sourceKey)
        if (
          !source ||
          (query.category.view !== "all" && source.view !== query.category.view) ||
          source.category !== query.category.name
        )
          return false
      }
      // 固定来源和分类已明确指定范围；仅普通视图从服务端已同步清单动态解析。
      if (!query.sourceKeys && !query.category && typeof query.view === "number") {
        const source = sourceByKey.get(sourceKey)
        if (!source || source.view !== query.view) return false
      }
      return this.sourceAvailable(sourceKey)
    }
    const inputs = this.automation
      .inputs()
      .filter((input) => input.current && scoped(input.sourceKey))
    const published = this.processingState.published().filter((item) => item.input.current)
    const allDecisions = new Map(published.map((item) => [item.input.seq, item]))
    const overrides = new Map(this.processingState.overrides().map((item) => [item.inputSeq, item]))
    const scopedSeqs = new Set(inputs.map((input) => input.seq))
    const storyIdsBySeq = new Map<number, string[]>()
    const storyItems: GeneratedReaderItem[] = []
    const storyMembers = new Map<string, number[]>()
    for (const { story, revision } of this.currentStories(allDecisions)) {
      if (!revision.members.some((member) => scopedSeqs.has(member.inputSeq))) continue
      const members = revision.members.flatMap((member) => {
        const published = allDecisions.get(member.inputSeq)
        return published ? [published] : []
      })
      const status = this.stories.readStatus(story.id, ownerId)
      // 材料数由服务器按原文身份计数，同一原帖跨订阅上下文不会重复计数。
      const materialCount = new Set(members.map((item) => contentIdentity(item.input.body))).size
      const item: GeneratedReaderItem = {
        kind: "story",
        origin: "generated",
        generatedFeedId: GENERATED_EVENTS_FEED_ID,
        id: story.id,
        storyId: story.id,
        revision: revision.revision,
        substantiveRevision: revision.substantiveRevision,
        title: revision.title,
        summary: revision.body,
        publishedAt: story.createdAt,
        updatedAt: story.updatedAt,
        read: !status.unread,
        collected: this.stories.isCollected(story.id, ownerId),
        collectedAt: this.stories.collectedAt(story.id, ownerId),
        hasImportantUpdate: status.unread && status.readSubstantiveRevision > 0,
        materialCount,
        topics: [...new Set(members.flatMap((item) => item.decision.labels))].sort(),
        sourceKeys: [...new Set(members.map((item) => item.input.sourceKey))].sort(),
      }
      for (const member of members)
        storyIdsBySeq.set(member.input.seq, [
          ...(storyIdsBySeq.get(member.input.seq) ?? []),
          story.id,
        ])
      if (matchesGeneratedItem(item, query)) {
        storyItems.push(item)
        storyMembers.set(
          story.id,
          members.map((member) => member.input.seq),
        )
      }
    }
    const ready = inputs.flatMap((input): GeneratedReaderItem[] => {
      const result = allDecisions.get(input.seq)
      if (!result || result.decision.status === "needs_context") return []
      const latestEntry = this.db
        .prepare("SELECT body FROM entries WHERE source_key=? AND id=?")
        .get(input.sourceKey, input.itemId)
      const state = latestEntry
        ? (JSON.parse(String(latestEntry.body)) as {
            read?: boolean | null
            collected?: boolean | null
          })
        : input.body
      const item: GeneratedReaderItem = {
        kind: "entry",
        origin: "original",
        id: input.itemId,
        inputSeq: input.seq,
        sourceKey: input.sourceKey,
        decisionId: result.decisionId,
        title: result.decision.title ?? input.body.title,
        summary: result.decision.summary ?? "",
        publishedAt: input.body.publishedAt,
        updatedAt: input.body.updatedAt ?? input.body.publishedAt,
        read: state.read === true,
        collected: state.collected === true,
        materialCount: 1,
        topics: result.decision.labels,
        sourceKeys: [input.sourceKey],
        storyIds: storyIdsBySeq.get(input.seq) ?? [],
      }
      return matchesGeneratedItem(item, query) ? [item] : []
    })
    const reservoir = [...storyItems, ...ready]
    const visible = ready.filter(
      (item) =>
        item.kind === "entry" &&
        item.inputSeq !== null &&
        !this.entryHidden(overrides.get(item.inputSeq), allDecisions.get(item.inputSeq)?.decision),
    )
    // 单一来源页保留原文与关联；全部和分类只在当前投影已包含 Story 时折叠其成员。
    const preserveSourceEntries = query.sourceKeys?.length === 1 && !query.category
    const represented = new Set(preserveSourceEntries ? [] : [...storyMembers.values()].flat())
    let entries = visible.filter(
      (item) =>
        item.kind === "entry" &&
        item.inputSeq !== null &&
        (!represented.has(item.inputSeq) ||
          overrides.get(item.inputSeq)?.mode === "restore" ||
          allDecisions.get(item.inputSeq)?.decision.policy.standalone === "always"),
    )
    // 普通保留项必须已经可见；已读参考无需单篇发布，但仍须位于当前来源与分类范围。
    if (!preserveSourceEntries) {
      const visibleSeqs = new Set(
        entries.flatMap((item) => (item.kind === "entry" ? [item.inputSeq] : [])),
      )
      const merged = new Set(
        this.currentDedupeMerges()
          .filter(
            (merge) =>
              (visibleSeqs.has(merge.keep.seq) ||
                (merge.keepReference && scopedSeqs.has(merge.keep.seq))) &&
              visibleSeqs.has(merge.hide.seq),
          )
          .map((merge) => merge.hide.seq),
      )
      entries = entries.filter(
        (item) =>
          item.kind !== "entry" ||
          item.inputSeq === null ||
          !merged.has(item.inputSeq) ||
          overrides.get(item.inputSeq)?.mode === "restore" ||
          allDecisions.get(item.inputSeq)?.decision.policy.standalone === "always",
      )
    }
    const compare = (left: GeneratedReaderItem, right: GeneratedReaderItem) =>
      Date.parse(right.publishedAt) - Date.parse(left.publishedAt) ||
      left.kind.localeCompare(right.kind) ||
      left.id.localeCompare(right.id) ||
      left.sourceKeys.join().localeCompare(right.sourceKeys.join())
    // 有阅读筛选时只为解释空列表复算未筛选库存；来源/view/category范围保持一致。
    const inventoryCounts =
      query.search ||
      query.topic ||
      query.unreadOnly ||
      query.collectedOnly ||
      query.since ||
      query.until
        ? this.generatedProjection({
            ...query,
            search: undefined,
            topic: undefined,
            unreadOnly: false,
            collectedOnly: false,
            since: undefined,
            until: undefined,
          }).counts
        : null
    const counts = inventoryCounts ?? {
      inputs: inputs.length,
      uncovered: inputs.filter((input) => input.releaseVersion === null).length,
      hidden: inputs.filter((input) =>
        this.entryHidden(overrides.get(input.seq), allDecisions.get(input.seq)?.decision),
      ).length,
      folded: preserveSourceEntries ? 0 : visible.length - entries.length,
      pending: inputs.filter((input) => ["pending", "running"].includes(input.status)).length,
      failed: inputs.filter((input) => input.status === "failed").length,
      needsContext: inputs.filter(
        (input) => allDecisions.get(input.seq)?.decision.status === "needs_context",
      ).length,
    }
    if (query.mode === "collections") {
      const originals = this.db
        .prepare("SELECT body FROM official_collection_entries WHERE owner_id=?")
        .all(ownerId)
        .map((row) => JSON.parse(String(row.body)) as SourceEntry)
        .filter(
          (entry) =>
            (!query.sourceKeys || query.sourceKeys.includes(entry.sourceKey)) &&
            // 分类自身决定视图范围，全局同名分类不再被外层普通视图重复收窄。
            (query.category || typeof query.view !== "number" || entry.view === query.view) &&
            (!query.category ||
              ((query.category.view === "all" ||
                sourceByKey.get(entry.sourceKey)?.view === query.category.view) &&
                sourceByKey.get(entry.sourceKey)?.category === query.category.name)),
        )
        .map((entry) => {
          const input = inputs.find((input) => input.itemId === entry.id)
          const published = input ? allDecisions.get(input.seq) : null
          return {
            ...this.generatedEntryItem(
              entry,
              input?.seq ?? null,
              published?.decisionId ?? null,
              published?.decision,
              input ? (storyIdsBySeq.get(input.seq) ?? []) : [],
            ),
            officialCollection: true as const,
          }
        })
        .filter((item) => matchesGeneratedItem(item, query))
      // 不折叠显式收藏，即使原文也是某个已收藏 Story 的材料。
      const items = [...storyItems.filter((item) => item.collected), ...originals].sort(
        (left, right) =>
          Date.parse(right.collectedAt ?? right.publishedAt) -
            Date.parse(left.collectedAt ?? left.publishedAt) || compare(left, right),
      )
      return { items, reservoir: items, counts }
    }
    return {
      items: (query.mode === "stories" ? storyItems : [...storyItems, ...entries]).sort(compare),
      reservoir: (query.mode === "stories" ? storyItems : reservoir).sort(compare),
      counts,
    }
  }

  // 首次读取固定一份快照；后续自动读取同一份，只有调用 refresh 才会吸收后台新结果。
  snapshot(): ReadingSnapshot {
    const ownerId = this.requireOwner()
    const row = this.db
      .prepare(
        "SELECT * FROM processing_reading_snapshots WHERE owner_id=? ORDER BY created_at DESC,id DESC LIMIT 1",
      )
      .get(ownerId)
    return row ? this.snapshotFromRow(row as SnapshotRow) : this.refresh()
  }

  refresh(): ReadingSnapshot {
    const ownerId = this.requireOwner()
    const inputsInScope = this.inputsInScope()
    const inputSeqs = new Set(inputsInScope.map((input) => input.seq))
    const published = this.processingState
      .published()
      .filter((item) => inputSeqs.has(item.input.seq))
    const decisions = new Map(
      published
        .filter((published) => this.sourceAvailable(published.input.sourceKey))
        .map((value) => [value.input.seq, value]),
    )
    const publishedBySeq = new Map(published.map((value) => [value.input.seq, value]))
    const overrides = new Map(
      this.processingState.overrides().map((override) => [override.inputSeq, override]),
    )
    const snapshots = this.currentStories(decisions)
    const represented = new Set(
      snapshots.flatMap(({ revision }) => revision.members.map((member) => member.inputSeq)),
    )
    const representedContent = new Set(
      published
        .filter((item) => represented.has(item.input.seq))
        .map((item) => contentIdentity(item.input.body)),
    )
    // 语义去重合成的条目在阅读页同样不单独占位，与时间线角色保持同一口径。
    const semanticallyMerged = new Set(this.currentDedupeMerges().map((merge) => merge.hide.seq))
    const standaloneContent = new Set<string>()
    const members: Array<{
      member: Omit<SnapshotMember, "snapshotId" | "ordinal">
      sortAt: string
      sortSeq: number
    }> = []
    // 智能首页优先保留可读绑定，全部/隐藏视图仍保留每个上下文供核对规则。
    const inputs = [...inputsInScope].sort((left, right) => {
      const rank = (seq: number) => {
        const item = publishedBySeq.get(seq)
        if (overrides.get(seq)?.mode === "restore" || item?.decision.policy.standalone === "always")
          return 0
        return item && item.decision.status !== "hide" ? 1 : item ? 2 : 3
      }
      return rank(left.seq) - rank(right.seq) || right.seq - left.seq
    })
    for (const input of inputs) {
      const published = publishedBySeq.get(input.seq)
      const override = overrides.get(input.seq)
      const hidden = this.entryHidden(override, published?.decision)
      // 手动恢复的条目豁免「并入」：不因综述已覆盖或同内容已有先例而退居幕后。
      const restored = !hidden && override?.mode === "restore"
      const identity = contentIdentity(input.body)
      const duplicate = !hidden && !restored && standaloneContent.has(identity)
      if (!hidden) standaloneContent.add(identity)
      members.push({
        member: {
          kind: "entry",
          inputSeq: input.seq,
          decisionId: published?.decisionId ?? null,
          releaseVersion: input.releaseVersion,
          storyId: null,
          storyRevision: null,
          entryStatus: input.status,
          hidden,
          represented:
            (!restored &&
              published?.decision.policy.standalone !== "always" &&
              (representedContent.has(identity) || semanticallyMerged.has(input.seq))) ||
            duplicate,
        },
        sortAt: input.receivedAt,
        sortSeq: input.seq,
      })
    }
    for (const { story, revision } of snapshots) {
      members.push({
        member: {
          kind: "story",
          inputSeq: null,
          decisionId: null,
          releaseVersion: null,
          storyId: story.id,
          storyRevision: revision.revision,
          entryStatus: null,
          hidden: false,
          represented: true,
        },
        sortAt: revision.createdAt,
        sortSeq: Math.max(...revision.members.map((member) => member.inputSeq)),
      })
    }
    members.sort(
      (left, right) =>
        right.sortAt.localeCompare(left.sortAt) ||
        right.sortSeq - left.sortSeq ||
        left.member.kind.localeCompare(right.member.kind),
    )
    const id = randomUUID()
    const now = new Date().toISOString()
    const maxSeq = Math.max(0, ...inputsInScope.map((input) => input.seq))
    this.db.exec("SAVEPOINT reading_snapshot")
    try {
      this.db
        .prepare("INSERT INTO processing_reading_snapshots VALUES(?,?,?,?,?)")
        .run(id, ownerId, now, maxSeq, now)
      const insert = this.db.prepare(
        `INSERT INTO processing_reading_snapshot_members(
          snapshot_id,ordinal,kind,input_seq,decision_id,release_version,story_id,story_revision,
          entry_status,hidden,represented
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      )
      members.forEach(({ member }, ordinal) =>
        insert.run(
          id,
          ordinal,
          member.kind,
          member.inputSeq,
          member.decisionId,
          member.releaseVersion,
          member.storyId,
          member.storyRevision,
          member.entryStatus,
          Number(member.hidden),
          Number(member.represented),
        ),
      )
      this.db.exec("RELEASE reading_snapshot")
    } catch (error) {
      this.db.exec("ROLLBACK TO reading_snapshot; RELEASE reading_snapshot")
      throw error
    }
    return { id, cutoffAt: now, maxSeq, createdAt: now, latestAvailable: false }
  }

  page(input: {
    snapshotId?: string
    offset?: number
    limit?: number
    view?: ReadingView
  }): ReadingSnapshotPage {
    const offset = input.offset ?? 0
    const limit = input.limit ?? 50
    const view = input.view ?? "smart"
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50
    )
      throw new ProcessingReadingError("invalid_pagination")
    if (
      !["smart", "standalone", "all", "hidden", "pending", "skipped", "failed", "stories"].includes(
        view,
      )
    )
      throw new ProcessingReadingError("invalid_snapshot")
    const snapshot = input.snapshotId ? this.snapshotById(input.snapshotId) : this.snapshot()
    const where = this.viewWhere(view)
    const total = Number(
      this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM processing_reading_snapshot_members WHERE snapshot_id=? AND ${where}`,
        )
        .get(snapshot.id)!.count,
    )
    const rows = this.db
      .prepare(
        `SELECT * FROM processing_reading_snapshot_members WHERE snapshot_id=? AND ${where}
         ORDER BY ordinal LIMIT ? OFFSET ?`,
      )
      .all(snapshot.id, limit, offset)
      .map((row) => this.memberFromRow(row as SnapshotRow))
    return {
      snapshot,
      view,
      offset,
      limit,
      total,
      items: rows.map((row) => this.readMember(row, snapshot)),
    }
  }

  counts(snapshotId?: string): ReadingSnapshotCounts {
    const snapshot = snapshotId ? this.snapshotById(snapshotId) : this.snapshot()
    const count = (where: string) =>
      Number(
        this.db
          .prepare(
            `SELECT COUNT(*) AS count FROM processing_reading_snapshot_members WHERE snapshot_id=? AND ${where}`,
          )
          .get(snapshot.id)!.count,
      )
    // 汇总只读取固定快照成员，刷新前不会被后台新输入或新决定改变。
    return {
      standalone: count(this.viewWhere("standalone")),
      stories: count(this.viewWhere("stories")),
      hidden: count(this.viewWhere("hidden")),
      pending: count(this.viewWhere("pending")),
      skipped: count(this.viewWhere("skipped")),
      failed: count(this.viewWhere("failed")),
    }
  }

  /**
   * 时间线内联综述摘要。判定口径与 `researchPack` 完全一致（同一个 `resolveLink` 与
   * `revisionAvailable`），只是把引用按句子分组，并补上更新时间与来源数。
   */
  storyDigest(storyId: string, requestedRevision?: number): StoryDigest {
    this.requireOwner()
    if (!isUuid(storyId)) throw new ProcessingReadingError("invalid_snapshot")
    const unavailable = (status: "repairing" | "missing"): StoryDigest => ({
      status,
      storyId,
      revision: null,
      title: null,
      body: null,
      updatedAt: null,
      sourceCount: 0,
      sources: [],
      sentences: [],
      uncitedSentenceCount: 0,
    })
    const link = this.stories.resolveLink(storyId)
    if (link.kind === "missing") return unavailable("missing")
    if (link.kind !== "current") return unavailable("repairing")
    // 正文跟随列表冻结版本；材料撤回或输入失效时仍即时拒绝旧版本阅读。
    const revision =
      requestedRevision === undefined
        ? link.revision
        : this.stories.revision(storyId, requestedRevision)
    if (!revision) return unavailable("missing")
    if (!this.generatedRevisionSafe(revision)) return unavailable("repairing")
    if (revision.sourceSpans.some((span) => this.stories.isMaterialWithdrawn(span.inputSeq)))
      return unavailable("repairing")
    const decisionBySeq = new Map(
      this.processingState.published().map((published) => [published.input.seq, published]),
    )
    if (!this.revisionAvailable(revision, decisionBySeq)) return unavailable("repairing")

    const sourceBySeq = new Map<number, StoryDigestSource>()
    for (const span of revision.sourceSpans) {
      if (sourceBySeq.has(span.inputSeq)) continue
      const input = decisionBySeq.get(span.inputSeq)?.input
      if (!input) continue
      sourceBySeq.set(span.inputSeq, {
        inputSeq: input.seq,
        sourceKey: input.sourceKey,
        itemId: input.itemId,
        title: input.body.title,
        url: input.body.url,
      })
    }
    const spanById = new Map(revision.sourceSpans.map((span) => [span.id, span]))
    const sentences = revision.sentences.map((sentence) => ({
      id: sentence.id,
      text: sentence.text,
      citations: sentence.citationIds.flatMap((citationId) => {
        const citation = revision.citations.find((item) => item.id === citationId)
        const span = citation ? spanById.get(citation.sourceSpanId) : undefined
        const input = span ? decisionBySeq.get(span.inputSeq)?.input : undefined
        if (!citation || !span || !input) return []
        return [
          {
            id: citation.id,
            quote: span.quote,
            sourceKey: input.sourceKey,
            sourceTitle: input.body.title,
            sourceUrl: input.body.url,
          },
        ]
      }),
    }))
    return {
      status: "ready",
      storyId,
      revision: revision.revision,
      title: revision.title,
      body: revision.body,
      updatedAt: revision.createdAt,
      sourceCount: new Set(
        [...sourceBySeq.keys()].flatMap((seq) => {
          const input = decisionBySeq.get(seq)?.input
          return input ? [contentIdentity(input.body)] : []
        }),
      ).size,
      sources: [...sourceBySeq.values()],
      sentences,
      uncitedSentenceCount: sentences.filter((sentence) => sentence.citations.length === 0).length,
    }
  }

  researchPack(storyId: string): ResearchPack {
    this.requireOwner()
    if (!isUuid(storyId)) throw new ProcessingReadingError("invalid_snapshot")
    const link = this.stories.resolveLink(storyId)
    if (link.kind === "missing")
      return {
        status: "missing",
        storyId,
        revision: null,
        title: null,
        markdown: null,
        references: [],
      }
    if (link.kind !== "current")
      return {
        status: "repairing",
        storyId,
        revision: null,
        title: null,
        markdown: null,
        references: [],
      }
    const decisionBySeq = new Map(
      this.processingState.published().map((published) => [published.input.seq, published]),
    )
    if (!this.revisionAvailable(link.revision, decisionBySeq))
      return {
        status: "repairing",
        storyId,
        revision: null,
        title: null,
        markdown: null,
        references: [],
      }
    const references = link.revision.sourceSpans.flatMap((span) => {
      const input = decisionBySeq.get(span.inputSeq)?.input
      if (!input) return []
      return [
        {
          inputSeq: input.seq,
          sourceKey: input.sourceKey,
          itemId: input.itemId,
          title: input.body.title,
          url: input.body.url,
          quote: span.quote,
        },
      ]
    })
    const markdown = [
      `# ${link.revision.title}`,
      "",
      link.revision.body,
      "",
      "## 来源",
      ...references.map((reference) =>
        reference.url
          ? `- [${reference.title}](${reference.url})：${reference.quote}`
          : `- ${reference.title}：${reference.quote}`,
      ),
    ].join("\n")
    return {
      status: "ready",
      storyId,
      revision: link.revision.revision,
      title: link.revision.title,
      markdown,
      references,
    }
  }

  /**
   * 时间线角色投影；与阅读快照无关，只共用隐藏判定。
   * 未拿到发布的 input 不产生角色，时间线在服务端给出结论前保持原样。
   */
  roles(): ProcessingEntryRole[] {
    return this.currentRoleProjection().roles.map((role) => ({
      ...role,
      relatedEntryIds: [...role.relatedEntryIds],
      ...(role.relatedEntryPreviews
        ? { relatedEntryPreviews: role.relatedEntryPreviews.map((entry) => ({ ...entry })) }
        : {}),
    }))
  }

  /** 详情按包含关系索引核验本组，不受全库角色缓存或无关后台写入影响。 */
  duplicateRoles(inputSeq: number): ProcessingEntryRole[] {
    if (!this.ownerId()) return []
    const latest = this.automation.releases()[0]
    if (!latest) return []
    const fingerprints = activeDedupeActions(this.automation.release(latest.version)).map(
      (action) => action.fingerprint,
    )
    if (fingerprints.length === 0) return []
    // 双向遍历覆盖包含链、竞争代表和环；UNION 去重保证环不会无限递归。
    const component = this.db
      .prepare(
        `
        WITH RECURSIVE related(seq) AS (
          SELECT ?
          UNION
          SELECT relation.hide_input_seq FROM processing_dedupe_decisions relation
          JOIN related ON relation.keep_input_seq=related.seq
          WHERE relation.config_fingerprint IN (SELECT value FROM json_each(?))
            AND relation.duplicate=1
            AND relation.confidence>=? AND relation.hide_input_seq IS NOT NULL
          UNION
          SELECT relation.keep_input_seq FROM processing_dedupe_decisions relation
          JOIN related ON relation.hide_input_seq=related.seq
          WHERE relation.config_fingerprint IN (SELECT value FROM json_each(?))
            AND relation.duplicate=1
            AND relation.confidence>=? AND relation.keep_input_seq IS NOT NULL
        ) SELECT seq FROM related
      `,
      )
      .all(
        inputSeq,
        JSON.stringify(fingerprints),
        SEMANTIC_DUPLICATE_CONFIDENCE_THRESHOLD,
        JSON.stringify(fingerprints),
        SEMANTIC_DUPLICATE_CONFIDENCE_THRESHOLD,
      )
      .map((row) => Number(row.seq))
    // 综述及同正文转载优先于语义折叠；补齐综述材料指针，复用同一套角色判定。
    // 这里只取成员索引中的原文，不扫描时间线中全部尚未处理的材料。
    const storySeqs = this.db
      .prepare("SELECT DISTINCT input_seq FROM story_current_member_index")
      .all()
      .map((row) => Number(row.input_seq))
    const roles = this.buildRoles(
      this.automation.inputs([...new Set([...component, ...storySeqs])]),
    )
    const keeper = roles.find((role) => role.inputSeq === inputSeq && role.kind === "keeper")
    return keeper
      ? [
          keeper,
          ...roles.filter(
            (role) =>
              role.kind === "merged" &&
              !role.storyId &&
              keeper.relatedEntryIds.includes(role.itemId) &&
              role.relatedEntryIds.includes(keeper.itemId),
          ),
        ]
      : []
  }

  private currentRoleProjection() {
    // total_changes 捕获本连接写入，data_version 捕获其他连接写入，账号也纳入身份。
    const version = JSON.stringify([
      this.ownerId(),
      this.db.prepare("SELECT total_changes() AS count").get()?.count,
      this.db.prepare("PRAGMA data_version").get()?.data_version,
    ])
    if (!this.db.isTransaction && this.roleProjection?.version === version)
      return this.roleProjection
    const roles = this.buildRoles()
    const projection = { version, roles }
    if (!this.db.isTransaction) this.roleProjection = projection
    return projection
  }

  private buildRoles(scopedInputs?: ProcessingInput[]): ProcessingEntryRole[] {
    if (!this.ownerId()) return []

    const inputs = scopedInputs ?? this.automation.inputs()
    const inputSeqs = scopedInputs?.map((input) => input.seq)
    const inputBySeq = new Map(inputs.map((input) => [input.seq, input]))
    const inputByItem = new Map(inputs.map((input) => [input.itemId, input]))
    const sourceTitles = new Map(
      (this.contextStore?.sources() ?? []).map((source) => [source.key, source.title]),
    )
    const publishedBySeq = new Map(
      this.processingState.published(inputSeqs).map((value) => [value.input.seq, value]),
    )
    const overrides = new Map(
      this.processingState.overrides(inputSeqs).map((override) => [override.inputSeq, override]),
    )
    const hiddenBySeq = new Map(
      inputs.map((input) => [
        input.seq,
        this.entryHidden(overrides.get(input.seq), publishedBySeq.get(input.seq)?.decision),
      ]),
    )
    const roles = new Map<number, ProcessingEntryRole>()
    // 显式隐藏优先：它是用户能看见、也能用覆盖改回来的结果。
    for (const input of inputs) {
      const published = publishedBySeq.get(input.seq)
      if (!published || !hiddenBySeq.get(input.seq)) continue
      roles.set(input.seq, {
        itemId: input.itemId,
        inputSeq: input.seq,
        kind: "hidden",
        reason: published.decision.reason,
        relatedEntryIds: [],
        storyId: null,
        storyTitle: null,
      })
    }

    // 每条可用 Story：成员按输入序号排序，最新的一条代表整篇综述。
    type RoleStory = { storyId: string; title: string; memberSeqs: number[] }
    const stories: RoleStory[] = this.currentStories(publishedBySeq)
      .map(({ story, revision }) => ({
        storyId: story.id,
        title: revision.title,
        memberSeqs: revision.members
          .map((member) => member.inputSeq)
          .filter((seq) => inputBySeq.has(seq) && !hiddenBySeq.get(seq))
          .sort((left, right) => left - right),
      }))
      .filter((story) => story.memberSeqs.length > 0)
    const storyByRepresentative = new Map<number, RoleStory>()
    const mergedInto = new Map<number, number>()
    for (const story of stories) {
      const representativeSeq = story.memberSeqs.at(-1)!
      storyByRepresentative.set(representativeSeq, story)
      for (const seq of story.memberSeqs) {
        if (seq !== representativeSeq) mergedInto.set(seq, representativeSeq)
      }
    }

    // 与成员同内容的转载不再单独占位；`always` 例外优先级更高。
    const storyByContent = new Map<string, number>()
    for (const story of stories) {
      const representativeSeq = story.memberSeqs.at(-1)!
      for (const seq of story.memberSeqs) {
        const input = inputBySeq.get(seq)
        if (input) storyByContent.set(contentIdentity(input.body), representativeSeq)
      }
    }
    for (const input of inputs) {
      const published = publishedBySeq.get(input.seq)
      if (!published || published.decision.policy.standalone === "always") continue
      if (roles.has(input.seq) || mergedInto.has(input.seq)) continue
      const representativeSeq = storyByContent.get(contentIdentity(input.body))
      if (representativeSeq === undefined || representativeSeq === input.seq) continue
      mergedInto.set(input.seq, representativeSeq)
    }

    const mergedEntryIds = new Map<number, string[]>()
    for (const [seq, representativeSeq] of mergedInto) {
      const story = storyByRepresentative.get(representativeSeq)!
      roles.set(seq, {
        itemId: inputBySeq.get(seq)!.itemId,
        inputSeq: seq,
        kind: "merged",
        reason: story.title,
        relatedEntryIds: [inputBySeq.get(representativeSeq)!.itemId],
        storyId: story.storyId,
        storyTitle: story.title,
      })
      mergedEntryIds.set(representativeSeq, [
        ...(mergedEntryIds.get(representativeSeq) ?? []),
        inputBySeq.get(seq)!.itemId,
      ])
    }
    for (const [representativeSeq, story] of storyByRepresentative) {
      roles.set(representativeSeq, {
        itemId: inputBySeq.get(representativeSeq)!.itemId,
        inputSeq: representativeSeq,
        kind: "story",
        reason: story.title,
        // 同一原帖可能来自多个来源，条目级去重后再交给角标。
        relatedEntryIds: [...new Set(mergedEntryIds.get(representativeSeq) ?? [])],
        storyId: story.storyId,
        storyTitle: story.title,
      })
    }

    // 语义去重与综述互不覆盖：已有综述角色（成员或代表）的条目不再参与判重合并，
    // 只有两侧都还没有角色、也没有被隐藏的判定才会落地。
    // 先建立隐藏条目到保留条目的有向关系，再解析最终代表；逐条写角色会让包含链依赖判定顺序。
    const directMerges = new Map<number, ReturnType<typeof this.currentDedupeMerges>[number]>()
    const orderedMerges = this.currentDedupeMerges(inputs, publishedBySeq).sort(
      (left, right) =>
        right.confidence - left.confidence ||
        left.keep.seq - right.keep.seq ||
        left.hide.seq - right.hide.seq,
    )
    for (const merge of orderedMerges) {
      const keepSeq = merge.keep.seq
      const hideSeq = merge.hide.seq
      if (hideSeq === keepSeq || directMerges.has(hideSeq)) continue
      if (roles.has(hideSeq) || mergedInto.has(hideSeq)) continue
      if (roles.has(keepSeq) || mergedInto.has(keepSeq)) continue
      if (hiddenBySeq.get(hideSeq) || hiddenBySeq.get(keepSeq)) continue
      if (!inputBySeq.has(hideSeq) || !inputBySeq.has(keepSeq)) continue
      // `always` 是用户显式要求保留的例外，优先级高于语义判定。
      if (publishedBySeq.get(hideSeq)?.decision.policy.standalone === "always") continue
      directMerges.set(hideSeq, merge)
    }
    const keeperMergedIds = new Map<number, string[]>()
    for (const [hideSeq, merge] of directMerges) {
      let keepSeq = merge.keep.seq
      const visited = new Set([hideSeq])
      while (directMerges.has(keepSeq) && !visited.has(keepSeq)) {
        visited.add(keepSeq)
        keepSeq = directMerges.get(keepSeq)!.keep.seq
      }
      // 矛盾判定形成环时没有可见代表，不能把环中所有原文隐藏。
      if (visited.has(keepSeq)) continue
      const hideInput = inputBySeq.get(hideSeq)!
      const keepInput = inputBySeq.get(keepSeq)!
      roles.set(hideSeq, {
        itemId: hideInput.itemId,
        inputSeq: hideSeq,
        kind: "merged",
        reason: merge.reason,
        relatedEntryIds: [keepInput.itemId],
        storyId: null,
        storyTitle: null,
      })
      keeperMergedIds.set(keepSeq, [...(keeperMergedIds.get(keepSeq) ?? []), hideInput.itemId])
    }
    for (const [keepSeq, relatedEntryIds] of keeperMergedIds) {
      const keepInput = inputBySeq.get(keepSeq)
      if (!keepInput) continue
      roles.set(keepSeq, {
        itemId: keepInput.itemId,
        inputSeq: keepSeq,
        kind: "keeper",
        reason: null,
        relatedEntryIds: [...new Set(relatedEntryIds)],
        storyId: null,
        storyTitle: null,
      })
    }

    // 手动恢复最后统一覆盖：restore 覆盖既要豁免隐藏，也要豁免并入（综述成员、同内容转载、
    // 语义去重）。放在这里而不是循环开头，是因为「并入」集合在 Story 与去重两段之后才完整。
    const restoredSeqs = new Set<number>()
    for (const input of inputs) {
      const override = overrides.get(input.seq)
      if (override?.mode !== "restore") continue
      if (!publishedBySeq.has(input.seq)) continue
      const current = roles.get(input.seq)
      // 恢复本身已经让它不再被隐藏，所以「由决定隐藏」的条目在这里不会留下 hidden 角色。
      // 要按「若没有这次恢复会被隐藏」来判定，否则恢复只让条目悄悄回到列表、看不出效果。
      const wouldBeHidden = this.entryHidden(undefined, publishedBySeq.get(input.seq)?.decision)
      if (!current && !wouldBeHidden) continue
      if (current && current.kind !== "hidden" && current.kind !== "merged") continue
      roles.set(input.seq, {
        itemId: input.itemId,
        inputSeq: input.seq,
        kind: "restored",
        reason: null,
        relatedEntryIds: [],
        storyId: null,
        storyTitle: null,
      })
      restoredSeqs.add(input.seq)
    }
    // 恢复后条目不再算作被并入，保留方（综述代表 / 语义去重保留条）的来源计数要同步扣掉它；
    // 综述成员被逐条恢复完时，代表条目退回普通条目，不留一个「综述 · 1」的空壳角标。
    if (restoredSeqs.size > 0) {
      const restoredItemIds = new Set([...restoredSeqs].map((seq) => inputBySeq.get(seq)!.itemId))
      for (const [seq, role] of [...roles]) {
        if (role.kind !== "story" && role.kind !== "keeper") continue
        const relatedEntryIds = role.relatedEntryIds.filter(
          (entryId) => !restoredItemIds.has(entryId),
        )
        if (relatedEntryIds.length === role.relatedEntryIds.length) continue
        // 综述成员被逐条恢复完时，代表条目退回普通条目，不留一个「综述 · 1」的空壳角标。
        if (relatedEntryIds.length === 0 && role.kind === "story") roles.delete(seq)
        else roles.set(seq, { ...role, relatedEntryIds })
      }
    }

    return [...roles.values()]
      .map((role) => ({
        ...role,
        ...(role.kind === "keeper"
          ? {
              relatedEntryPreviews: role.relatedEntryIds.slice(0, 5).flatMap((itemId) => {
                const input = inputByItem.get(itemId)
                return input
                  ? [
                      {
                        itemId,
                        title: input.body.title || null,
                        sourceTitle: sourceTitles.get(input.sourceKey) ?? null,
                        publishedAt: input.body.publishedAt ?? null,
                        url: input.body.url ?? null,
                      },
                    ]
                  : []
              }),
            }
          : {}),
        materialCount: role.storyId
          ? new Set(
              (this.stories.currentSnapshot(role.storyId)?.members ?? []).flatMap((member) => {
                const input = inputBySeq.get(member.inputSeq)
                return input ? [contentIdentity(input.body)] : []
              }),
            ).size
          : role.relatedEntryIds.length + 1,
      }))
      .sort((left, right) => left.inputSeq - right.inputSeq)
  }

  /** 去重与角色复用同一可读 Story 资格，失效、待修复或不可读版本不占用原文。 */
  representedInputSeqs(): ReadonlySet<number> {
    if (!this.ownerId()) return new Set()
    const decisions = new Map(
      this.processingState.published().map((item) => [item.input.seq, item]),
    )
    return new Set(
      this.currentStories(decisions).flatMap(({ revision }) =>
        revision.members.map((member) => member.inputSeq),
      ),
    )
  }

  // 读时核对最新规则的动态适用性和人工恢复；仅静态指纹不足以证明当前上下文仍命中。
  private currentDedupeMerges(
    inputs?: readonly ProcessingInput[],
    decisions?: Map<number, PublishedDecision>,
  ) {
    const latest = this.automation.releases()[0]
    if (!latest) return []
    const actions = activeDedupeActions(this.automation.release(latest.version))
    const inputSeqs = inputs?.map((input) => input.seq)
    const published =
      decisions ??
      new Map(this.processingState.published(inputSeqs).map((item) => [item.input.seq, item]))
    const overrides = new Map(
      this.processingState.overrides(inputSeqs).map((item) => [item.inputSeq, item.mode]),
    )
    const applicable = (seq: number, action: (typeof actions)[number]) => {
      const item = published.get(seq)
      return Boolean(
        item &&
        this.sourceAvailable(item.input.sourceKey) &&
        item.decision.status === "keep" &&
        item.decision.policy.standalone === "auto" &&
        (overrides.get(seq) ?? "automatic") === "automatic" &&
        matchConditions(action.when, item.decision.context).state === "match" &&
        matchConditions(action.scope, item.decision.context).state === "match",
      )
    }
    // 已读参考没有单篇发布结果；只复用存储已验证的包含关系，并按实时缓存重新核对资格。
    // 24 小时限制只控制新比较，已保存关系不会因为参考自然变旧而反复出现。
    const applicableReference = (input: ProcessingInput, action: (typeof actions)[number]) => {
      if (!this.contextStore || !this.sourceAvailable(input.sourceKey)) return false
      if ((overrides.get(input.seq) ?? "automatic") !== "automatic") return false
      if (this.processingState.material(input) !== "complete") return false
      if (this.stories.isMaterialWithdrawn(input.seq)) return false
      const row = this.db
        .prepare("SELECT body FROM entries WHERE source_key=? AND id=?")
        .get(input.sourceKey, input.itemId)
      const entry = row ? (JSON.parse(String(row.body)) as SourceEntry) : null
      if (entry?.read !== true || !entry.title) return false
      if (contentIdentity(entry) !== contentIdentity(input.body)) return false
      if (!dedupeContentEvidence(entry.content).contentComplete) return false
      const text = sourceText(entry.content ?? "")
      if (!text) return false
      const decision = published.get(input.seq)?.decision
      if (decision && (decision.status !== "keep" || decision.policy.standalone !== "auto"))
        return false
      const context = {
        ...processingRuleInput(this.contextStore, input.sourceKey, entry, text, true),
        read: false,
      }
      const instructions = compileInstructions(this.automation.release(latest.version)!, context)
      return (
        !instructions.blocksFinalPresentation &&
        (!instructions.policy.standalone || instructions.policy.standalone === "auto") &&
        matchConditions(action.when, context).state === "match" &&
        matchConditions(action.scope, context).state === "match"
      )
    }
    return actions.flatMap((action) =>
      this.dedupe
        .merges(new Set([action.fingerprint]), inputs)
        .filter(
          (merge) =>
            (merge.keepReference
              ? applicableReference(merge.keep, action)
              : applicable(merge.keep.seq, action)) && applicable(merge.hide.seq, action),
        ),
    )
  }

  private requireOwner(): string {
    const ownerId = this.ownerId()
    if (!ownerId) throw new ProcessingReadingError("owner_required")
    return ownerId
  }

  /**
   * 条目级隐藏判定。快照成员与时间线角色共用，避免两处口径漂移。
   * `always` 是显式例外，优先级高于决定与覆盖；`restore` 豁免隐藏（并入的豁免在 `roles()`
   * 与 `refresh()` 里单独处理，因为并入集合要到 Story 与去重两段跑完才完整）。
   */
  private entryHidden(
    override: { mode: string } | undefined,
    decision: { status: string; policy: PresentationPolicy } | undefined,
  ): boolean {
    return (
      override?.mode === "hide" ||
      (override?.mode !== "restore" &&
        decision?.policy.standalone !== "always" &&
        (decision?.policy.standalone === "never" || decision?.status === "hide"))
    )
  }

  private snapshotById(snapshotId: string): ReadingSnapshot {
    if (!isUuid(snapshotId)) throw new ProcessingReadingError("invalid_snapshot")
    const row = this.db
      .prepare("SELECT * FROM processing_reading_snapshots WHERE id=? AND owner_id=?")
      .get(snapshotId, this.requireOwner())
    if (!row) throw new ProcessingReadingError("snapshot_not_found")
    return this.snapshotFromRow(row as SnapshotRow)
  }

  private snapshotFromRow(row: SnapshotRow): ReadingSnapshot {
    const maxSeq = Number(row.max_seq)
    const latestMaxSeq = Math.max(0, ...this.inputsInScope().map((input) => input.seq))
    return {
      id: String(row.id),
      cutoffAt: String(row.cutoff_at),
      maxSeq,
      createdAt: String(row.created_at),
      latestAvailable:
        latestMaxSeq > maxSeq ||
        this.hasNewerPublishedResult(String(row.id)) ||
        this.hasNewerStory(String(row.id)),
    }
  }

  private hasNewerPublishedResult(snapshotId: string): boolean {
    const captured = new Map(
      this.db
        .prepare(
          "SELECT input_seq,decision_id FROM processing_reading_snapshot_members WHERE snapshot_id=? AND kind='entry'",
        )
        .all(snapshotId)
        .map((row) => [
          Number((row as SnapshotRow).input_seq),
          String((row as SnapshotRow).decision_id),
        ]),
    )
    return this.processingState
      .published()
      .filter((published) => this.inputInScope(published.input))
      .some((published) => captured.get(published.input.seq) !== published.decisionId)
  }

  private hasNewerStory(snapshotId: string): boolean {
    const revisions = new Map(
      this.db
        .prepare(
          "SELECT story_id,story_revision FROM processing_reading_snapshot_members WHERE snapshot_id=? AND kind='story'",
        )
        .all(snapshotId)
        .map((row) => [String(row.story_id), Number(row.story_revision)]),
    )
    const decisions = new Map(
      this.processingState
        .published()
        .filter(
          (published) =>
            this.inputInScope(published.input) && this.sourceAvailable(published.input.sourceKey),
        )
        .map((published) => [published.input.seq, published]),
    )
    return this.currentStories(decisions).some(({ story }) => {
      const revision = revisions.get(story.id)
      return revision === undefined || story.currentRevision > revision
    })
  }

  private inputsInScope() {
    return this.automation.inputs().filter((input) => this.inputInScope(input))
  }

  private inputInScope(input: ReturnType<AutomationStore["inputs"]>[number]) {
    const scope = this.processingScope?.()
    if (!scope) return true
    return (
      scope.sourceKeys.includes(input.sourceKey) &&
      Date.parse(input.body.publishedAt) >= Date.parse(scope.historySince)
    )
  }

  private currentStories(decisions: Map<number, PublishedDecision>) {
    return this.stories.list().flatMap((listed) => {
      const link = this.stories.resolveLink(listed.id)
      if (link.kind !== "current" || !this.revisionAvailable(link.revision, decisions)) return []
      return [{ story: link.story, revision: link.revision }]
    })
  }

  private revisionAvailable(revision: StoryRevision, decisions: Map<number, PublishedDecision>) {
    return revision.members.every((member) => {
      const decision = decisions.get(member.inputSeq)
      return (
        decision?.decisionId === member.decisionId && this.sourceAvailable(decision.input.sourceKey)
      )
    })
  }

  private sourceAvailable(sourceKey: string) {
    if (sourceKey.startsWith("x/search/"))
      return Boolean(
        this.db
          .prepare("SELECT 1 FROM x_saved_queries WHERE id=? AND owner_id=?")
          .get(sourceKey.slice("x/search/".length), this.requireOwner()),
      )
    return Boolean(this.db.prepare("SELECT 1 FROM sources WHERE key=? AND active=1").get(sourceKey))
  }

  private viewWhere(view: ReadingView): string {
    switch (view) {
      case "smart":
        // 智能主列表统一保留已完成的独立项与 Story；待处理和失败通过独立视图查看。
        return "kind='story' OR (kind='entry' AND hidden=0 AND represented=0 AND decision_id IS NOT NULL)"
      case "standalone":
        return "kind='entry' AND hidden=0 AND represented=0"
      case "hidden":
        return "kind='entry' AND hidden=1"
      case "pending":
        // 已读跳过与「还没轮到」是两件事：前者永远不会再消耗额度，混在一起会让用户
        // 误以为队列还在增长。
        return "kind='entry' AND decision_id IS NULL AND COALESCE(entry_status,'') NOT IN ('failed','skipped')"
      case "skipped":
        return "kind='entry' AND entry_status='skipped'"
      case "failed":
        return "kind='entry' AND decision_id IS NULL AND entry_status='failed'"
      case "stories":
        return "kind='story'"
      case "all":
        return "1=1"
    }
  }

  private memberFromRow(row: SnapshotRow): SnapshotMember {
    return {
      snapshotId: String(row.snapshot_id),
      ordinal: Number(row.ordinal),
      kind: String(row.kind) as "entry" | "story",
      inputSeq: row.input_seq === null ? null : Number(row.input_seq),
      decisionId: row.decision_id === null ? null : String(row.decision_id),
      releaseVersion: row.release_version === null ? null : Number(row.release_version),
      storyId: row.story_id === null ? null : String(row.story_id),
      storyRevision: row.story_revision === null ? null : Number(row.story_revision),
      entryStatus: row.entry_status === null ? null : String(row.entry_status),
      hidden: Boolean(row.hidden),
      represented: Boolean(row.represented),
    }
  }

  private readMember(member: SnapshotMember, snapshot: ReadingSnapshot): ReadingSnapshotItem {
    const audit: ReadingSnapshotAudit = {
      cutoffAt: snapshot.cutoffAt,
      maxSeq: snapshot.maxSeq,
      appliedRelease: member.releaseVersion,
      currentDecisionId: member.decisionId,
      storyRevision: member.storyRevision,
    }
    if (member.kind === "entry") {
      const current = this.automation.inputs().find((input) => input.seq === member.inputSeq)
      if (!current || !this.sourceAvailable(current.sourceKey))
        return {
          kind: "entry",
          state: "repairing",
          ordinal: member.ordinal,
          inputSeq: member.inputSeq,
          storyId: null,
          audit,
        }
      // 未完成、失败或没有可验证决定的输入在快照中保持占位，不以晚到结果改写顺序。
      if (!member.decisionId)
        return {
          kind: "entry",
          state: "pending",
          ordinal: member.ordinal,
          inputSeq: current.seq,
          sourceKey: current.sourceKey,
          itemId: current.itemId,
          title: current.body.title,
          url: current.body.url,
          read: current.body.read,
          receivedAt: current.receivedAt,
          status: member.entryStatus ?? "pending",
          decision: null,
          audit,
        }
      const published = this.processingState
        .published()
        .find((candidate) => candidate.input.seq === member.inputSeq)
      if (
        !published ||
        published.decisionId !== member.decisionId ||
        !this.sourceAvailable(published.input.sourceKey)
      )
        return {
          kind: "entry",
          state: "repairing",
          ordinal: member.ordinal,
          inputSeq: member.inputSeq,
          storyId: null,
          audit,
        }
      return this.entryView(member.ordinal, published, audit)
    }
    const story = member.storyId ? this.stories.story(member.storyId) : null
    const revision =
      member.storyId && member.storyRevision
        ? this.stories.revision(member.storyId, member.storyRevision)
        : null
    const decisions = new Map(
      this.processingState.published().map((value) => [value.input.seq, value]),
    )
    if (
      !story ||
      story.status !== "active" ||
      !revision ||
      !this.revisionAvailable(revision, decisions)
    )
      return {
        kind: "story",
        state: "repairing",
        ordinal: member.ordinal,
        inputSeq: null,
        storyId: member.storyId,
        audit,
      }
    return {
      kind: "story",
      state: "ready",
      ordinal: member.ordinal,
      story,
      revision: revision.revision,
      title: revision.title,
      body: revision.body,
      audit,
    }
  }

  private entryView(
    ordinal: number,
    published: PublishedDecision,
    audit: ReadingSnapshotAudit,
  ): ReadingEntry {
    const { input, decisionId, decision } = published
    return {
      kind: "entry",
      state: "ready",
      ordinal,
      inputSeq: input.seq,
      sourceKey: input.sourceKey,
      itemId: input.itemId,
      title: input.body.title,
      url: input.body.url,
      read: input.body.read,
      receivedAt: input.receivedAt,
      decision: {
        id: decisionId,
        status: decision.status,
        title: decision.title,
        summary: decision.summary,
        reason: decision.reason,
        labels: decision.labels,
        policy: decision.policy,
      },
      audit,
    }
  }
}
