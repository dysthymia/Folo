import { randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"

import type { AutomationStore } from "./automation-store"
import { contentIdentity } from "./content-identity"
import type { ProcessingDecision, PublishedDecision } from "./processing-decision"
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
      const hidden =
        override?.mode === "hide" ||
        (override?.mode !== "restore" &&
          published?.decision.policy.standalone !== "always" &&
          (published?.decision.policy.standalone === "never" ||
            published?.decision.status === "hide"))
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
              representedContent.has(identity)) ||
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

  private requireOwner(): string {
    const ownerId = this.ownerId()
    if (!ownerId) throw new ProcessingReadingError("owner_required")
    return ownerId
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
