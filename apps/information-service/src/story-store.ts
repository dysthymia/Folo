import { createHash, randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"

export type StoryStatus = "active" | "merged" | "split" | "repairing"
export type StoryFactKind = "fact" | "source_claim" | "inference"
export type StoryCorrectionKind =
  "member_removed" | "material_withdrawn" | "merged" | "split" | "undo"

export type StoryMemberReference = {
  inputSeq: number
  decisionId: string
}
export type StorySourceSpan = {
  id: string
  inputSeq: number
  sourceItemId: string
  contentVersion: string
  fragmentId: string
  quote: string
  sourceRole: string
}
export type StoryCitation = {
  id: string
  sourceSpanId: string
  sentenceId: string
}
export type StorySentence = {
  id: string
  text: string
  citationIds: string[]
}
export type StoryFact = {
  id: string
  kind: StoryFactKind
  text: string
  citationIds: string[]
  dependsOnFactIds: string[]
}
export type StoryRevisionDraft = {
  title: string
  body: string
  aggregationRuleId: string
  aggregationScopeVersion: string
  appliedRuleSetVersion: number
  instructionFingerprint: string
  members: StoryMemberReference[]
  sourceSpans: StorySourceSpan[]
  citations: StoryCitation[]
  sentences: StorySentence[]
  facts: StoryFact[]
}
export type StoryRevision = StoryRevisionDraft & {
  storyId: string
  revision: number
  substantiveRevision: number
  substantiveContentFingerprint: string
  displayFingerprint: string
  createdAt: string
}
export type Story = {
  id: string
  aggregationRuleId: string
  aggregationScopeVersion: string
  status: StoryStatus
  currentRevision: number
  currentSubstantiveRevision: number
  mergedInto: string | null
  splitInto: string[]
  createdAt: string
  updatedAt: string
}
export type StoryLink =
  | { kind: "current"; story: Story; revision: StoryRevision }
  | { kind: "merged"; story: Story; mergedInto: string }
  | { kind: "split"; story: Story; splitInto: string[]; independentInputSeqs: number[] }
  | { kind: "repairing"; story: Story }
  | { kind: "independent"; story: Story; reason: string }
  | { kind: "missing" }
export type ActiveStory = { story: Story; revision: StoryRevision }
export type RepairingStory = ActiveStory & {
  // 用稳定来源身份寻找新正文版本，不能把旧 inputSeq 当成仍有效材料。
  memberOrigins: Array<{
    inputSeq: number
    sourceKey: string
    itemId: string
    contentVersion: string
  }>
}
export type StoryCorrection = {
  id: string
  kind: StoryCorrectionKind
  storyIds: string[]
  baseRevisions: Record<string, number>
  payload: Record<string, unknown>
  undoOf: string | null
  undoneBy: string | null
  createdAt: string
}

export class StoryStoreError extends Error {
  constructor(
    public readonly code:
      | "revision_conflict"
      | "invalid_story"
      | "invalid_reference"
      | "story_not_found"
      | "story_not_active"
      | "correction_not_found"
      | "correction_already_undone",
  ) {
    super(code)
  }
}

type StoryRow = Record<string, unknown>

// Story 只保存派生阅读对象；原文 read 状态和原文内容仍由既有 Folo 读取链路管理。
export class StoryStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS stories (
        id TEXT PRIMARY KEY,
        aggregation_rule_id TEXT NOT NULL,
        aggregation_scope_version TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active','merged','split','repairing')),
        current_revision INTEGER NOT NULL,
        current_substantive_revision INTEGER NOT NULL,
        merged_into TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS story_revisions (
        story_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        substantive_revision INTEGER NOT NULL,
        substantive_content_fingerprint TEXT NOT NULL,
        display_fingerprint TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(story_id, revision)
      );
      CREATE TABLE IF NOT EXISTS story_corrections (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        story_ids TEXT NOT NULL,
        base_revisions TEXT NOT NULL,
        payload TEXT NOT NULL,
        undo_of TEXT,
        undone_by TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS story_member_exclusions (
        correction_id TEXT NOT NULL,
        story_id TEXT NOT NULL,
        input_seq INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY(correction_id, story_id, input_seq)
      );
      CREATE TABLE IF NOT EXISTS story_aggregation_exclusions (
        correction_id TEXT NOT NULL,
        aggregation_rule_id TEXT NOT NULL,
        aggregation_scope_version TEXT NOT NULL,
        input_seq_a INTEGER NOT NULL,
        input_seq_b INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        CHECK(input_seq_a < input_seq_b),
        PRIMARY KEY(correction_id, input_seq_a, input_seq_b)
      );
      CREATE TABLE IF NOT EXISTS story_material_withdrawals (
        input_seq INTEGER PRIMARY KEY,
        correction_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS story_repair_outcomes (
        story_id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK(status IN ('independent')),
        reason TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS story_read_receipts (
        story_id TEXT NOT NULL,
        reader_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(story_id, reader_id, revision)
      );
      CREATE TABLE IF NOT EXISTS story_current_member_index (
        input_seq INTEGER NOT NULL,
        story_id TEXT NOT NULL,
        PRIMARY KEY(input_seq, story_id)
      );
      CREATE INDEX IF NOT EXISTS story_revisions_current ON story_revisions(story_id, revision DESC);
      CREATE INDEX IF NOT EXISTS story_member_exclusions_lookup ON story_member_exclusions(story_id, input_seq, active);
      CREATE INDEX IF NOT EXISTS story_aggregation_exclusions_lookup ON story_aggregation_exclusions(aggregation_rule_id, aggregation_scope_version, input_seq_a, input_seq_b, active);
      CREATE INDEX IF NOT EXISTS story_current_member_index_story ON story_current_member_index(story_id);
    `)
    this.rebuildCurrentMemberIndex()
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("SAVEPOINT story_write")
    try {
      const value = operation()
      this.db.exec("RELEASE story_write")
      return value
    } catch (error) {
      this.db.exec("ROLLBACK TO story_write; RELEASE story_write")
      throw error
    }
  }

  create(input: StoryRevisionDraft, storyId = randomUUID()): StoryRevision {
    if (!isUuid(storyId)) throw new StoryStoreError("invalid_story")
    return this.transaction(() => {
      if (this.story(storyId)) throw new StoryStoreError("invalid_story")
      this.validateDraft(input)
      const now = new Date().toISOString()
      const revision = this.toRevision(storyId, 1, 1, input, now)
      this.db
        .prepare("INSERT INTO stories VALUES(?,?,?,?,?,?,?,?,?)")
        .run(
          storyId,
          input.aggregationRuleId,
          input.aggregationScopeVersion,
          "active",
          1,
          1,
          null,
          now,
          now,
        )
      this.insertRevision(revision)
      this.replaceCurrentMemberIndex(storyId, revision.members)
      return revision
    })
  }

  // 仅在预期 current revision 仍是当前指针时追加，不会覆写任何历史版本。
  appendRevision(storyId: string, expectedCurrentRevision: number, input: StoryRevisionDraft) {
    return this.transaction(() => {
      const story = this.requireStory(storyId)
      if (story.status !== "active") throw new StoryStoreError("story_not_active")
      if (story.currentRevision !== expectedCurrentRevision)
        throw new StoryStoreError("revision_conflict")
      this.validateDraft(input)
      if (
        story.aggregationRuleId !== input.aggregationRuleId ||
        story.aggregationScopeVersion !== input.aggregationScopeVersion
      )
        throw new StoryStoreError("invalid_story")
      this.assertMembersNotExcluded(storyId, input.members)
      const current = this.requireRevision(storyId, story.currentRevision)
      const substantiveFingerprint = this.substantiveFingerprint(input)
      const substantiveRevision =
        substantiveFingerprint === current.substantiveContentFingerprint
          ? current.substantiveRevision
          : story.currentRevision + 1
      const revision = this.toRevision(
        storyId,
        story.currentRevision + 1,
        substantiveRevision,
        input,
        new Date().toISOString(),
        substantiveFingerprint,
      )
      this.insertRevision(revision)
      this.db
        .prepare(
          "UPDATE stories SET current_revision=?,current_substantive_revision=?,updated_at=? WHERE id=? AND current_revision=?",
        )
        .run(
          revision.revision,
          revision.substantiveRevision,
          revision.createdAt,
          storyId,
          expectedCurrentRevision,
        )
      this.replaceCurrentMemberIndex(storyId, revision.members)
      return revision
    })
  }

  story(storyId: string): Story | null {
    const row = this.db.prepare("SELECT * FROM stories WHERE id=?").get(storyId)
    return row ? this.storyFromRow(row as StoryRow) : null
  }

  list(): Story[] {
    return this.db
      .prepare("SELECT * FROM stories ORDER BY updated_at DESC,id")
      .all()
      .map((row) => this.storyFromRow(row as StoryRow))
  }

  activeStories(aggregationRuleId: string, aggregationScopeVersion: string): ActiveStory[] {
    const ids = this.db
      .prepare(
        "SELECT id FROM stories WHERE aggregation_rule_id=? AND aggregation_scope_version=? AND status='active' ORDER BY id",
      )
      .all(aggregationRuleId, aggregationScopeVersion)
      .map((row) => String((row as StoryRow).id))
    return ids.flatMap((id) => {
      const story = this.story(id)
      const revision = this.currentSnapshot(id)
      return story && revision ? [{ story, revision }] : []
    })
  }

  // repairing 仍保留最后一个不可变 revision 作为重算身份，不向阅读端暴露其旧正文。
  repairQueue(): RepairingStory[] {
    return this.db
      .prepare("SELECT id FROM stories WHERE status='repairing' ORDER BY updated_at,id")
      .all()
      .flatMap((row) => {
        const story = this.story(String((row as StoryRow).id))
        if (!story) return []
        const revision = this.revision(story.id, story.currentRevision)
        if (!revision) return []
        const memberOrigins = revision.members.flatMap((member) => {
          const unavailable = this.db
            .prepare(
              `SELECT 1 FROM story_member_exclusions WHERE story_id=? AND input_seq=? AND active=1
               UNION ALL SELECT 1 FROM story_material_withdrawals WHERE input_seq=? LIMIT 1`,
            )
            .get(story.id, member.inputSeq, member.inputSeq)
          if (unavailable) return []
          const input = this.db
            .prepare("SELECT source_key,item_id,content_version FROM processing_inputs WHERE seq=?")
            .get(member.inputSeq) as StoryRow | undefined
          return input
            ? [
                {
                  inputSeq: member.inputSeq,
                  sourceKey: String(input.source_key),
                  itemId: String(input.item_id),
                  contentVersion: String(input.content_version),
                },
              ]
            : []
        })
        return [{ story, revision, memberOrigins }]
      })
  }

  // 仅 repairing 的原 ID 可恢复；新草稿仍经过成员、原文 span、事实依赖与排除约束校验。
  repair(storyId: string, expectedCurrentRevision: number, input: StoryRevisionDraft) {
    return this.transaction(() => {
      const story = this.requireStory(storyId)
      if (story.status !== "repairing") throw new StoryStoreError("story_not_active")
      if (story.currentRevision !== expectedCurrentRevision)
        throw new StoryStoreError("revision_conflict")
      this.validateDraft(input)
      if (
        story.aggregationRuleId !== input.aggregationRuleId ||
        story.aggregationScopeVersion !== input.aggregationScopeVersion
      )
        throw new StoryStoreError("invalid_story")
      this.assertMembersNotExcluded(storyId, input.members)
      const current = this.requireRevision(storyId, story.currentRevision)
      const substantiveFingerprint = this.substantiveFingerprint(input)
      const substantiveRevision =
        substantiveFingerprint === current.substantiveContentFingerprint
          ? current.substantiveRevision
          : story.currentSubstantiveRevision + 1
      const revision = this.toRevision(
        storyId,
        story.currentRevision + 1,
        substantiveRevision,
        input,
        new Date().toISOString(),
        substantiveFingerprint,
      )
      this.insertRevision(revision)
      this.db
        .prepare(
          "UPDATE stories SET status='active',current_revision=?,current_substantive_revision=?,updated_at=? WHERE id=? AND status='repairing' AND current_revision=?",
        )
        .run(
          revision.revision,
          revision.substantiveRevision,
          revision.createdAt,
          storyId,
          expectedCurrentRevision,
        )
      this.db.prepare("DELETE FROM story_repair_outcomes WHERE story_id=?").run(storyId)
      this.replaceCurrentMemberIndex(storyId, revision.members)
      return revision
    })
  }

  // 剩余材料不足两个来源时不伪造 Story；原链接明确指向独立阅读入口，后续新材料仍可再次修复。
  deferRepairAsIndependent(storyId: string, expectedCurrentRevision: number, reason: string) {
    return this.transaction(() => {
      const story = this.requireStory(storyId)
      if (story.status !== "repairing" || story.currentRevision !== expectedCurrentRevision)
        throw new StoryStoreError("revision_conflict")
      if (!reason.trim()) throw new StoryStoreError("invalid_story")
      this.db
        .prepare(
          "INSERT INTO story_repair_outcomes VALUES(?,?,?,?) ON CONFLICT(story_id) DO UPDATE SET status=excluded.status,reason=excluded.reason,updated_at=excluded.updated_at",
        )
        .run(storyId, "independent", reason, new Date().toISOString())
      return this.resolveLink(storyId)
    })
  }

  revision(storyId: string, revision: number): StoryRevision | null {
    const row = this.db
      .prepare("SELECT * FROM story_revisions WHERE story_id=? AND revision=?")
      .get(storyId, revision)
    return row ? this.revisionFromRow(row as StoryRow) : null
  }

  currentSnapshot(storyId: string): StoryRevision | null {
    const story = this.story(storyId)
    if (!story || story.status !== "active") return null
    const revision = this.requireRevision(story.id, story.currentRevision)
    if (this.revisionIsCurrent(revision)) return revision
    // 输入版本或决策代际已失效时，不能继续把旧派生正文作为当前阅读快照。
    this.transaction(() => this.markRepairing([storyId]))
    return null
  }

  resolveLink(storyId: string): StoryLink {
    const story = this.story(storyId)
    if (!story) return { kind: "missing" }
    if (story.status === "active") {
      const revision = this.currentSnapshot(storyId)
      const current = this.requireStory(storyId)
      if (revision) return { kind: "current", story: current, revision }
      return { kind: "repairing", story: current }
    }
    if (story.status === "merged") return { kind: "merged", story, mergedInto: story.mergedInto! }
    if (story.status === "split")
      return {
        kind: "split",
        story,
        splitInto: story.splitInto,
        independentInputSeqs: this.splitPayload(storyId)?.independentInputSeqs ?? [],
      }
    if (story.status === "repairing") {
      const outcome = this.db
        .prepare("SELECT reason FROM story_repair_outcomes WHERE story_id=?")
        .get(storyId) as StoryRow | undefined
      if (outcome) return { kind: "independent", story, reason: String(outcome.reason) }
    }
    return { kind: "repairing", story }
  }

  markRead(storyId: string, readerId: string, revision?: number) {
    if (!readerId.trim()) throw new StoryStoreError("invalid_story")
    const story = this.requireStory(storyId)
    const targetRevision = revision ?? story.currentRevision
    this.requireRevision(storyId, targetRevision)
    this.db
      .prepare("INSERT OR IGNORE INTO story_read_receipts VALUES(?,?,?,?)")
      .run(storyId, readerId, targetRevision, new Date().toISOString())
  }

  readStatus(storyId: string, readerId: string) {
    const story = this.requireStory(storyId)
    const row = this.db
      .prepare(
        `SELECT MAX(revisions.substantive_revision) AS read_substantive_revision
         FROM story_read_receipts receipts
         JOIN story_revisions revisions ON revisions.story_id=receipts.story_id AND revisions.revision=receipts.revision
         WHERE receipts.story_id=? AND receipts.reader_id=?`,
      )
      .get(storyId, readerId) as StoryRow | undefined
    const readSubstantiveRevision = Number(row?.read_substantive_revision ?? 0)
    return {
      readSubstantiveRevision,
      unread: readSubstantiveRevision < story.currentSubstantiveRevision,
    }
  }

  removeMember(storyId: string, expectedCurrentRevision: number, inputSeq: number) {
    return this.transaction(() => {
      const story = this.requireCurrent(storyId, expectedCurrentRevision)
      const revision = this.requireRevision(storyId, story.currentRevision)
      if (!revision.members.some((member) => member.inputSeq === inputSeq))
        throw new StoryStoreError("invalid_reference")
      const correction = this.insertCorrection(
        "member_removed",
        [storyId],
        { [storyId]: story.currentRevision },
        { inputSeq },
      )
      this.db
        .prepare(
          "INSERT INTO story_member_exclusions(correction_id,story_id,input_seq) VALUES(?,?,?)",
        )
        .run(correction.id, storyId, inputSeq)
      this.markRepairing([storyId])
      return correction
    })
  }

  // 撤回资格立即移除所有当前快照；正文与引用只能由后续 worker 重建后再次发布。
  withdrawMaterial(inputSeq: number, reason: string) {
    if (!positiveInteger(inputSeq) || !reason.trim()) throw new StoryStoreError("invalid_reference")
    return this.transaction(() => {
      const existing = this.db
        .prepare("SELECT correction_id FROM story_material_withdrawals WHERE input_seq=?")
        .get(inputSeq) as StoryRow | undefined
      if (existing) return this.correction(String(existing.correction_id))!
      const affected = this.currentStoryIdsForInputs([inputSeq])
      const baseRevisions = Object.fromEntries(
        affected.map((storyId) => [storyId, this.requireStory(storyId).currentRevision]),
      )
      const correction = this.insertCorrection(
        "material_withdrawn",
        Object.keys(baseRevisions),
        baseRevisions,
        { inputSeq, reason },
      )
      this.db
        .prepare("INSERT INTO story_material_withdrawals VALUES(?,?,?,?)")
        .run(inputSeq, correction.id, reason, correction.createdAt)
      this.markRepairing(Object.keys(baseRevisions))
      return correction
    })
  }

  merge(input: {
    keepStoryId: string
    mergeStoryId: string
    expectedKeepRevision: number
    expectedMergedRevision: number
    revision: StoryRevisionDraft
  }) {
    return this.transaction(() => {
      if (input.keepStoryId === input.mergeStoryId) throw new StoryStoreError("invalid_story")
      const kept = this.requireCurrent(input.keepStoryId, input.expectedKeepRevision)
      const merged = this.requireCurrent(input.mergeStoryId, input.expectedMergedRevision)
      if (
        kept.aggregationRuleId !== merged.aggregationRuleId ||
        kept.aggregationScopeVersion !== merged.aggregationScopeVersion
      )
        throw new StoryStoreError("invalid_story")
      const expectedMembers = [
        ...this.requireRevision(kept.id, kept.currentRevision).members,
        ...this.requireRevision(merged.id, merged.currentRevision).members,
      ].map((member) => member.inputSeq)
      if (
        !expectedMembers.every((inputSeq) =>
          input.revision.members.some((member) => member.inputSeq === inputSeq),
        )
      )
        throw new StoryStoreError("invalid_reference")
      const revision = this.appendRevision(kept.id, kept.currentRevision, input.revision)
      const correction = this.insertCorrection(
        "merged",
        [kept.id, merged.id],
        { [kept.id]: kept.currentRevision, [merged.id]: merged.currentRevision },
        { keptRevision: revision.revision },
      )
      this.db
        .prepare(
          "UPDATE stories SET status='merged',merged_into=?,updated_at=? WHERE id=? AND status='active' AND current_revision=?",
        )
        .run(kept.id, revision.createdAt, merged.id, input.expectedMergedRevision)
      this.clearCurrentMemberIndex(merged.id)
      return { correction, revision }
    })
  }

  split(input: {
    storyId: string
    expectedCurrentRevision: number
    children: Array<{ storyId?: string; revision: StoryRevisionDraft }>
    independentInputSeqs?: number[]
  }) {
    return this.transaction(() => {
      const parent = this.requireCurrent(input.storyId, input.expectedCurrentRevision)
      const independentInputSeqs = uniqueIds(input.independentInputSeqs ?? [])
      // 允许全部成员恢复独立阅读；无需制造至少一个子 Story。
      if (input.children.length + independentInputSeqs.length < 2)
        throw new StoryStoreError("invalid_story")
      const parentMembers = new Set(
        this.requireRevision(parent.id, parent.currentRevision).members.map(
          (member) => member.inputSeq,
        ),
      )
      const childIds: string[] = []
      const childMemberSets: number[][] = []
      for (const child of input.children) {
        const childId = child.storyId ?? randomUUID()
        if (!isUuid(childId) || this.story(childId)) throw new StoryStoreError("invalid_story")
        this.validateDraft(child.revision)
        if (
          child.revision.aggregationRuleId !== parent.aggregationRuleId ||
          child.revision.aggregationScopeVersion !== parent.aggregationScopeVersion
        )
          throw new StoryStoreError("invalid_story")
        const memberIds = child.revision.members.map((member) => member.inputSeq)
        if (!memberIds.every((memberId) => parentMembers.has(memberId)))
          throw new StoryStoreError("invalid_reference")
        childIds.push(childId)
        childMemberSets.push(memberIds)
      }
      const flattened = childMemberSets.flat()
      const assigned = [...flattened, ...independentInputSeqs]
      if (
        new Set(assigned).size !== assigned.length ||
        assigned.length !== parentMembers.size ||
        assigned.some((inputSeq) => !parentMembers.has(inputSeq))
      )
        throw new StoryStoreError("invalid_story")
      const correction = this.insertCorrection(
        "split",
        [parent.id, ...childIds],
        { [parent.id]: parent.currentRevision },
        { childIds, independentInputSeqs },
      )
      const now = new Date().toISOString()
      for (let index = 0; index < input.children.length; index++) {
        const child = input.children[index]!
        const revision = this.toRevision(childIds[index]!, 1, 1, child.revision, now)
        this.db
          .prepare("INSERT INTO stories VALUES(?,?,?,?,?,?,?,?,?)")
          .run(
            revision.storyId,
            child.revision.aggregationRuleId,
            child.revision.aggregationScopeVersion,
            "active",
            1,
            1,
            null,
            now,
            now,
          )
        this.insertRevision(revision)
        this.replaceCurrentMemberIndex(revision.storyId, revision.members)
      }
      // 独立条目也是拆分分区，保存跨分区约束，避免下一轮又被自动拼回。
      const partitions = [...childMemberSets, ...independentInputSeqs.map((inputSeq) => [inputSeq])]
      for (let left = 0; left < partitions.length; left++)
        for (let right = left + 1; right < partitions.length; right++)
          for (const inputSeqA of partitions[left]!)
            for (const inputSeqB of partitions[right]!) {
              const inputSeqAOrdered = Math.min(inputSeqA, inputSeqB)
              const inputSeqBOrdered = Math.max(inputSeqA, inputSeqB)
              this.db
                .prepare("INSERT INTO story_aggregation_exclusions VALUES(?,?,?,?,?,1)")
                .run(
                  correction.id,
                  parent.aggregationRuleId,
                  parent.aggregationScopeVersion,
                  inputSeqAOrdered,
                  inputSeqBOrdered,
                )
            }
      this.db
        .prepare("UPDATE stories SET status='split',updated_at=? WHERE id=? AND current_revision=?")
        .run(now, parent.id, parent.currentRevision)
      this.clearCurrentMemberIndex(parent.id)
      return { correction, childIds, independentInputSeqs }
    })
  }

  canAggregate(aggregationRuleId: string, aggregationScopeVersion: string, inputSeqs: number[]) {
    const ids = [...new Set(inputSeqs)].sort((left, right) => left - right)
    if (ids.some((id) => !positiveInteger(id))) return false
    for (let left = 0; left < ids.length; left++)
      for (let right = left + 1; right < ids.length; right++) {
        const inputSeqA = ids[left]!
        const inputSeqB = ids[right]!
        const excluded = this.db
          .prepare(
            `SELECT 1 FROM story_aggregation_exclusions
             WHERE aggregation_rule_id=? AND aggregation_scope_version=? AND input_seq_a=? AND input_seq_b=? AND active=1`,
          )
          .get(aggregationRuleId, aggregationScopeVersion, inputSeqA, inputSeqB)
        if (excluded) return false
      }
    return true
  }

  isMaterialWithdrawn(inputSeq: number) {
    if (!positiveInteger(inputSeq)) return false
    return Boolean(
      this.db.prepare("SELECT 1 FROM story_material_withdrawals WHERE input_seq=?").get(inputSeq),
    )
  }

  // 标签、规则或输入版本变化由 worker 调用；这里只原子失效快照，不触发模型或建立永久排除。
  invalidateInputs(inputSeqs: number[]) {
    const invalidated = new Set(inputSeqs.filter(positiveInteger))
    if (invalidated.size === 0) return []
    return this.transaction(() => {
      // 批量失效只查当前成员索引；历史 revision 不会意外进入修复队列。
      const affected = this.currentStoryIdsForInputs([...invalidated])
      this.markRepairing(affected)
      return affected.sort()
    })
  }

  undoCorrection(correctionId: string) {
    return this.transaction(() => {
      const original = this.correction(correctionId)
      if (!original) throw new StoryStoreError("correction_not_found")
      if (original.undoneBy) throw new StoryStoreError("correction_already_undone")
      const topology =
        original.kind === "merged"
          ? this.undoMergeTopology(original)
          : original.kind === "split"
            ? this.undoSplitTopology(original)
            : null
      const undo = this.insertCorrection(
        "undo",
        original.storyIds,
        topology?.baseRevisions ?? original.baseRevisions,
        {
          undoOf: original.id,
          ...(topology ? { restoredRevisions: topology.restoredRevisions } : {}),
        },
        original.id,
      )
      this.db
        .prepare("UPDATE story_corrections SET undone_by=? WHERE id=?")
        .run(undo.id, original.id)
      // 取消个人限制只允许下一轮在当前资格下重新判断，绝不把旧成员或旧正文直接复活。
      this.db
        .prepare(
          `UPDATE story_member_exclusions SET active=0 WHERE correction_id=?
           AND NOT EXISTS (SELECT 1 FROM story_material_withdrawals withdrawals WHERE withdrawals.input_seq=story_member_exclusions.input_seq)`,
        )
        .run(original.id)
      this.db
        .prepare("UPDATE story_aggregation_exclusions SET active=0 WHERE correction_id=?")
        .run(original.id)
      // 合并／拆分的逆向操作已经生成新的不可变 revision；其他纠正仍交给修复队列重算。
      if (!topology) this.markRepairing(original.storyIds)
      return undo
    })
  }

  correction(correctionId: string): StoryCorrection | null {
    const row = this.db.prepare("SELECT * FROM story_corrections WHERE id=?").get(correctionId)
    if (!row) return null
    return this.correctionFromRow(row as StoryRow)
  }

  private undoMergeTopology(original: StoryCorrection) {
    const keptRevision = original.payload.keptRevision
    const topology = original.storyIds.map((id) => this.requireStory(id))
    const merged = topology.find((story) => story.status === "merged")
    const kept = merged ? topology.find((story) => story.id === merged.mergedInto) : undefined
    const keepStoryId = kept?.id
    const mergedStoryId = merged?.id
    const keepBaseRevision = keepStoryId ? original.baseRevisions[keepStoryId] : undefined
    const mergedBaseRevision = mergedStoryId ? original.baseRevisions[mergedStoryId] : undefined
    if (
      !keepStoryId ||
      !mergedStoryId ||
      !kept ||
      !merged ||
      !positiveInteger(keptRevision) ||
      !positiveInteger(keepBaseRevision) ||
      !positiveInteger(mergedBaseRevision)
    )
      throw new StoryStoreError("invalid_story")

    // 纠正后的拓扑或 revision 已变化时拒绝撤销，避免覆盖后续人工操作或后台更新。
    if (
      kept.status !== "active" ||
      kept.currentRevision !== keptRevision ||
      merged.status !== "merged" ||
      merged.currentRevision !== mergedBaseRevision ||
      merged.mergedInto !== keepStoryId
    )
      throw new StoryStoreError("revision_conflict")

    const keepRestored = this.restoreRevision(keepStoryId, keptRevision, keepBaseRevision, "active")
    const mergedRestored = this.restoreRevision(
      mergedStoryId,
      mergedBaseRevision,
      mergedBaseRevision,
      "merged",
    )
    return {
      baseRevisions: { [keepStoryId]: keptRevision, [mergedStoryId]: mergedBaseRevision },
      restoredRevisions: {
        [keepStoryId]: keepRestored.revision,
        [mergedStoryId]: mergedRestored.revision,
      },
    }
  }

  private undoSplitTopology(original: StoryCorrection) {
    const childIds = Array.isArray(original.payload.childIds)
      ? original.payload.childIds.filter((id): id is string => typeof id === "string" && isUuid(id))
      : []
    const childIdSet = new Set(childIds)
    const parentIds = original.storyIds.filter((id) => !childIdSet.has(id))
    const parentStoryId = parentIds.length === 1 ? parentIds[0] : undefined
    const parentBaseRevision = parentStoryId ? original.baseRevisions[parentStoryId] : undefined
    const independentInputSeqs = Array.isArray(original.payload.independentInputSeqs)
      ? original.payload.independentInputSeqs.filter(positiveInteger)
      : []
    if (
      !parentStoryId ||
      !positiveInteger(parentBaseRevision) ||
      childIds.length + independentInputSeqs.length < 2 ||
      childIds.length !== original.storyIds.length - 1 ||
      childIds.some((id) => !original.storyIds.includes(id))
    )
      throw new StoryStoreError("invalid_story")

    const parent = this.requireStory(parentStoryId)
    const children = childIds.map((id) => this.requireStory(id))
    if (
      parent.status !== "split" ||
      parent.currentRevision !== parentBaseRevision ||
      parent.splitInto.some((id, index) => id !== childIds[index]) ||
      parent.splitInto.length !== childIds.length ||
      children.some((child) => child.status !== "active" || child.currentRevision !== 1)
    )
      throw new StoryStoreError("revision_conflict")

    // 先在同一事务内解除本次拆分的跨组约束，随后才能按原成员重建父 Story。
    this.db
      .prepare("UPDATE story_aggregation_exclusions SET active=0 WHERE correction_id=?")
      .run(original.id)
    const parentRestored = this.restoreRevision(
      parentStoryId,
      parentBaseRevision,
      parentBaseRevision,
      "split",
    )
    const now = parentRestored.createdAt
    for (const child of children) {
      const result = this.db
        .prepare(
          "UPDATE stories SET status='merged',merged_into=?,updated_at=? WHERE id=? AND status='active' AND current_revision=1",
        )
        .run(parentStoryId, now, child.id)
      if (result.changes !== 1) throw new StoryStoreError("revision_conflict")
      this.clearCurrentMemberIndex(child.id)
    }
    return {
      baseRevisions: Object.fromEntries([
        [parentStoryId, parentBaseRevision],
        ...children.map((child) => [child.id, child.currentRevision] as const),
      ]),
      restoredRevisions: { [parentStoryId]: parentRestored.revision },
    }
  }

  private restoreRevision(
    storyId: string,
    expectedCurrentRevision: number,
    sourceRevision: number,
    expectedStatus: StoryStatus,
  ) {
    const draft = revisionDraft(this.requireRevision(storyId, sourceRevision))
    // 旧 revision 只作为恢复意图；当前材料、决策、撤回和排除资格仍走完整校验。
    this.validateDraft(draft)
    const result = this.db
      .prepare(
        "UPDATE stories SET status='active',merged_into=NULL,updated_at=? WHERE id=? AND status=? AND current_revision=?",
      )
      .run(new Date().toISOString(), storyId, expectedStatus, expectedCurrentRevision)
    if (result.changes !== 1) throw new StoryStoreError("revision_conflict")
    return this.appendRevision(storyId, expectedCurrentRevision, draft)
  }

  private validateDraft(input: StoryRevisionDraft) {
    if (
      !input.title.trim() ||
      !input.body.trim() ||
      !input.aggregationRuleId.trim() ||
      !input.aggregationScopeVersion.trim() ||
      !input.instructionFingerprint.trim() ||
      !positiveInteger(input.appliedRuleSetVersion) ||
      input.members.length < 2
    )
      throw new StoryStoreError("invalid_story")
    const memberIds = uniqueIds(input.members.map((member) => member.inputSeq))
    if (
      memberIds.length !== input.members.length ||
      input.members.some((member) => !member.decisionId.trim())
    )
      throw new StoryStoreError("invalid_reference")
    for (const member of input.members) this.validateMember(member)
    if (!this.canAggregate(input.aggregationRuleId, input.aggregationScopeVersion, memberIds))
      throw new StoryStoreError("invalid_reference")
    const spanIds = uniqueIds(input.sourceSpans.map((span) => span.id))
    const citationIds = uniqueIds(input.citations.map((citation) => citation.id))
    const sentenceIds = uniqueIds(input.sentences.map((sentence) => sentence.id))
    const factIds = uniqueIds(input.facts.map((fact) => fact.id))
    if (
      spanIds.length !== input.sourceSpans.length ||
      citationIds.length !== input.citations.length ||
      sentenceIds.length !== input.sentences.length ||
      factIds.length !== input.facts.length
    )
      throw new StoryStoreError("invalid_reference")
    const memberSet = new Set(memberIds)
    for (const span of input.sourceSpans) {
      if (
        !span.id.trim() ||
        !memberSet.has(span.inputSeq) ||
        !span.sourceItemId.trim() ||
        !span.contentVersion.trim() ||
        !span.fragmentId.trim() ||
        !span.quote.trim() ||
        !span.sourceRole.trim()
      )
        throw new StoryStoreError("invalid_reference")
      this.validateSpan(span)
    }
    const spanSet = new Set(spanIds)
    const sentenceSet = new Set(sentenceIds)
    for (const citation of input.citations)
      if (
        !citation.id.trim() ||
        !spanSet.has(citation.sourceSpanId) ||
        !sentenceSet.has(citation.sentenceId)
      )
        throw new StoryStoreError("invalid_reference")
    const citationSet = new Set(citationIds)
    for (const sentence of input.sentences)
      if (
        !sentence.id.trim() ||
        !sentence.text.trim() ||
        !everyUniqueKnown(sentence.citationIds, citationSet)
      )
        throw new StoryStoreError("invalid_reference")
    if (
      input.citations.some(
        (citation) =>
          !input.sentences
            .find((sentence) => sentence.id === citation.sentenceId)!
            .citationIds.includes(citation.id),
      )
    )
      throw new StoryStoreError("invalid_reference")
    const factSet = new Set(factIds)
    for (const fact of input.facts) {
      if (
        !fact.id.trim() ||
        !fact.text.trim() ||
        !["fact", "source_claim", "inference"].includes(fact.kind) ||
        !everyUniqueKnown(fact.citationIds, citationSet) ||
        fact.citationIds.length === 0 ||
        uniqueIds(fact.dependsOnFactIds).length !== fact.dependsOnFactIds.length ||
        !fact.dependsOnFactIds.every((id) => factSet.has(id)) ||
        fact.dependsOnFactIds.includes(fact.id) ||
        (fact.kind === "inference" && fact.dependsOnFactIds.length === 0)
      )
        throw new StoryStoreError("invalid_reference")
    }
    if (hasFactDependencyCycle(input.facts)) throw new StoryStoreError("invalid_reference")
  }

  private validateMember(member: StoryMemberReference) {
    if (!positiveInteger(member.inputSeq)) throw new StoryStoreError("invalid_reference")
    if (!this.memberIsCurrent(member)) throw new StoryStoreError("invalid_reference")
    const withdrawn = this.db
      .prepare("SELECT 1 FROM story_material_withdrawals WHERE input_seq=?")
      .get(member.inputSeq)
    if (withdrawn) throw new StoryStoreError("invalid_reference")
  }

  private memberIsCurrent(member: StoryMemberReference) {
    const row = this.db
      .prepare(
        `SELECT inputs.seq
         FROM processing_inputs AS inputs
         JOIN entry_decisions AS decisions
           ON decisions.id=inputs.decision_id
          AND decisions.id=?
          AND decisions.input_seq=inputs.seq
          AND decisions.generation=inputs.generation
          AND decisions.release_version=inputs.release_version
         WHERE inputs.seq=? AND inputs.current=1 AND inputs.status='succeeded'`,
      )
      .get(member.decisionId, member.inputSeq)
    return Boolean(row)
  }

  private validateSpan(span: StorySourceSpan) {
    const row = this.db
      .prepare(
        "SELECT body FROM processing_inputs WHERE seq=? AND item_id=? AND content_version=? AND current=1",
      )
      .get(span.inputSeq, span.sourceItemId, span.contentVersion) as StoryRow | undefined
    if (!row || !this.spanMatchesPersistedSource(span, String(row.body)))
      throw new StoryStoreError("invalid_reference")
  }

  private revisionIsCurrent(revision: StoryRevision) {
    return (
      revision.members.every((member) => this.memberIsCurrent(member)) &&
      revision.sourceSpans.every((span) => {
        const row = this.db
          .prepare(
            "SELECT body FROM processing_inputs WHERE seq=? AND item_id=? AND content_version=? AND current=1",
          )
          .get(span.inputSeq, span.sourceItemId, span.contentVersion) as StoryRow | undefined
        return Boolean(row && this.spanMatchesPersistedSource(span, String(row.body)))
      })
    )
  }

  private spanMatchesPersistedSource(span: StorySourceSpan, body: string) {
    const original = sourceTextFromInputBody(body)
    return (
      original !== null &&
      normalized(original).includes(normalized(span.quote)) &&
      span.fragmentId === sourceSpanFragmentId(span.sourceItemId, span.contentVersion, span.quote)
    )
  }

  private assertMembersNotExcluded(storyId: string, members: StoryMemberReference[]) {
    for (const member of members) {
      const excluded = this.db
        .prepare(
          "SELECT 1 FROM story_member_exclusions WHERE story_id=? AND input_seq=? AND active=1",
        )
        .get(storyId, member.inputSeq)
      if (excluded) throw new StoryStoreError("invalid_reference")
    }
  }

  private toRevision(
    storyId: string,
    revision: number,
    substantiveRevision: number,
    input: StoryRevisionDraft,
    createdAt: string,
    substantiveContentFingerprint = this.substantiveFingerprint(input),
  ): StoryRevision {
    return {
      ...clone(input),
      storyId,
      revision,
      substantiveRevision,
      substantiveContentFingerprint,
      displayFingerprint: fingerprint(input),
      createdAt,
    }
  }

  private substantiveFingerprint(input: StoryRevisionDraft) {
    // 排版和措辞微调不制造未读；事实、支持片段、成员或规则输入改变才视为实质更新。
    return fingerprint({
      title: normalized(input.title),
      aggregationRuleId: input.aggregationRuleId,
      aggregationScopeVersion: input.aggregationScopeVersion,
      appliedRuleSetVersion: input.appliedRuleSetVersion,
      instructionFingerprint: input.instructionFingerprint,
      members: [...input.members].sort((left, right) => left.inputSeq - right.inputSeq),
      sourceSpans: input.sourceSpans
        .map(({ quote: _quote, ...span }) => span)
        .sort((left, right) => left.id.localeCompare(right.id)),
      facts: input.facts
        .map((fact) => ({
          ...fact,
          text: normalized(fact.text),
          citationIds: [...fact.citationIds].sort(),
          dependsOnFactIds: [...fact.dependsOnFactIds].sort(),
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      citations: [...input.citations].sort((left, right) => left.id.localeCompare(right.id)),
    })
  }

  private insertRevision(revision: StoryRevision) {
    this.db
      .prepare("INSERT INTO story_revisions VALUES(?,?,?,?,?,?,?)")
      .run(
        revision.storyId,
        revision.revision,
        revision.substantiveRevision,
        revision.substantiveContentFingerprint,
        revision.displayFingerprint,
        JSON.stringify(revision),
        revision.createdAt,
      )
  }

  // 索引是可重建的派生数据，启动时覆盖旧进程留下的版本，保证只包含 active current revision。
  private rebuildCurrentMemberIndex() {
    const rows = this.db
      .prepare(
        `SELECT revisions.story_id,revisions.body
         FROM story_revisions revisions
         JOIN stories ON stories.id=revisions.story_id AND stories.current_revision=revisions.revision
         WHERE stories.status='active'`,
      )
      .all() as StoryRow[]
    this.db.exec("SAVEPOINT story_member_index_rebuild")
    try {
      this.db.exec("DELETE FROM story_current_member_index")
      for (const row of rows)
        this.replaceCurrentMemberIndex(String(row.story_id), this.revisionFromRow(row).members)
      this.db.exec("RELEASE story_member_index_rebuild")
    } catch (error) {
      this.db.exec("ROLLBACK TO story_member_index_rebuild; RELEASE story_member_index_rebuild")
      throw error
    }
  }

  private replaceCurrentMemberIndex(storyId: string, members: StoryMemberReference[]) {
    this.clearCurrentMemberIndex(storyId)
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO story_current_member_index(input_seq,story_id) VALUES(?,?)",
    )
    for (const member of members) insert.run(member.inputSeq, storyId)
  }

  private clearCurrentMemberIndex(storyId: string) {
    this.db.prepare("DELETE FROM story_current_member_index WHERE story_id=?").run(storyId)
  }

  private currentStoryIdsForInputs(inputSeqs: number[]) {
    const ids = [...new Set(inputSeqs.filter(positiveInteger))]
    if (ids.length === 0) return []
    const placeholders = ids.map(() => "?").join(",")
    return (
      this.db
        .prepare(
          `SELECT DISTINCT story_id FROM story_current_member_index WHERE input_seq IN (${placeholders}) ORDER BY story_id`,
        )
        .all(...ids) as StoryRow[]
    ).map((row) => String(row.story_id))
  }

  private insertCorrection(
    kind: StoryCorrectionKind,
    storyIds: string[],
    baseRevisions: Record<string, number>,
    payload: Record<string, unknown>,
    undoOf: string | null = null,
  ): StoryCorrection {
    const correction: StoryCorrection = {
      id: randomUUID(),
      kind,
      storyIds: [...new Set(storyIds)].sort(),
      baseRevisions,
      payload,
      undoOf,
      undoneBy: null,
      createdAt: new Date().toISOString(),
    }
    this.db
      .prepare("INSERT INTO story_corrections VALUES(?,?,?,?,?,?,?,?)")
      .run(
        correction.id,
        correction.kind,
        JSON.stringify(correction.storyIds),
        JSON.stringify(correction.baseRevisions),
        JSON.stringify(correction.payload),
        correction.undoOf,
        null,
        correction.createdAt,
      )
    return correction
  }

  private markRepairing(storyIds: string[]) {
    for (const storyId of new Set(storyIds))
      if (
        this.db
          .prepare(
            "UPDATE stories SET status='repairing',updated_at=? WHERE id=? AND status='active'",
          )
          .run(new Date().toISOString(), storyId).changes === 1
      )
        this.clearCurrentMemberIndex(storyId)
  }

  private requireCurrent(storyId: string, expectedRevision: number) {
    const story = this.requireStory(storyId)
    if (story.status !== "active") throw new StoryStoreError("story_not_active")
    if (story.currentRevision !== expectedRevision) throw new StoryStoreError("revision_conflict")
    return story
  }

  private requireStory(storyId: string) {
    const story = this.story(storyId)
    if (!story) throw new StoryStoreError("story_not_found")
    return story
  }

  private requireRevision(storyId: string, revision: number) {
    const value = this.revision(storyId, revision)
    if (!value) throw new StoryStoreError("story_not_found")
    return value
  }

  private storyFromRow(row: StoryRow): Story {
    const split = row.status === "split" ? this.splitPayload(String(row.id)) : null
    return {
      id: String(row.id),
      aggregationRuleId: String(row.aggregation_rule_id),
      aggregationScopeVersion: String(row.aggregation_scope_version),
      status: row.status as StoryStatus,
      currentRevision: Number(row.current_revision),
      currentSubstantiveRevision: Number(row.current_substantive_revision),
      mergedInto: row.merged_into === null ? null : String(row.merged_into),
      splitInto: split?.childIds ?? [],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
  }

  private splitPayload(storyId: string) {
    const row = this.db
      .prepare(
        "SELECT payload FROM story_corrections WHERE kind='split' AND story_ids LIKE ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(`%${storyId}%`) as StoryRow | undefined
    if (!row) return null
    const payload = JSON.parse(String(row.payload)) as {
      childIds?: unknown
      independentInputSeqs?: unknown
    }
    return {
      childIds: Array.isArray(payload.childIds)
        ? payload.childIds.filter((id): id is string => typeof id === "string")
        : [],
      independentInputSeqs: Array.isArray(payload.independentInputSeqs)
        ? payload.independentInputSeqs.filter(positiveInteger)
        : [],
    }
  }

  private revisionFromRow(row: StoryRow): StoryRevision {
    return JSON.parse(String(row.body)) as StoryRevision
  }

  private correctionFromRow(row: StoryRow): StoryCorrection {
    return {
      id: String(row.id),
      kind: row.kind as StoryCorrectionKind,
      storyIds: JSON.parse(String(row.story_ids)) as string[],
      baseRevisions: JSON.parse(String(row.base_revisions)) as Record<string, number>,
      payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
      undoOf: row.undo_of === null ? null : String(row.undo_of),
      undoneBy: row.undone_by === null ? null : String(row.undone_by),
      createdAt: String(row.created_at),
    }
  }
}

function fingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
function revisionDraft(revision: StoryRevision): StoryRevisionDraft {
  const {
    storyId: _storyId,
    revision: _revision,
    substantiveRevision: _substantiveRevision,
    substantiveContentFingerprint: _substantiveContentFingerprint,
    displayFingerprint: _displayFingerprint,
    createdAt: _createdAt,
    ...draft
  } = revision
  return clone(draft)
}
function normalized(value: string) {
  return value.replace(/\s+/g, " ").trim()
}
export function sourceSpanFragmentId(sourceItemId: string, contentVersion: string, quote: string) {
  return createHash("sha256")
    .update(JSON.stringify([sourceItemId, contentVersion, normalized(quote)]))
    .digest("hex")
}
function sourceTextFromInputBody(body: string) {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const source = parsed as { content?: unknown; description?: unknown }
  const raw = typeof source.content === "string" ? source.content : source.description
  if (typeof raw !== "string" || !raw.trim()) return null
  // Folo 保存的原文可能是 HTML；片段比较基于可见文本，不能由模型任意声称 fragmentId。
  return raw
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
}
function hasFactDependencyCycle(facts: StoryFact[]) {
  const dependencies = new Map(facts.map((fact) => [fact.id, fact.dependsOnFactIds]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    visiting.add(id)
    const cyclic = dependencies.get(id)!.some(visit)
    visiting.delete(id)
    visited.add(id)
    return cyclic
  }
  return facts.some((fact) => visit(fact.id))
}
function uniqueIds<T>(ids: T[]): T[] {
  return [...new Set(ids)]
}
function everyUniqueKnown(ids: string[], known: Set<string>) {
  return ids.length > 0 && uniqueIds(ids).length === ids.length && ids.every((id) => known.has(id))
}
function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
}
function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}
