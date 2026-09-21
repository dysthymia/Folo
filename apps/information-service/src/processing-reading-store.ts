import { randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"

import type { PresentationPolicy } from "@follow/information-core"

import type { AutomationStore } from "./automation-store"
import { contentIdentity } from "./content-identity"
import type { ProcessingDecision, PublishedDecision } from "./processing-decision"
import type { ProcessingDedupeStore } from "./processing-dedupe"
import { activeDedupeActions } from "./processing-dedupe"
import type { ProcessingScheduleConfig } from "./processing-schedule"
import type { ProcessingStateStore } from "./processing-state"
import type { Story, StoryRevision, StoryStore } from "./story-store"

export type ReadingView =
  "smart" | "standalone" | "all" | "hidden" | "pending" | "failed" | "stories"
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
 * `keeper` 是语义去重里保留了内容的那一条。
 */
export type ProcessingEntryRoleKind = "hidden" | "story" | "merged" | "keeper"
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
  ) {
    db.exec(`
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
    `)
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
    const semanticallyMerged = new Set(
      this.dedupe.merges(this.activeDedupeFingerprints()).map((merge) => merge.hide.seq),
    )
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
      const identity = contentIdentity(input.body)
      const duplicate = !hidden && standaloneContent.has(identity)
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
            (published?.decision.policy.standalone !== "always" &&
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
    if (!["smart", "standalone", "all", "hidden", "pending", "failed", "stories"].includes(view))
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
      pending: count(
        "kind='entry' AND decision_id IS NULL AND COALESCE(entry_status,'')!='failed'",
      ),
      failed: count("kind='entry' AND decision_id IS NULL AND entry_status='failed'"),
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
    if (!this.ownerId()) return []

    const inputs = this.automation.inputs()
    const inputBySeq = new Map(inputs.map((input) => [input.seq, input]))
    const publishedBySeq = new Map(
      this.processingState.published().map((value) => [value.input.seq, value]),
    )
    const overrides = new Map(
      this.processingState.overrides().map((override) => [override.inputSeq, override]),
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
    const fingerprints = this.activeDedupeFingerprints()
    const keeperMergedIds = new Map<number, string[]>()
    for (const merge of this.dedupe.merges(fingerprints)) {
      const keepSeq = merge.keep.seq
      const hideSeq = merge.hide.seq
      if (hideSeq === keepSeq) continue
      if (roles.has(hideSeq) || mergedInto.has(hideSeq)) continue
      if (roles.has(keepSeq) || mergedInto.has(keepSeq)) continue
      if (hiddenBySeq.get(hideSeq) || hiddenBySeq.get(keepSeq)) continue
      const hideInput = inputBySeq.get(hideSeq)
      const keepInput = inputBySeq.get(keepSeq)
      if (!hideInput || !keepInput) continue
      // `always` 是用户显式要求保留的例外，优先级高于语义判定。
      if (publishedBySeq.get(hideSeq)?.decision.policy.standalone === "always") continue
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

    return [...roles.values()].sort((left, right) => left.inputSeq - right.inputSeq)
  }

  /**
   * 当前生效的去重规则指纹。只取最新一次发布：用户删掉 `ai_dedupe` 动作即等于关闭语义
   * 去重，旧判定随后不再参与角色投影。
   */
  private activeDedupeFingerprints(): ReadonlySet<string> {
    const latest = this.automation.releases()[0]
    if (!latest) return new Set()
    const fingerprints = activeDedupeActions(this.automation.release(latest.version)).map(
      (action) => action.fingerprint,
    )
    return new Set(fingerprints)
  }

  private requireOwner(): string {
    const ownerId = this.ownerId()
    if (!ownerId) throw new ProcessingReadingError("owner_required")
    return ownerId
  }

  /**
   * 条目级隐藏判定。快照成员与时间线角色共用，避免两处口径漂移。
   * `always` 是显式例外，优先级高于决定与覆盖；`restore` 只豁免隐藏。
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
        return "kind='entry' AND decision_id IS NULL AND COALESCE(entry_status,'')!='failed'"
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
