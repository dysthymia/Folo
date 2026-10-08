import { randomUUID } from "node:crypto"

import type { RuleSet } from "@follow/information-core"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { ProcessingInput } from "./automation-store"
import type { SourceEntry } from "./folo"
import type { GeneratedFeedPage } from "./generated-feeds"
import { generatedFeedQuerySchema } from "./generated-feeds"
import { processingApi } from "./processing-api"
import { activeDedupeActions } from "./processing-dedupe"
import type { ProcessingDuplicateGroup } from "./processing-duplicates"
import type { ProcessingEntryRole } from "./processing-reading-store"
import { semanticDuplicatePairKey } from "./semantic-dedupe"
import { Store } from "./store"
import { sourceSpanFragmentId } from "./story-store"

const stores: Store[] = []
const source = {
  key: "feed/f1",
  kind: "feed" as const,
  id: "f1",
  title: "来源",
  view: 0,
  category: null,
}

function fixture() {
  const store = new Store(":memory:")
  stores.push(store)
  store.bindOwner("owner")
  store.replaceSources([source])
  return store
}

function entry(id: string, publishedAt: string, read = false): SourceEntry {
  return {
    id,
    sourceKey: "feed/f1",
    title: `来源 ${id}`,
    url: `https://example.test/${id}`,
    publishedAt,
    read,
    content: `来源 ${id} 的可核查事实。`,
    description: null,
  }
}

function decision(input: SourceEntry, seq: number) {
  return {
    schemaVersion: 1,
    fingerprint: `fingerprint-${seq}`,
    provider: "codex" as const,
    model: "test-model",
    generatedAt: "2026-01-01T00:00:00.000Z",
    durationMs: 1,
    usage: null,
    status: "keep" as const,
    title: input.title,
    summary: `摘要 ${seq}`,
    reason: "测试决定",
    labels: [],
    policy: { standalone: "auto", aggregation: "allow", rewrite: "allow" },
    sourceRole: "reporting",
    context: { source_id: "f1", contextId: input.sourceKey },
    facts: [],
    semantic: null,
    reused: false,
  }
}

function publishInput(store: Store, input: SourceEntry, always = false) {
  store.saveEntry(input)
  const target = store.automation.assign(store.automation.inputs().at(-1)!.seq)
  const output = decision(input, target.seq)
  if (always) output.policy.standalone = "always"
  store.automation.complete(target, output)
  return target
}

function publishRelease(store: Store) {
  store.automation.publish(0, { mode: "future" }, randomUUID())
}

function publishDecision(
  store: Store,
  input: SourceEntry,
  options: {
    status?: "keep" | "hide" | "needs_context"
    standalone?: "auto" | "always" | "never"
    reason?: string
  } = {},
) {
  store.saveEntry(input)
  const target = store.automation.assign(store.automation.inputs().at(-1)!.seq)
  const base = decision(input, target.seq)
  store.automation.complete(target, {
    ...base,
    status: options.status ?? base.status,
    reason: options.reason ?? base.reason,
    policy: { ...base.policy, standalone: options.standalone ?? base.policy.standalone },
  })
  return target
}

function createAggregateStory(
  store: Store,
  members: Array<{ seq: number; itemId: string; contentVersion: string }>,
  title: string,
) {
  // 引用使用真实保存的正文，使同内容转载夹具也能通过来源核验。
  const spans = members.map((target) => {
    const quote = store.automation.inputs([target.seq])[0]!.body.content!
    return {
      id: `span-${target.seq}`,
      inputSeq: target.seq,
      sourceItemId: target.itemId,
      contentVersion: target.contentVersion,
      fragmentId: sourceSpanFragmentId(target.itemId, target.contentVersion, quote),
      quote,
      sourceRole: "reporting",
    }
  })
  const storyId = randomUUID()
  store.stories.create(
    {
      title,
      body: `${title}的综述正文`,
      aggregationRuleId: "rule",
      aggregationScopeVersion: "scope",
      appliedRuleSetVersion: 1,
      instructionFingerprint: "instruction",
      members: members.map((target) => ({
        inputSeq: target.seq,
        decisionId: store.processingState
          .published()
          .find((value) => value.input.seq === target.seq)!.decisionId,
      })),
      sourceSpans: spans,
      citations: spans.map((span) => ({
        id: `citation-${span.inputSeq}`,
        sourceSpanId: span.id,
        sentenceId: `sentence-${span.inputSeq}`,
      })),
      sentences: spans.map((span) => ({
        id: `sentence-${span.inputSeq}`,
        text: `事实 ${span.inputSeq}`,
        citationIds: [`citation-${span.inputSeq}`],
      })),
      facts: [
        {
          id: "fact",
          kind: "fact",
          text: "来源支持的事实",
          citationIds: spans.map((span) => `citation-${span.inputSeq}`),
          dependsOnFactIds: [],
        },
      ],
    },
    storyId,
  )
  return storyId
}

function rolesOf(store: Store) {
  return (processingApi(store, "GET", "/processing/roles", {}) as { roles: ProcessingEntryRole[] })
    .roles
}

afterEach(() => stores.splice(0).forEach((store) => store.close()))

// 只写入已通过包含判定的关系，避免角色投影测试重复请求模型。
function saveContainmentMerge(
  store: Store,
  keep: ProcessingInput,
  hide: ProcessingInput,
  keepReference = false,
) {
  const action = activeDedupeActions(
    store.automation.release(store.automation.releases()[0]!.version),
  )[0]!
  const pairKey = semanticDuplicatePairKey(keep.itemId, hide.itemId)
  store.dedupe.saveBatch({
    configFingerprint: action.fingerprint,
    ruleId: action.ruleId,
    provider: "codex",
    model: "test",
    decisions: [
      {
        keep,
        hide,
        keepReference,
        candidate: {
          pairKey,
          keepEntryId: keep.itemId,
          testEntryId: hide.itemId,
          similarity: 1,
          entries: [keep, hide].map((input) => ({
            itemId: input.itemId,
            title: input.itemId,
            sourceTitle: "来源",
            description: "",
            publishedAt: "2026-01-01T00:00:00.000Z",
            urlHost: "example.test",
          })) as [
            import("./semantic-dedupe").SemanticDuplicateEntry,
            import("./semantic-dedupe").SemanticDuplicateEntry,
          ],
        },
        evaluation: {
          pairKey,
          duplicate: true,
          confidence: 0.95,
          keepEntryId: keep.itemId,
          hideEntryId: hide.itemId,
          reason: "保留方包含隐藏方全部事实",
        },
      },
    ],
  })
}

// 直接保存已通过语义比较的包含关系，专项验证角色投影，不重复调用模型。
function containmentFixture(reverse: boolean, standalone: "auto" | "always" = "auto") {
  const store = fixture()
  const draft = store.automation.draft()
  store.automation.saveDraft(
    {
      ...draft.config,
      rules: [
        {
          actions: [{ scope: { all: true }, type: "ai_dedupe" }],
          enabled: true,
          executionLocation: "processing_service",
          id: "dedupe-chain",
          name: "包含链去重",
          order: 0,
          ownerId: "owner",
          version: 1,
          when: { all: true },
        },
      ],
    },
    draft.revision,
  )
  store.automation.publish(draft.revision + 1, { mode: "future" }, randomUUID())
  const c = publishDecision(store, entry("C", "2026-01-01T00:00:00.000Z", true))
  const b = publishDecision(store, entry("B", "2026-01-02T00:00:00.000Z"), { standalone })
  const a = publishDecision(store, entry("A", "2026-01-03T00:00:00.000Z"))
  const save = (keep: ProcessingInput, hide: ProcessingInput) =>
    saveContainmentMerge(store, keep, hide)
  if (reverse) {
    save(a, b)
    save(b, c)
  } else {
    save(b, c)
    save(a, b)
  }
  return { store, a, b, c }
}

describe("语义去重包含链角色", () => {
  it("首次详情只读取本组材料，无关后台写入后仍不扫描全库；恢复立即生效", () => {
    const { store, a, b, c } = containmentFixture(false)
    // 加入无关原文并保持角色缓存冷态，覆盖用户首次展开时的真实路径。
    for (let index = 0; index < 25; index++)
      store.saveEntry(entry(`unrelated-${index}`, "2026-01-04T00:00:00.000Z"))
    expect(store.reading.duplicateRoles(a.seq)[0]?.relatedEntryPreviews).toEqual([
      expect.objectContaining({ itemId: "C", title: "来源 C", sourceTitle: "来源" }),
      expect.objectContaining({ itemId: "B", title: "来源 B", sourceTitle: "来源" }),
    ])
    const inputs = vi.spyOn(store.automation, "inputs")
    const merges = vi.spyOn(store.dedupe, "merges")
    const read = () =>
      processingApi(
        store,
        "GET",
        `/processing/entries/${a.seq}/duplicates`,
        {},
      ) as ProcessingDuplicateGroup
    expect(read().total).toBe(2)
    store.processingState.report("unrelated-task", { status: "running" })
    expect(read().total).toBe(2)
    expect(merges.mock.calls.every(([, scoped]) => scoped?.length === 3)).toBe(true)
    expect(
      inputs.mock.calls.every(
        ([seqs]) =>
          seqs?.length === 3 &&
          seqs.includes(a.seq) &&
          seqs.includes(b.seq) &&
          seqs.includes(c.seq),
      ),
    ).toBe(true)
    store.processingState.setOverride(c.seq, "restore", 0)
    expect(read().members.map((member) => member.itemId)).toEqual(["B"])
    expect(merges).toHaveBeenCalled()
    inputs.mockRestore()
    merges.mockRestore()
  })

  it("组查询保留综述与同正文转载优先级，不把已参与综述的材料再次折叠", () => {
    const { store, a, b } = containmentFixture(false)
    const original = publishDecision(store, { ...b.body, id: "story-original" })
    const other = publishDecision(store, entry("story-other", "2026-01-04T00:00:00.000Z"))
    createAggregateStory(store, [original, other], "独立综述")
    expect(rolesOf(store).find((role) => role.inputSeq === a.seq)?.kind).not.toBe("keeper")
    expect(store.reading.duplicateRoles(a.seq)).toEqual([])
  })

  it("组索引覆盖竞争代表，仍按置信度与原有顺序选择唯一最终代表", () => {
    const { store, a, b } = containmentFixture(false)
    const other = publishDecision(store, entry("D", "2026-01-04T00:00:00.000Z"))
    saveContainmentMerge(store, other, b)
    expect(store.reading.duplicateRoles(a.seq).map((role) => role.itemId)).toEqual(["A", "C", "B"])
    expect(store.reading.duplicateRoles(other.seq)).toEqual([])
  })

  it("包含关系成环时组查询能够结束，保留所有原文而不制造代表", () => {
    const { store, a, b, c } = containmentFixture(false)
    // 同一对反向判定会覆盖旧行，使用三个不同配对构成真实包含环。
    saveContainmentMerge(store, c, a)
    expect(store.reading.duplicateRoles(a.seq)).toEqual([])
    expect(store.reading.duplicateRoles(b.seq)).toEqual([])
  })
  it("重复组按完整关系分页，提供折叠理由和覆盖版本，恢复后保留原文与读态", () => {
    const { store, a, c } = containmentFixture(false)
    const before = store.automation.inputs().map((input) => input.body)
    const first = processingApi(store, "POST", `/processing/entries/${a.seq}/duplicates`, {
      limit: 1,
    }) as ProcessingDuplicateGroup
    expect(first).toMatchObject({
      total: 2,
      offset: 0,
      nextOffset: 1,
      representative: { itemId: "A", title: "来源 A", sourceTitle: "来源" },
    })
    expect(first.members).toEqual([
      expect.objectContaining({
        itemId: "C",
        inputSeq: c.seq,
        reason: expect.stringContaining("《来源 C》 → 《来源 B》"),
        canRestore: true,
        overrideRevision: 0,
      }),
    ])
    // 包含链展开到最终代表，不能把 C/B 的比较理由错误标成 C/A 的直接证据。
    expect(first.members[0]!.reason).toContain("《来源 B》 → 《来源 A》")
    const second = processingApi(store, "POST", `/processing/entries/${a.seq}/duplicates`, {
      offset: 1,
      limit: 1,
      expectedFingerprint: first.fingerprint,
    }) as ProcessingDuplicateGroup
    expect(second.members.map((member) => member.itemId)).toEqual(["B"])
    expect(second.nextOffset).toBeNull()
    processingApi(store, "POST", `/processing/entries/${c.seq}/override`, {
      mode: "restore",
      expectedRevision: first.members[0]!.overrideRevision,
    })
    const after = processingApi(
      store,
      "GET",
      `/processing/entries/${a.seq}/duplicates`,
      {},
    ) as ProcessingDuplicateGroup
    expect(after.total).toBe(1)
    expect(after.members.map((member) => member.itemId)).toEqual(["B"])
    expect(() =>
      processingApi(store, "POST", `/processing/entries/${a.seq}/duplicates`, {
        offset: 1,
        expectedFingerprint: first.fingerprint,
      }),
    ).toThrow("revision_conflict")
    expect(store.automation.inputs().map((input) => input.body)).toEqual(before)
    expect(store.entry(source.key, "C")?.read).toBe(true)
    expect(store.reading.counts(store.reading.refresh().id).standalone).toBe(2)
    expect(rolesOf(store).find((role) => role.inputSeq === c.seq)?.kind).toBe("restored")
  })

  it.each(["merged", "withdrawn", "source", "version"] as const)(
    "拒绝失效代表或非代表身份：%s",
    (change) => {
      const { store, a, b } = containmentFixture(false)
      if (change === "withdrawn") store.stories.withdrawMaterial(a.seq, "撤回")
      if (change === "source") store.replaceSources([])
      if (change === "version") store.saveEntry({ ...a.body, content: "新的原文事实" })
      expect(() =>
        processingApi(
          store,
          "GET",
          `/processing/entries/${change === "merged" ? b.seq : a.seq}/duplicates`,
          {},
        ),
      ).toThrow("invalid_target")
    },
  )

  it.each([false, true])("两种判定顺序都将链成员指向最终代表并保留读态：%s", (reverse) => {
    const { store } = containmentFixture(reverse)
    expect(rolesOf(store)).toEqual([
      expect.objectContaining({ itemId: "C", kind: "merged", relatedEntryIds: ["A"] }),
      expect.objectContaining({ itemId: "B", kind: "merged", relatedEntryIds: ["A"] }),
      expect.objectContaining({
        itemId: "A",
        kind: "keeper",
        relatedEntryIds: ["C", "B"],
        materialCount: 3,
      }),
    ])
    const snapshot = store.reading.refresh()
    expect(store.reading.counts(snapshot.id).standalone).toBe(1)
    expect(store.entry(source.key, "C")?.read).toBe(true)
    // 单来源范围仍保留所有原文，不因全局包含链而吞掉源内条目。
    expect(
      store.reading.generatedPage(
        generatedFeedQuerySchema.parse({ mode: "smart", sourceKeys: [source.key] }),
      ).items,
    ).toHaveLength(3)
  })

  it("人工恢复中间成员会断开包含链且不再吞掉链尾", () => {
    const { store, b } = containmentFixture(false)
    store.processingState.setOverride(b.seq, "restore", 0)
    expect(rolesOf(store).filter((role) => role.kind === "merged")).toEqual([])
    expect(store.reading.counts(store.reading.refresh().id).standalone).toBe(3)
  })

  it("显式始终保留的中间成员不会参与包含链", () => {
    const { store } = containmentFixture(false, "always")
    expect(rolesOf(store)).toEqual([])
    expect(store.reading.counts(store.reading.refresh().id).standalone).toBe(3)
  })

  it("已有综述角色的中间成员保留归属，重复报道继续折叠到综述入口", () => {
    const { store, a, b } = containmentFixture(false)
    const other = publishDecision(store, entry("D", "2026-01-04T00:00:00.000Z"))
    const storyId = createAggregateStory(store, [b, other], "独立综述")
    expect(rolesOf(store)).toEqual([
      expect.objectContaining({ itemId: "C", kind: "merged", relatedEntryIds: ["D"], storyId }),
      expect.objectContaining({ itemId: "B", kind: "merged", relatedEntryIds: ["D"] }),
      expect.objectContaining({ itemId: "D", kind: "story", relatedEntryIds: ["B", "C"] }),
    ])
    // 综述的真实材料仍是 B/D，C 只是已验证重复报道；A 不受逆向包含关系影响。
    expect(rolesOf(store).find((role) => role.itemId === "D")?.materialCount).toBe(2)
    expect(rolesOf(store).find((role) => role.inputSeq === a.seq)).toBeUndefined()
    expect(
      store.stories.currentSnapshot(storyId)?.members.map((member) => member.inputSeq),
    ).toEqual([b.seq, other.seq])
  })

  it.each([false, true])(
    "重复链的保留方进入综述后，所有重复报道仍折叠（代表=%s）",
    (representative) => {
      const { store, a, b, c } = containmentFixture(false)
      // 用更早的 C 或更晚的 D 配对，分别覆盖保留方是综述代表和普通成员。
      const other = representative
        ? c
        : publishDecision(store, entry("D", "2026-01-04T00:00:00.000Z"))
      const storyId = createAggregateStory(store, [a, other], "融资综述")
      // 原文身份不同，确保验证的是语义去重与综述的衔接，而不是同 URL 的折叠。
      const roles = rolesOf(store)
      const storyRole = roles.find((role) => role.kind === "story")!
      for (const input of [b, c])
        expect(roles.find((role) => role.inputSeq === input.seq)).toMatchObject({
          kind: "merged",
          relatedEntryIds: [storyRole.itemId],
          storyId,
        })
      expect(storyRole.materialCount).toBe(2)
      const page = store.reading.generatedPage(generatedFeedQuerySchema.parse({ mode: "smart" }))
      expect(page.items.filter((item) => item.kind === "entry")).toEqual([])
      expect(page.items.filter((item) => item.kind === "story").map((item) => item.id)).toEqual([
        storyId,
      ])
    },
  )
})

// 已读参考保持原读态和未发布状态，只让被覆盖的未读条目获得合并角色。
function readReferenceFixture(keepReference = true) {
  const { store } = containmentFixture(false)
  const draft = store.automation.draft()
  store.automation.saveDraft(
    {
      ...draft.config,
      rules: [
        ...draft.config.rules,
        {
          ...draft.config.rules[0]!,
          id: "context-guard",
          order: 1,
          when: { anyOf: [{ allOf: [{ field: "title", operator: "eq", value: "blocked" }] }] },
          actions: [{ type: "presentation", policy: { standalone: "always" } }],
        },
      ],
    },
    draft.revision,
  )
  store.automation.publish(draft.revision + 1, { mode: "future" }, randomUUID())
  const reference = entry("reference", "2026-01-03T00:00:00.000Z", true)
  store.saveEntry(reference)
  const keep = store.automation.inputs().at(-1)!
  store.processingState.setMaterial(keep, "complete")
  store.processingState.settleRead([keep.seq], [])
  const currentKeep = store.automation.inputs().find((input) => input.seq === keep.seq)!
  const hide = publishInput(store, entry("covered", "2026-01-03T01:00:00.000Z"))
  saveContainmentMerge(store, currentKeep, hide, keepReference)
  return { store, keep: currentKeep, hide, reference }
}

describe("已读缓存参考的合并投影", () => {
  it("未发布已读参考可隐藏完整覆盖的未读条目，读态与处理状态保持不变", () => {
    const { store, keep } = readReferenceFixture()
    expect(rolesOf(store)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: "covered",
          kind: "merged",
          relatedEntryIds: ["reference"],
        }),
        expect.objectContaining({ itemId: "reference", kind: "keeper" }),
      ]),
    )
    const page = store.reading.generatedPage(
      generatedFeedQuerySchema.parse({ mode: "smart", unreadOnly: true }),
    )
    expect(page.items.some((item) => item.id === "covered")).toBe(false)
    // 来源页保留原文供逐篇核对；全局未读列表才折叠已读事实覆盖的重复内容。
    expect(
      store.reading
        .generatedPage(
          generatedFeedQuerySchema.parse({
            mode: "smart",
            sourceKeys: [source.key],
            unreadOnly: true,
          }),
        )
        .items.some((item) => item.id === "covered"),
    ).toBe(true)
    expect(store.entry(source.key, "reference")?.read).toBe(true)
    expect(store.automation.inputs().find((input) => input.seq === keep.seq)?.status).toBe(
      "skipped",
    )
    expect(store.processingState.published().some((item) => item.input.seq === keep.seq)).toBe(
      false,
    )
  })

  it("未标记参考的未发布条目不能成为隐藏代表", () => {
    const { store } = readReferenceFixture(false)
    expect(rolesOf(store).some((role) => role.itemId === "covered")).toBe(false)
  })

  it.each(["unread", "restore", "material", "body", "context", "always", "disabled"] as const)(
    "参考资格失效后不再隐藏未读条目：%s",
    (change) => {
      const { store, keep, reference } = readReferenceFixture()
      if (change === "unread") store.saveEntry({ ...reference, read: false })
      if (change === "restore") store.processingState.setOverride(keep.seq, "restore", 0)
      if (change === "material") store.processingState.setMaterial(keep, "missing")
      if (change === "body") store.saveEntry({ ...reference, content: "改变后的事实" })
      if (change === "context") store.replaceSources([{ ...source, title: "blocked" }])
      if (change === "always" || change === "disabled") {
        const draft = store.automation.draft()
        const rules: RuleSet["rules"] = draft.config.rules.map((rule) => ({
          ...rule,
          enabled: change !== "disabled",
        }))
        if (change === "always") {
          rules.push({
            ...rules[0]!,
            id: "always-reference",
            order: 2,
            when: {
              anyOf: [
                { allOf: [{ field: "entry_title", operator: "eq", value: reference.title }] },
              ],
            },
            actions: [{ type: "presentation", policy: { standalone: "always" } }],
          })
        }
        store.automation.saveDraft({ ...draft.config, rules }, draft.revision)
        store.automation.publish(draft.revision + 1, { mode: "future" }, randomUUID())
      }
      expect(rolesOf(store).some((role) => role.itemId === "covered")).toBe(false)
      expect(
        store.reading
          .generatedPage(generatedFeedQuerySchema.parse({ mode: "smart", unreadOnly: true }))
          .items.some((item) => item.id === "covered"),
      ).toBe(true)
    },
  )
})

describe("原生收藏与深链投影", () => {
  it("全局分类接受 all 并跨视图合并同名来源，数字视图分类保持局部范围", () => {
    expect(
      generatedFeedQuerySchema.parse({ category: { view: "all", name: "Blockchain" } }).category,
    ).toEqual({ view: "all", name: "Blockchain" })
    expect(() =>
      generatedFeedQuerySchema.parse({ category: { view: -1, name: "Blockchain" } }),
    ).toThrow()
    const store = fixture()
    store.replaceSources([
      { ...source, category: "Blockchain" },
      { ...source, key: "feed/f2", id: "f2", view: 1, category: "Blockchain" },
      { ...source, key: "feed/f3", id: "f3", category: "Other" },
    ])
    publishRelease(store)
    const first = publishDecision(store, entry("member-0", "2026-01-01T00:00:00.000Z"))
    const second = publishDecision(store, {
      ...entry("member-1", "2026-01-02T00:00:00.000Z"),
      sourceKey: "feed/f2",
    })
    const storyId = createAggregateStory(store, [first, second], "跨视图同事件")
    const original0 = entry("original-0", "2026-01-03T00:00:00.000Z")
    const original1 = { ...entry("original-1", "2026-01-04T00:00:00.000Z"), sourceKey: "feed/f2" }
    const other = { ...entry("other", "2026-01-05T00:00:00.000Z"), sourceKey: "feed/f3" }
    publishDecision(store, original0)
    publishDecision(store, original1)
    publishDecision(store, other)
    const query = generatedFeedQuerySchema.parse({
      mode: "smart",
      category: { view: "all", name: "Blockchain" },
      refresh: true,
    })
    const all = store.reading.generatedPage(query)
    expect(all.items.map((item) => item.id).sort()).toEqual(
      [storyId, "original-0", "original-1"].sort(),
    )
    const scoped = store.reading.generatedPage({
      ...query,
      category: { view: 0, name: "Blockchain" },
    })
    expect(scoped.items.filter((item) => item.kind === "entry").map((item) => item.id)).toEqual([
      "original-0",
    ])
    expect(scoped.items.some((item) => item.id === "other")).toBe(false)
    store.reading.replaceOfficialCollections(
      [original0, original1, other].map((item) => ({ ...item, collected: true })),
    )
    expect(
      store.reading
        .generatedPage({ ...query, mode: "collections", view: 0 })
        .items.map((item) => item.id)
        .sort(),
    ).toEqual(["original-0", "original-1"].sort())
    expect(
      store.reading
        .generatedPage({ ...query, mode: "collections", category: { view: 1, name: "Blockchain" } })
        .items.map((item) => item.id),
    ).toEqual(["original-1"])
  })
  it("空列表诊断保持同一来源库存口径，搜索与读态筛选不伪装为空源", () => {
    const store = fixture()
    publishRelease(store)
    publishDecision(store, entry("hidden", "2026-01-01T00:00:00.000Z"), { status: "hide" })
    publishDecision(store, entry("context", "2026-01-02T00:00:00.000Z"), {
      status: "needs_context",
    })
    publishDecision(store, entry("ready", "2026-01-03T00:00:00.000Z"))
    store.saveEntry(entry("unassigned", "2026-01-04T00:00:00.000Z"))
    const query = {
      mode: "smart" as const,
      limit: 30,
      unreadOnly: false,
      collectedOnly: false,
      refresh: true,
    }
    const base = store.reading.generatedPage(query)
    const empty = store.reading.generatedPage({ ...query, search: "不存在的词", unreadOnly: true })
    expect(empty.total).toBe(0)
    expect(empty.counts).toEqual(base.counts)
    expect(empty.counts).toMatchObject({
      inputs: 4,
      uncovered: 1,
      hidden: 1,
      folded: 0,
      pending: 1,
      needsContext: 1,
    })
    expect(
      store.reading.generatedPage({ ...query, sourceKeys: ["feed/other"] }).counts,
    ).toMatchObject({ inputs: 0, uncovered: 0, hidden: 0, folded: 0, pending: 0, needsContext: 0 })
  })
  it("保留未处理、待补、隐藏和已并入 Story 的全部显式收藏原文", () => {
    const store = fixture()
    publishRelease(store)
    const member = publishDecision(store, entry("member", "2026-01-04T00:00:00.000Z"))
    publishDecision(store, entry("hidden", "2026-01-03T00:00:00.000Z"), { status: "hide" })
    publishDecision(store, entry("context", "2026-01-02T00:00:00.000Z"), {
      status: "needs_context",
    })
    const otherMember = publishDecision(store, entry("other-member", "2026-01-05T00:00:00.000Z"))
    const storyId = createAggregateStory(store, [member, otherMember], "收藏综述")
    store.reading.generatedStoryState(storyId, { collected: true })
    expect(store.reading.generatedStats()).toEqual({
      feedId: "generated:events",
      total: 1,
      unread: 1,
      collected: 1,
    })
    store.reading.generatedStoryState(storyId, { read: true })
    expect(store.reading.generatedStats().unread).toBe(0)
    const entries = ["member", "hidden", "context", "unprocessed"].map((id, index) => ({
      ...entry(id, `2026-01-0${4 - index}T00:00:00.000Z`),
      collected: true,
      view: 0,
    }))
    store.reading.replaceOfficialCollections(entries)
    const page = store.reading.generatedPage({
      mode: "collections",
      limit: 30,
      unreadOnly: false,
      collectedOnly: false,
      refresh: true,
    })
    expect(page.items.map((item) => item.id)).toEqual(
      expect.arrayContaining([...entries.map((item) => item.id), storyId]),
    )
    expect(page.total).toBe(5)
    expect(page.items.find((item) => item.id === "unprocessed")).toMatchObject({
      inputSeq: null,
      decisionId: null,
    })
    expect(store.automation.inputs()).toHaveLength(4)
    store.reading.replaceOfficialCollections(entries.filter((item) => item.id !== "hidden"))
    expect(
      store.reading
        .generatedPage({
          mode: "collections",
          limit: 30,
          unreadOnly: false,
          collectedOnly: false,
          refresh: false,
          snapshotId: page.snapshotId,
        })
        .items.some((item) => item.id === "hidden"),
    ).toBe(false)
  })

  it("收藏可覆盖已经退订的真实来源，不改变普通 AI 来源资格", () => {
    const store = fixture()
    store.reading.replaceOfficialCollections([
      {
        ...entry("saved", "2026-01-01T00:00:00.000Z"),
        sourceKey: "feed/unsubscribed",
        collected: true,
        view: 1,
      },
    ])
    expect(
      store.reading.generatedPage({
        mode: "collections",
        limit: 30,
        unreadOnly: false,
        collectedOnly: false,
        refresh: true,
        view: 1,
      }).items,
    ).toHaveLength(1)
    expect(
      store.reading.generatedPage({
        mode: "collections",
        limit: 30,
        unreadOnly: false,
        collectedOnly: false,
        refresh: true,
        view: 0,
      }).items,
    ).toHaveLength(0)
  })

  it("深链定位首批之外的冻结页，且不能把该快照用于其它来源范围", () => {
    const store = fixture()
    publishRelease(store)
    for (let index = 0; index < 63; index++)
      publishDecision(
        store,
        entry(`entry-${index}`, new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString()),
      )
    const query = {
      mode: "smart" as const,
      limit: 7,
      unreadOnly: false,
      collectedOnly: false,
      refresh: true,
    }
    const first = store.reading.generatedPage(query)
    const target = store.reading.locateGenerated(
      { ...query, refresh: false, snapshotId: first.snapshotId },
      { entryId: "entry-0" },
    )!
    expect(target.cursor).not.toBeNull()
    const previous = store.reading.generatedPage({
      ...query,
      refresh: false,
      snapshotId: target.snapshotId,
      cursor: target.previousCursor ?? undefined,
    })
    expect(previous.items).toHaveLength(7)
    expect(previous.nextCursor).toBe(target.cursor)
    expect(
      store.reading
        .generatedPage({
          ...query,
          refresh: false,
          snapshotId: target.snapshotId,
          cursor: target.cursor!,
        })
        .items.some((item) => item.id === "entry-0"),
    ).toBe(true)
    expect(() =>
      store.reading.locateGenerated(
        { ...query, snapshotId: first.snapshotId, sourceKeys: ["feed/other"] },
        { entryId: "entry-0" },
      ),
    ).toThrow("invalid_pagination")
    expect(store.reading.generatedEntryState("entry-0")).toMatchObject({
      status: "ready",
      item: { id: "entry-0" },
    })
    expect(store.reading.generatedEntryState("unknown")).toMatchObject({
      status: "unprocessed",
      item: null,
      target: null,
    })
  })

  it("隐藏与缺上下文深链给出原因并保留原文身份", () => {
    const store = fixture()
    publishRelease(store)
    publishDecision(store, entry("hidden", "2026-01-01T00:00:00.000Z"), {
      status: "hide",
      reason: "重复营销",
    })
    publishDecision(store, entry("context", "2026-01-02T00:00:00.000Z"), {
      status: "needs_context",
      reason: "缺串文",
    })
    expect(store.reading.generatedEntryState("hidden")).toMatchObject({
      status: "hidden",
      reason: "重复营销",
      target: null,
      item: { id: "hidden" },
    })
    expect(store.reading.generatedEntryState("context")).toMatchObject({
      status: "needs_context",
      reason: "缺串文",
      target: null,
      item: { id: "context" },
    })
  })
})

describe("时间线角色投影", () => {
  it("隐藏决定落成 hidden，always 例外与未处理输入都不产生角色", () => {
    const store = fixture()
    publishRelease(store)
    publishDecision(store, entry("kept", "2026-01-01T00:00:00.000Z"))
    const hidden = publishDecision(store, entry("hidden", "2026-01-02T00:00:00.000Z"), {
      status: "hide",
      reason: "娱乐内容",
    })
    const pinned = publishDecision(store, entry("pinned", "2026-01-03T00:00:00.000Z"), {
      status: "hide",
      standalone: "always",
    })
    publishDecision(store, entry("never", "2026-01-04T00:00:00.000Z"), { standalone: "never" })
    store.saveEntry(entry("pending", "2026-01-05T00:00:00.000Z"))
    expect(pinned.seq).toBeGreaterThan(hidden.seq)

    expect(rolesOf(store)).toEqual([
      {
        itemId: "hidden",
        inputSeq: hidden.seq,
        kind: "hidden",
        reason: "娱乐内容",
        relatedEntryIds: [],
        storyId: null,
        storyTitle: null,
        materialCount: 1,
      },
      {
        itemId: "never",
        inputSeq: 4,
        kind: "hidden",
        reason: "测试决定",
        relatedEntryIds: [],
        storyId: null,
        storyTitle: null,
        materialCount: 1,
      },
    ])
  })

  it("恢复覆盖让隐藏条目回到时间线并标注为已恢复，手动隐藏无需重新处理", () => {
    const store = fixture()
    publishRelease(store)
    const restored = publishDecision(store, entry("restored", "2026-01-01T00:00:00.000Z"), {
      status: "hide",
    })
    const forced = publishDecision(store, entry("forced", "2026-01-02T00:00:00.000Z"))
    store.processingState.setOverride(restored.seq, "restore", 0)
    store.processingState.setOverride(forced.seq, "hide", 0)

    // 恢复后条目要以 restored 回到时间线（不是悄悄消失成「无角色」），手动隐藏的要保持 hidden。
    expect(rolesOf(store)).toEqual([
      expect.objectContaining({ itemId: "restored", inputSeq: restored.seq, kind: "restored" }),
      expect.objectContaining({ itemId: "forced", kind: "hidden" }),
    ])
  })

  it("取消恢复（改回 automatic）后条目重新被规则隐藏", () => {
    const store = fixture()
    publishRelease(store)
    const restored = publishDecision(store, entry("restored", "2026-01-01T00:00:00.000Z"), {
      status: "hide",
    })
    store.processingState.setOverride(restored.seq, "restore", 0)
    expect(rolesOf(store)).toEqual([
      expect.objectContaining({ itemId: "restored", kind: "restored" }),
    ])

    store.processingState.setOverride(restored.seq, "automatic", 1)

    expect(rolesOf(store)).toEqual([
      expect.objectContaining({ itemId: "restored", kind: "hidden" }),
    ])
  })

  it("恢复综述成员让它退出并入，代表条目的来源计数同步扣减", () => {
    const store = fixture()
    const otherSource = { ...source, key: "feed/f2", id: "f2", title: "其他来源" }
    store.replaceSources([source, otherSource])
    publishRelease(store)
    const first = publishDecision(store, entry("one", "2026-01-01T00:00:00.000Z"))
    const second = publishDecision(store, entry("two", "2026-01-02T00:00:00.000Z"))
    createAggregateStory(store, [first, second], "同事件综述")

    // 基线：较新的一条代表整篇，较早的一条并入它。
    expect(rolesOf(store)).toEqual([
      expect.objectContaining({ itemId: "one", kind: "merged" }),
      expect.objectContaining({ itemId: "two", kind: "story", relatedEntryIds: ["one"] }),
    ])

    store.processingState.setOverride(first.seq, "restore", 0)

    // 恢复后该条目以 restored 回到时间线；它是综述唯一成员，代表条目退回普通条目，
    // 不留一个「综述 · 1」的空壳角标。
    expect(rolesOf(store)).toEqual([expect.objectContaining({ itemId: "one", kind: "restored" })])
  })

  it("恢复综述代表本身不改变归属：它本来就是可见的那一条", () => {
    const store = fixture()
    const otherSource = { ...source, key: "feed/f2", id: "f2", title: "其他来源" }
    store.replaceSources([source, otherSource])
    publishRelease(store)
    const first = publishDecision(store, entry("one", "2026-01-01T00:00:00.000Z"))
    const second = publishDecision(store, entry("two", "2026-01-02T00:00:00.000Z"))
    createAggregateStory(store, [first, second], "同事件综述")

    store.processingState.setOverride(second.seq, "restore", 0)

    expect(rolesOf(store)).toEqual([
      expect.objectContaining({ itemId: "one", kind: "merged" }),
      expect.objectContaining({ itemId: "two", kind: "story", relatedEntryIds: ["one"] }),
    ])
  })

  it("同一原帖的转载被恢复后不再算作已并入", () => {
    const store = fixture()
    const otherSource = { ...source, key: "feed/f2", id: "f2", title: "其他来源" }
    store.replaceSources([source, otherSource])
    publishRelease(store)
    const post = "1900000000000000001"
    const first = publishDecision(store, {
      ...entry(`x:${post}`, "2026-01-01T00:00:00.000Z"),
      url: `https://x.com/u/status/${post}`,
    })
    const second = publishDecision(store, entry("two", "2026-01-02T00:00:00.000Z"))
    const repost = publishDecision(store, {
      ...entry(`x:${post}`, "2026-01-03T00:00:00.000Z"),
      sourceKey: otherSource.key,
      url: `https://x.com/u/status/${post}`,
    })
    createAggregateStory(store, [first, second], "同事件综述")

    // 转载默认并入代表条目；手工恢复后它以 restored 独立占位。
    expect(rolesOf(store).find((role) => role.inputSeq === repost.seq)?.kind).toBe("merged")

    store.processingState.setOverride(repost.seq, "restore", 0)

    expect(rolesOf(store)).toContainEqual(
      expect.objectContaining({ itemId: `x:${post}`, inputSeq: repost.seq, kind: "restored" }),
    )
  })

  it("综述按最新成员代表整篇，其余成员与同内容转载都并入它", () => {
    const store = fixture()
    const otherSource = { ...source, key: "feed/f2", id: "f2", title: "其他来源" }
    store.replaceSources([source, otherSource])
    publishRelease(store)
    const post = "1900000000000000001"
    const first = publishDecision(store, {
      ...entry(`x:${post}`, "2026-01-01T00:00:00.000Z"),
      url: `https://x.com/u/status/${post}`,
    })
    const second = publishDecision(store, entry("two", "2026-01-02T00:00:00.000Z"))
    const repost = publishDecision(store, {
      ...entry(`x:${post}`, "2026-01-03T00:00:00.000Z"),
      sourceKey: otherSource.key,
      url: `https://x.com/u/status/${post}`,
    })
    const storyId = createAggregateStory(store, [first, second], "同事件综述")

    expect(rolesOf(store)).toEqual([
      {
        itemId: `x:${post}`,
        inputSeq: first.seq,
        kind: "merged",
        reason: "同事件综述",
        relatedEntryIds: ["two"],
        storyId,
        storyTitle: "同事件综述",
        materialCount: 2,
      },
      {
        itemId: "two",
        inputSeq: second.seq,
        kind: "story",
        reason: "同事件综述",
        relatedEntryIds: [`x:${post}`],
        storyId,
        storyTitle: "同事件综述",
        materialCount: 2,
      },
      {
        itemId: `x:${post}`,
        inputSeq: repost.seq,
        kind: "merged",
        reason: "同事件综述",
        relatedEntryIds: ["two"],
        storyId,
        storyTitle: "同事件综述",
        materialCount: 2,
      },
    ])
  })

  it("成员全部被隐藏时不再产生综述角色", () => {
    const store = fixture()
    publishRelease(store)
    const first = publishDecision(store, entry("one", "2026-01-01T00:00:00.000Z"))
    const second = publishDecision(store, entry("two", "2026-01-02T00:00:00.000Z"))
    const storyId = createAggregateStory(store, [first, second], "同事件综述")
    expect(rolesOf(store)).toEqual([
      expect.objectContaining({ itemId: "one", kind: "merged", storyId }),
      expect.objectContaining({ itemId: "two", kind: "story", storyId }),
    ])

    store.processingState.setOverride(first.seq, "hide", 0)
    store.processingState.setOverride(second.seq, "hide", 0)
    expect(rolesOf(store)).toEqual([
      expect.objectContaining({ itemId: "one", kind: "hidden", storyId: null }),
      expect.objectContaining({ itemId: "two", kind: "hidden", storyId: null }),
    ])
  })
})

describe("稳定阅读快照", () => {
  it("从固定成员汇总独立项、隐藏、待处理和失败，并单列当前来源状态", () => {
    const store = fixture()
    publishRelease(store)
    const readyTarget = publishInput(store, entry("ready", "2026-01-01T00:00:00.000Z"))
    const hidden = entry("hidden", "2026-01-02T00:00:00.000Z")
    store.saveEntry(hidden)
    const hiddenTarget = store.automation.assign(store.automation.inputs().at(-1)!.seq)
    store.automation.complete(hiddenTarget, {
      ...decision(hidden, hiddenTarget.seq),
      status: "hide",
    })
    store.saveEntry(entry("pending", "2026-01-03T00:00:00.000Z"))
    const pendingTarget = store.automation.inputs().at(-1)!
    store.saveEntry(entry("failed", "2026-01-04T00:00:00.000Z"))
    const failedTarget = store.automation.assign(store.automation.inputs().at(-1)!.seq)
    store.processingState.fail(failedTarget, "model_failed")
    store.schedule.save(
      {
        sourceKeys: [source.key],
        historySince: "2026-01-01T00:00:00.000Z",
        timeZone: "Asia/Shanghai",
        enabled: true,
        times: ["08:00"],
      },
      0,
    )
    const trigger = store.schedule.manual(randomUUID(), "2026-01-04T00:00:00.000Z")
    store.processingState.report(trigger.id, {
      sources: [{ sourceKey: source.key, pages: 1, entries: 4, coverage: "budget", failure: null }],
      finishedAt: "2026-01-04T00:01:00.000Z",
    })

    expect(processingApi(store, "GET", "/reading-snapshot", {})).toMatchObject({
      counts: { standalone: 3, stories: 0, hidden: 1, pending: 1, skipped: 0, failed: 1 },
      processing: {
        runStatus: "pending",
        sourceTotal: 1,
        incompleteSources: 1,
        sourceStatusAt: "2026-01-04T00:01:00.000Z",
      },
      schedule: { enabled: true, timeZone: "Asia/Shanghai" },
    })
    const snapshot = store.reading.snapshot()
    expect(store.reading.page({ snapshotId: snapshot.id })).toMatchObject({
      view: "smart",
      total: 1,
      items: [{ kind: "entry", state: "ready", inputSeq: readyTarget.seq }],
    })
    expect(store.reading.page({ snapshotId: snapshot.id, view: "pending" })).toMatchObject({
      total: 1,
      items: [{ kind: "entry", state: "pending", inputSeq: pendingTarget.seq }],
    })
    expect(store.reading.page({ snapshotId: snapshot.id, view: "failed" })).toMatchObject({
      total: 1,
      items: [{ kind: "entry", state: "pending", inputSeq: failedTarget.seq, status: "failed" }],
    })
  })

  it("已读跳过与待处理分开计数，并可从独立视图查看", () => {
    const store = fixture()
    publishRelease(store)
    publishInput(store, entry("ready", "2026-01-01T00:00:00.000Z"))
    store.saveEntry(entry("waiting", "2026-01-02T00:00:00.000Z"))
    const pendingTarget = store.automation.inputs().at(-1)!
    store.saveEntry(entry("already-read", "2026-01-03T00:00:00.000Z", true))
    const skippedTarget = store.automation.inputs().at(-1)!
    store.processingState.settleRead([skippedTarget.seq], [])
    store.schedule.save(
      {
        sourceKeys: [source.key],
        historySince: "2026-01-01T00:00:00.000Z",
        timeZone: "Asia/Shanghai",
        enabled: true,
        times: ["08:00"],
      },
      0,
    )
    store.reading.refresh()

    expect(processingApi(store, "GET", "/reading-snapshot", {})).toMatchObject({
      // 已读条目不再计入「待处理」，否则用户会把永不再处理的历史积压当成还在增长的队列。
      counts: { standalone: 3, stories: 0, hidden: 0, pending: 1, skipped: 1, failed: 0 },
    })
    const snapshot = store.reading.snapshot()
    expect(store.reading.page({ snapshotId: snapshot.id, view: "pending" })).toMatchObject({
      total: 1,
      items: [{ kind: "entry", state: "pending", inputSeq: pendingTarget.seq }],
    })
    expect(store.reading.page({ snapshotId: snapshot.id, view: "skipped" })).toMatchObject({
      total: 1,
      items: [{ kind: "entry", state: "pending", inputSeq: skippedTarget.seq, status: "skipped" }],
    })
  })

  it("待处理输入占位并计入总数，晚到决定只能在刷新后进入可读状态", () => {
    const store = fixture()
    publishRelease(store)
    const input = entry("pending", "2026-01-01T00:00:00.000Z")
    store.saveEntry(input)
    const target = store.automation.inputs()[0]!
    const snapshot = store.reading.snapshot()
    expect(store.reading.page({ snapshotId: snapshot.id })).toMatchObject({
      view: "smart",
      total: 0,
      items: [],
    })
    expect(store.reading.page({ snapshotId: snapshot.id, view: "pending" })).toMatchObject({
      total: 1,
      items: [{ ordinal: 0, inputSeq: target.seq, state: "pending" }],
    })
    expect(store.reading.page({ snapshotId: snapshot.id, view: "all" })).toMatchObject({
      total: 1,
      items: [
        {
          kind: "entry",
          state: "pending",
          inputSeq: target.seq,
          status: "pending",
          decision: null,
        },
      ],
    })
    const assigned = store.automation.assign(target.seq)
    store.automation.complete(assigned, decision(input, assigned.seq))
    expect(store.reading.page({ snapshotId: snapshot.id, view: "all" })).toMatchObject({
      snapshot: { latestAvailable: true },
      items: [{ kind: "entry", state: "pending", decision: null }],
    })
    expect(store.reading.page({ snapshotId: snapshot.id, view: "pending" })).toMatchObject({
      snapshot: { latestAvailable: true },
      total: 1,
      items: [{ ordinal: 0, inputSeq: target.seq, state: "pending" }],
    })
    expect(store.reading.page({ snapshotId: snapshot.id })).toMatchObject({ total: 0, items: [] })
    const refreshed = store.reading.refresh()
    expect(store.reading.page({ snapshotId: refreshed.id })).toMatchObject({
      view: "smart",
      total: 1,
      items: [{ kind: "entry", state: "ready", inputSeq: target.seq }],
    })
    expect(store.reading.page({ snapshotId: refreshed.id, view: "all" }).items).toEqual([
      expect.objectContaining({ kind: "entry", state: "ready", inputSeq: target.seq }),
    ])
  })

  it("首次固定顺序与总数，迟到发布只报告可刷新而不跳位", () => {
    const store = fixture()
    publishRelease(store)
    const first = publishInput(store, entry("one", "2026-01-01T00:00:00.000Z"))
    const snapshot = processingApi(store, "GET", "/reading-snapshot", {}) as {
      snapshot: { id: string; maxSeq: number; latestAvailable: boolean }
    }
    const original = processingApi(store, "POST", "/reading-snapshot", {
      snapshotId: snapshot.snapshot.id,
      view: "all",
      offset: 0,
      limit: 50,
    }) as { total: number; items: Array<{ inputSeq: number }> }
    expect(original).toMatchObject({ total: 1, items: [{ inputSeq: first.seq }] })

    publishInput(store, entry("late", "2026-01-02T00:00:00.000Z"))
    const stable = processingApi(store, "POST", "/reading-snapshot", {
      snapshotId: snapshot.snapshot.id,
      view: "all",
    }) as {
      snapshot: { latestAvailable: boolean }
      total: number
      items: Array<{ inputSeq: number }>
    }
    expect(stable).toMatchObject({
      snapshot: { latestAvailable: true },
      total: 1,
      items: [{ inputSeq: first.seq }],
    })
    expect(processingApi(store, "POST", "/reading-snapshot/refresh", {})).toMatchObject({
      snapshot: { latestAvailable: false, maxSeq: 2 },
    })
  })

  it("新快照遵循保存的来源和历史边界，计划变化不改旧快照成员", () => {
    const store = fixture()
    const otherSource = { ...source, key: "feed/f2", id: "f2", title: "其他来源" }
    store.replaceSources([source, otherSource])
    publishRelease(store)
    const before = entry("before", "2026-01-01T23:59:59.999Z")
    const boundary = entry("boundary", "2026-01-02T00:00:00.000Z")
    const after = entry("after", "2026-01-03T00:00:00.000Z")
    const outside = {
      ...entry("outside", "2026-01-03T00:00:00.000Z"),
      sourceKey: otherSource.key,
    }
    for (const item of [before, boundary, after, outside]) store.saveEntry(item)
    store.schedule.save(
      {
        sourceKeys: [source.key],
        historySince: "2026-01-02T00:00:00.000Z",
        timeZone: "Asia/Shanghai",
        enabled: false,
      },
      0,
    )

    const scoped = store.reading.refresh()
    expect(
      store.reading
        .page({ snapshotId: scoped.id, view: "all" })
        .items.flatMap((item) => (item.kind === "entry" ? [item.inputSeq] : [])),
    ).toEqual([3, 2])

    store.schedule.save(
      {
        sourceKeys: [source.key, otherSource.key],
        historySince: "2026-01-01T00:00:00.000Z",
        timeZone: "Asia/Shanghai",
        enabled: false,
      },
      1,
    )
    expect(
      store.reading
        .page({ snapshotId: scoped.id, view: "all" })
        .items.flatMap((item) => (item.kind === "entry" ? [item.inputSeq] : [])),
    ).toEqual([3, 2])
    expect(store.reading.page({ snapshotId: store.reading.refresh().id, view: "all" }).total).toBe(
      4,
    )
  })

  it("正文版本变化后旧决定显示 repairing，不返回旧摘要", () => {
    const store = fixture()
    publishRelease(store)
    const original = entry("one", "2026-01-01T00:00:00.000Z")
    const target = publishInput(store, original)
    const snapshot = store.reading.snapshot()
    store.saveEntry({ ...original, content: "来源 one 的更新正文。" })

    const page = store.reading.page({ snapshotId: snapshot.id, view: "all" })
    expect(page.items).toEqual([
      expect.objectContaining({ kind: "entry", state: "repairing", inputSeq: target.seq }),
    ])
    expect(JSON.stringify(page.items)).not.toContain("摘要")
  })

  it("材料撤回立即让 Story 快照和本地研究包停止提供旧正文", () => {
    const store = fixture()
    publishRelease(store)
    const first = publishInput(store, entry("one", "2026-01-01T00:00:00.000Z"), true)
    const second = publishInput(store, entry("two", "2026-01-02T00:00:00.000Z"))
    const storyId = randomUUID()
    const members = [first, second]
    const spans = members.map((target) => ({
      id: `span-${target.seq}`,
      inputSeq: target.seq,
      sourceItemId: target.itemId,
      contentVersion: target.contentVersion,
      fragmentId: sourceSpanFragmentId(
        target.itemId,
        target.contentVersion,
        `来源 ${target.itemId} 的可核查事实。`,
      ),
      quote: `来源 ${target.itemId} 的可核查事实。`,
      sourceRole: "reporting",
    }))
    store.stories.create(
      {
        title: "事件综述",
        body: "可读取的综述正文",
        aggregationRuleId: "rule",
        aggregationScopeVersion: "scope",
        appliedRuleSetVersion: 1,
        instructionFingerprint: "instruction",
        members: members.map((target) => ({
          inputSeq: target.seq,
          decisionId: store.processingState
            .published()
            .find((value) => value.input.seq === target.seq)!.decisionId,
        })),
        sourceSpans: spans,
        citations: spans.map((span) => ({
          id: `citation-${span.inputSeq}`,
          sourceSpanId: span.id,
          sentenceId: `sentence-${span.inputSeq}`,
        })),
        sentences: spans.map((span) => ({
          id: `sentence-${span.inputSeq}`,
          text: `事实 ${span.inputSeq}`,
          citationIds: [`citation-${span.inputSeq}`],
        })),
        facts: [
          {
            id: "fact",
            kind: "fact",
            text: "来源支持的事实",
            citationIds: spans.map((span) => `citation-${span.inputSeq}`),
            dependsOnFactIds: [],
          },
        ],
      },
      storyId,
    )
    const snapshot = store.reading.refresh()
    expect(store.reading.page({ snapshotId: snapshot.id, view: "stories" }).items).toEqual([
      expect.objectContaining({ kind: "story", state: "ready", body: "可读取的综述正文" }),
    ])
    // 明确保留原始公告时，即使已生成 Story，也继续提供独立入口。
    expect(store.reading.page({ snapshotId: snapshot.id, view: "standalone" }).items).toEqual([
      expect.objectContaining({ kind: "entry", inputSeq: first.seq }),
    ])
    expect(store.reading.page({ snapshotId: snapshot.id, view: "smart" }).items).toEqual([
      expect.objectContaining({
        kind: "story",
        state: "ready",
        story: expect.objectContaining({ id: storyId }),
      }),
      expect.objectContaining({ kind: "entry", state: "ready", inputSeq: first.seq }),
    ])
    const researchPack = processingApi(store, "GET", `/research-pack/${storyId}`, {}) as {
      references: unknown[]
    }
    expect(researchPack).toMatchObject({
      status: "ready",
      storyId,
      revision: 1,
      title: "事件综述",
      markdown: expect.stringContaining("## 来源"),
    })
    expect(researchPack.references).toEqual(
      expect.arrayContaining([expect.objectContaining({ inputSeq: first.seq })]),
    )
    store.stories.withdrawMaterial(first.seq, "原始材料撤回")
    const page = store.reading.page({ snapshotId: snapshot.id, view: "stories" })
    expect(page.items).toEqual([
      expect.objectContaining({ kind: "story", state: "repairing", storyId }),
    ])
    expect(JSON.stringify(page.items)).not.toContain("可读取的综述正文")
    expect(store.reading.researchPack(storyId)).toEqual({
      status: "repairing",
      storyId,
      revision: null,
      title: null,
      markdown: null,
      references: [],
    })
  })

  // 综述摘要（GET /processing/stories/:storyId/digest）：时间线就地读综述的数据源，
  // §6 场景二要求来源数 ≥2、可看到句段引用与更新时间，这里逐项钉住。
  it("综述摘要给出来源数、逐句引用与更新时间", () => {
    const store = fixture()
    const otherSource = { ...source, key: "feed/f2", id: "f2", title: "其他来源" }
    store.replaceSources([source, otherSource])
    publishRelease(store)
    const first = publishDecision(store, entry("one", "2026-01-01T00:00:00.000Z"))
    const second = publishDecision(store, entry("two", "2026-01-02T00:00:00.000Z"))
    const storyId = createAggregateStory(store, [first, second], "同事件综述")

    const digest = processingApi(store, "GET", `/processing/stories/${storyId}/digest`, {}) as {
      status: string
      sourceCount: number
      sentences: Array<{ citations: Array<{ quote: string; sourceTitle: string }> }>
      sources: unknown[]
      updatedAt: string | null
      revision: number | null
      uncitedSentenceCount: number
      body: string
    }

    expect(digest.status).toBe("ready")
    expect(digest.sourceCount).toBeGreaterThanOrEqual(2)
    expect(digest.sources).toHaveLength(2)
    expect(digest.body).toContain("同事件综述")
    expect(digest.updatedAt).not.toBeNull()
    expect(digest.revision).toBe(1)
    // 每句都带可核查的连续原文，前端才能显示句段引用。
    expect(digest.sentences).toHaveLength(2)
    for (const sentence of digest.sentences) {
      expect(sentence.citations).toHaveLength(1)
      expect(sentence.citations[0]!.quote).toContain("可核查事实")
      expect(sentence.citations[0]!.sourceTitle).toBeTruthy()
    }
    expect(digest.uncitedSentenceCount).toBe(0)
  })

  it("不存在的综述返回 missing，而不是抛错或返回别篇", () => {
    const store = fixture()
    publishRelease(store)

    expect(
      processingApi(store, "GET", `/processing/stories/${randomUUID()}/digest`, {}),
    ).toMatchObject({ status: "missing", revision: null, sourceCount: 0, sentences: [] })
  })
})

// 生成源复用实际发布决定和 StoryStore，验证跨范围可达性、稳定分页与独立回执。
describe("私人事件综述投影", () => {
  function generatedPage(store: Store, query: Record<string, unknown> = {}) {
    return processingApi(
      store,
      "POST",
      "/processing/generated-feed/items",
      query,
    ) as GeneratedFeedPage
  }

  it("返回私人生成源且一事件一条目；材料计数不依赖客户端已加载原文", () => {
    const store = fixture()
    publishRelease(store)
    const first = publishInput(store, entry("one", "2026-01-01T00:00:00.000Z"))
    const second = publishInput(store, entry("two", "2026-01-02T00:00:00.000Z"))
    const id = createAggregateStory(store, [first, second], "AI 发布")
    expect(processingApi(store, "GET", "/processing/generated-feeds", {})).toEqual({
      feeds: [{ id: "generated:events", origin: "generated", title: "事件综述", private: true }],
    })
    expect(generatedPage(store).items).toEqual([
      expect.objectContaining({
        id,
        storyId: id,
        kind: "story",
        origin: "generated",
        materialCount: 2,
        read: false,
      }),
    ])
    expect(generatedPage(store, { search: "无匹配" }).total).toBe(0)
    expect(generatedPage(store, { search: "AI 发布" }).total).toBe(1)
  })

  it("服务端统一排序分页，后台新结果只提示而不插入冻结列表", () => {
    const store = fixture()
    publishRelease(store)
    publishInput(store, entry("one", "2026-01-01T00:00:00.000Z"))
    publishInput(store, entry("two", "2026-01-02T00:00:00.000Z"))
    const first = generatedPage(store, { mode: "smart", limit: 1 })
    expect(first.items.map((item) => item.id)).toEqual(["two"])
    publishInput(store, entry("new", "2026-01-03T00:00:00.000Z"))
    const next = generatedPage(store, { mode: "smart", limit: 1, cursor: first.nextCursor })
    expect(next.items.map((item) => item.id)).toEqual(["one"])
    expect(next.latestAvailable).toBe(true)
    expect(next.nextCursor).toBeNull()
    expect(
      generatedPage(store, { mode: "smart", refresh: true }).items.map((item) => item.id),
    ).toEqual(["new", "two", "one"])
    expect(() => generatedPage(store, { mode: "stories", cursor: first.nextCursor })).toThrow(
      "invalid_pagination",
    )
  })

  it("后台新决定即使 hide 也不撤掉冻结行，人工 hide 即时撤掉", () => {
    const store = fixture()
    publishRelease(store)
    const original = entry("one", "2026-01-01T00:00:00.000Z")
    const input = publishInput(store, original)
    const page = generatedPage(store, { mode: "smart" })
    const decisionId = page.items[0]!.kind === "entry" ? page.items[0]!.decisionId : null
    store.automation.invalidateSources(["feed/f1"])
    const fresh = store.automation.assign(input.seq)
    store.automation.complete(fresh, { ...decision(original, input.seq), status: "hide" })
    const unchanged = generatedPage(store, { mode: "smart", snapshotId: page.snapshotId })
    expect(unchanged.items[0]).toMatchObject({ id: "one", decisionId })
    expect(unchanged.latestAvailable).toBe(true)
    store.processingState.setOverride(input.seq, "hide", 0)
    expect(generatedPage(store, { mode: "smart", snapshotId: page.snapshotId }).items).toEqual([])
  })

  it("全部和分类有本范围 Story 才折叠；单来源保留关联原文且搜索无入口时不隐藏", () => {
    const store = fixture()
    store.replaceSources([
      { ...source, category: "AI" },
      { ...source, key: "feed/f2", id: "f2", category: "其他" },
    ])
    publishRelease(store)
    const first = publishInput(store, entry("one", "2026-01-01T00:00:00.000Z"))
    // 测试引用 helper 以 itemId 还原摘引，跨来源不修改正文。
    const second = publishInput(store, {
      ...entry("two", "2026-01-02T00:00:00.000Z"),
      sourceKey: "feed/f2",
    })
    const id = createAggregateStory(store, [first, second], "事件")
    expect(generatedPage(store, { mode: "smart" }).items.map((item) => item.id)).toEqual([id])
    expect(
      generatedPage(store, { mode: "smart", category: { view: 0, name: "AI" } }).items.map(
        (item) => item.id,
      ),
    ).toEqual([id])
    const sourcePage = generatedPage(store, { mode: "smart", sourceKeys: ["feed/f1"] })
    expect(sourcePage.items.map((item) => item.id)).toEqual([id, "one"])
    expect(sourcePage.items.find((item) => item.kind === "entry")).toMatchObject({ storyIds: [id] })
    expect(
      generatedPage(store, { mode: "smart", search: "来源 one" }).items.map((item) => item.id),
    ).toEqual(["one"])
  })

  it("普通 view 包含 List-only 和 Inbox，隔离其他视图与未知来源", () => {
    const store = fixture()
    const sources = [
      source,
      { ...source, key: "list/l1", kind: "list" as const, id: "l1" },
      { ...source, key: "inbox/i1", kind: "inbox" as const, id: "i1" },
      { ...source, key: "feed/f2", id: "f2", view: 1 },
    ]
    store.replaceSources(sources)
    publishRelease(store)
    publishInput(store, entry("feed", "2026-01-01T00:00:00.000Z"))
    publishInput(store, { ...entry("list-only", "2026-01-02T00:00:00.000Z"), sourceKey: "list/l1" })
    publishInput(store, {
      ...entry("inbox-only", "2026-01-03T00:00:00.000Z"),
      sourceKey: "inbox/i1",
    })
    publishInput(store, {
      ...entry("other-view", "2026-01-04T00:00:00.000Z"),
      sourceKey: "feed/f2",
    })
    publishInput(store, {
      ...entry("unknown", "2026-01-05T00:00:00.000Z"),
      sourceKey: "feed/unknown",
    })
    const page = generatedPage(store, { mode: "smart", view: 0, limit: 1 })
    expect(page.total).toBe(3)
    expect(page.items.map((item) => item.id)).toEqual(["inbox-only"])
    expect(generatedPage(store, { mode: "smart", view: 1 }).items.map((item) => item.id)).toEqual([
      "other-view",
    ])
    expect(
      generatedPage(store, { mode: "smart", view: "all" }).items.map((item) => item.id),
    ).toEqual(["other-view", "inbox-only", "list-only", "feed"])
    expect(() => generatedPage(store, { mode: "smart", view: 1, cursor: page.nextCursor })).toThrow(
      "invalid_pagination",
    )
    // 分页仍按初始视图名单和排序读取，不会把后续同步的新来源插到当前页。
    store.replaceSources([...sources, { ...source, key: "list/new", kind: "list", id: "new" }])
    publishInput(store, { ...entry("new-list", "2026-01-06T00:00:00.000Z"), sourceKey: "list/new" })
    const next = generatedPage(store, { mode: "smart", view: 0, cursor: page.nextCursor, limit: 5 })
    expect(next.items.map((item) => item.id)).toEqual(["list-only", "feed"])
    expect(next.latestAvailable).toBe(true)
    expect(
      generatedPage(store, { mode: "smart", view: 0, refresh: true }).items.map((item) => item.id),
    ).toEqual(["new-list", "inbox-only", "list-only", "feed"])
  })

  it("分类与固定来源优先于普通 view，局部 Story 可达才折叠", () => {
    const store = fixture()
    store.replaceSources([
      { ...source, category: "AI" },
      { ...source, key: "list/l1", kind: "list", id: "l1", view: 1, category: "其他" },
    ])
    publishRelease(store)
    const first = publishInput(store, entry("feed", "2026-01-01T00:00:00.000Z"))
    const second = publishInput(store, {
      ...entry("list-only", "2026-01-02T00:00:00.000Z"),
      sourceKey: "list/l1",
    })
    const id = createAggregateStory(store, [first, second], "跨视图事件")
    expect(generatedPage(store, { mode: "smart", view: 0 }).items.map((item) => item.id)).toEqual([
      id,
    ])
    expect(generatedPage(store, { mode: "smart", view: 1 }).items.map((item) => item.id)).toEqual([
      id,
    ])
    expect(
      generatedPage(store, { mode: "smart", view: 1, category: { view: 0, name: "AI" } }).items.map(
        (item) => item.id,
      ),
    ).toEqual([id])
    expect(
      generatedPage(store, { mode: "smart", view: 0, sourceKeys: ["list/l1"] }).items.map(
        (item) => item.id,
      ),
    ).toEqual([id, "list-only"])
    expect(
      generatedPage(store, {
        mode: "smart",
        view: 0,
        sourceKeys: ["list/l1"],
        search: "来源 list-only",
      }).items.map((item) => item.id),
    ).toEqual(["list-only"])
  })

  it("人工隐藏和恢复立即作用于冻结候选，撤回的 Story 不再可读", () => {
    const store = fixture()
    publishRelease(store)
    const first = publishDecision(store, entry("one", "2026-01-01T00:00:00.000Z"), {
      status: "hide",
    })
    const second = publishInput(store, entry("two", "2026-01-02T00:00:00.000Z"))
    const page = generatedPage(store, { mode: "smart" })
    expect(page.items.map((item) => item.id)).toEqual(["two"])
    store.processingState.setOverride(first.seq, "restore", 0)
    store.processingState.setOverride(second.seq, "hide", 0)
    expect(
      generatedPage(store, { mode: "smart", snapshotId: page.snapshotId }).items.map(
        (item) => item.id,
      ),
    ).toEqual(["one"])
    store.processingState.setOverride(second.seq, "automatic", 1)
    const id = createAggregateStory(store, [first, second], "待撤回事件")
    const stories = generatedPage(store, { refresh: true })
    expect(stories.items.map((item) => item.id)).toEqual([id])
    store.stories.withdrawMaterial(first.seq, "来源失效")
    expect(generatedPage(store, { snapshotId: stories.snapshotId }).items).toEqual([])
  })

  it("摘要从账号已读版本累计三次事实更新，旧引用迁移不制造第四次变化", () => {
    const store = fixture()
    publishRelease(store)
    const first = publishInput(store, entry("one", "2026-01-01T00:00:00.000Z"))
    const second = publishInput(store, entry("two", "2026-01-02T00:00:00.000Z"))
    const id = createAggregateStory(store, [first, second], "事件")
    processingApi(store, "POST", `/processing/stories/${id}/reader-state`, {
      read: true,
      revision: 1,
    })
    const initial = store.stories.currentSnapshot(id)!
    store.stories.appendRevision(id, 1, {
      ...initial,
      facts: initial.facts.map((fact) => ({ ...fact, text: "修正后的事实" })),
    })
    const corrected = store.stories.currentSnapshot(id)!
    const counter = {
      id: "counter",
      kind: "source_claim" as const,
      text: "来源提出相反说法，仍待核实",
      citationIds: [initial.citations[0]!.id],
      dependsOnFactIds: [],
    }
    store.stories.appendRevision(id, 2, { ...corrected, facts: [...corrected.facts, counter] })
    store.stories.appendRevision(id, 3, { ...corrected, facts: [counter] })
    const final = store.stories.currentSnapshot(id)!
    store.stories.appendRevision(id, 4, { ...final, body: "仅调整展示" })
    const digest = store.reading.storyDigest(id)
    expect(digest.status).toBe("ready")
    if (digest.status !== "ready") throw new Error("digest missing")
    expect(digest.readDelta).toMatchObject({
      scope: "since_read",
      fromRevision: 1,
      toRevision: 5,
      substantiveUpdateCount: 3,
    })
    expect(digest.readDelta.added).toEqual([
      expect.objectContaining({
        text: counter.text,
        kind: "source_claim",
        citations: [
          expect.objectContaining({ quote: expect.any(String), sourceUrl: expect.any(String) }),
        ],
      }),
    ])
    expect(digest.readDelta.removed).toHaveLength(initial.facts.length)
    expect(store.stories.readStatus(id, store.ownerId!).unread).toBe(true)
    expect(store.reading.storyDigest(id, 1)).toMatchObject({
      readDelta: {
        scope: "up_to_date",
        toRevision: 1,
        currentRevision: 5,
        substantiveUpdateCount: 0,
      },
    })
  })

  it("累计变化保留历史移除事实，但不会重新展示已撤回材料的引用", () => {
    const store = fixture()
    publishRelease(store)
    const materials = ["one", "two", "three"].map((name) =>
      publishInput(store, entry(name, "2026-01-01T00:00:00.000Z")),
    )
    const id = createAggregateStory(store, materials, "事件")
    processingApi(store, "POST", `/processing/stories/${id}/reader-state`, {
      read: true,
      revision: 1,
    })
    const initial = store.stories.currentSnapshot(id)!
    const sourceSpans = initial.sourceSpans.filter((span) => span.inputSeq !== materials[0]!.seq)
    const citations = initial.citations.filter((citation) =>
      sourceSpans.some((span) => span.id === citation.sourceSpanId),
    )
    store.stories.appendRevision(id, 1, {
      ...initial,
      members: initial.members.filter((member) => member.inputSeq !== materials[0]!.seq),
      sourceSpans,
      citations,
      sentences: initial.sentences.filter((sentence) =>
        citations.some((citation) => citation.sentenceId === sentence.id),
      ),
      facts: initial.facts.map((fact) => ({
        ...fact,
        text: "来源已修正事实",
        citationIds: citations.map((citation) => citation.id),
      })),
    })
    store.stories.withdrawMaterial(materials[0]!.seq, "旧材料撤回")
    const digest = store.reading.storyDigest(id)
    expect(digest.status).toBe("ready")
    if (digest.status !== "ready") throw new Error("digest missing")
    expect(digest.readDelta.revised[0]!.before.citations).toHaveLength(2)
    expect(
      digest.readDelta.revised[0]!.before.citations.map((citation) => citation.id),
    ).not.toContain(initial.citations[0]!.id)
    expect(digest.readDelta.revised[0]!.before.text).toBe("来源支持的事实")
  })

  it("综述读态收藏独立，纯引用版本不制造未读，事实改变提示重要更新", () => {
    const store = fixture()
    publishRelease(store)
    const first = publishInput(store, entry("one", "2026-01-01T00:00:00.000Z"))
    const second = publishInput(store, entry("two", "2026-01-02T00:00:00.000Z"))
    const id = createAggregateStory(store, [first, second], "事件")
    processingApi(store, "POST", `/processing/stories/${id}/reader-state`, {
      read: true,
      collected: true,
      revision: 1,
    })
    expect(store.entry("feed/f1", "one")?.read).toBe(false)
    expect(generatedPage(store, { collectedOnly: true }).items[0]).toMatchObject({
      read: true,
      collected: true,
    })
    expect(generatedPage(store, { unreadOnly: true }).items).toEqual([])
    const revision = store.stories.currentSnapshot(id)!
    store.stories.appendRevision(id, 1, {
      ...revision,
      title: "事件措辞调整",
      body: "展示调整",
      instructionFingerprint: "新版指令",
    })
    expect(generatedPage(store, { refresh: true }).items[0]).toMatchObject({
      revision: 2,
      read: true,
      hasImportantUpdate: false,
    })
    expect(
      processingApi(store, "POST", `/processing/stories/${id}/digest`, { revision: 1 }),
    ).toMatchObject({ revision: 1, title: "事件", body: revision.body })
    expect(processingApi(store, "GET", `/processing/stories/${id}/reader-state`, {})).toMatchObject(
      { read: true, collected: true, link: { kind: "current", revision: { revision: 2 } } },
    )
    store.stories.appendRevision(id, 2, {
      ...revision,
      facts: revision.facts.map((fact) => ({ ...fact, text: "参与截止时间已提前" })),
    })
    expect(generatedPage(store, { refresh: true }).items[0]).toMatchObject({
      revision: 3,
      read: false,
      hasImportantUpdate: true,
      collected: true,
    })
    processingApi(store, "POST", `/processing/stories/${id}/reader-state`, {
      read: false,
      collected: false,
    })
    expect(generatedPage(store, { refresh: true }).items[0]).toMatchObject({
      read: false,
      collected: false,
    })
  })
})

it("周报分事件贡献不代表全篇覆盖，原文在时间线、智能阅读和去重输入中仍独立", () => {
  const store = fixture()
  publishRelease(store)
  const original = {
    ...entry("weekly", "2026-01-01T00:00:00Z"),
    content: "Acme released Widget 2.0.\nBeta released Tool 3.0.",
  }
  store.saveEntry(original)
  const first = store.automation.assign(store.automation.inputs().at(-1)!.seq)
  const event = (quote: string, subject: string, object: string, version: string) => ({
    kind: "event" as const,
    subject: { value: subject, quote },
    action: { value: "product_release" as const, quote },
    object: { value: object, quote },
    version: { value: version, quote },
    round: null,
    anchor: null,
  })
  const texts = original.content.split("\n")
  const semantic = {
    entryId: original.id,
    title: original.title,
    summary: "并列周报",
    disposition: "keep" as const,
    reason: "两个事件",
    aggregation: true,
    rewrite: true,
    labels: [],
    event: null,
    facts: [],
    eventMentions: [
      {
        identity: event(texts[0]!, "Acme", "Widget", "2.0"),
        role: "reports" as const,
        isPrimary: false,
      },
      {
        identity: event(texts[1]!, "Beta", "Tool", "3.0"),
        role: "reports" as const,
        isPrimary: false,
      },
    ],
  }
  store.automation.complete(first, {
    ...decision(original, first.seq),
    semantic,
    facts: texts.map((quote, eventMentionIndex) => ({
      text: quote,
      quote,
      kind: "fact" as const,
      eventMentionIndex,
    })),
  })
  const second = publishInput(store, entry("other", "2026-01-02T00:00:00Z"))
  const storyId = createAggregateStory(store, [first, second], "部分事实综述")
  expect(store.reading.representedInputSeqs()).toEqual(new Set([second.seq]))
  expect(rolesOf(store).some((role) => role.itemId === "weekly")).toBe(false)
  const generated = store.reading.generatedPage(generatedFeedQuerySchema.parse({ mode: "smart" }))
  expect(generated.items).toContainEqual(expect.objectContaining({ kind: "entry", id: "weekly" }))
  expect(generated.items).toContainEqual(expect.objectContaining({ kind: "story", id: storyId }))
  const page = store.reading.page({ snapshotId: store.reading.snapshot().id, view: "smart" })
  expect(page.items).toContainEqual(expect.objectContaining({ kind: "entry", inputSeq: first.seq }))
  expect(store.entry(original.sourceKey, original.id)?.read).toBe(false)
})
