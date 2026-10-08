import { randomUUID } from "node:crypto"

import type { RuleSet, TagAssessment } from "@follow/information-core"
import { afterEach, describe, expect, it, vi } from "vitest"

import { runCodexJson } from "./codex"
import type { SourceEntry } from "./folo"
import { processingApi } from "./processing-api"
import type { EntryModelOutput, ProcessingDecision } from "./processing-decision"
import { processingSemanticApi } from "./processing-semantic-api"
import { createSemanticProfile, projectSemanticDecision } from "./processing-semantic-decision"
import { Store } from "./store"

vi.mock("./codex", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./codex")>()),
  runCodexJson: vi.fn(() => {
    throw new Error("unexpected_model_call")
  }),
}))

const stores: Store[] = []

// 列表标签复用当前语义投影，不能从自由文本 labels 或旧正文推断。
it("条目批量索引只返回当前 present 标签，并随人工纠错更新", () => {
  const { store } = fixture()
  const { input } = complete(store)
  const index = () =>
    processingApi(store, "GET", "/processing/entry-results", undefined) as {
      results: Array<{ semanticTags?: string[] }>
    }
  expect(index().results[0]?.semanticTags).toEqual(["signal:social_chatter"])
  processingSemanticApi(store, "POST", `/processing/entries/${input.seq}/semantic-overrides`, {
    requestId: randomUUID(),
    expectedContentVersion: input.contentVersion,
    expectedRevision: 0,
    changes: [
      { tagId: "signal:social_chatter", state: "absent" },
      { tagId: "topic:ai", state: "present" },
    ],
  })
  expect(index().results[0]?.semanticTags).toEqual(["topic:ai"])
  store.saveEntry({ ...entry, content: "A new version" })
  expect(index().results).toEqual([])
})
const source = {
  key: "feed/f1",
  kind: "feed" as const,
  id: "f1",
  title: "Source",
  view: 0,
  category: null,
}
const source2 = { ...source, key: "feed/f2", id: "f2" }
const entry: SourceEntry = {
  id: "entry1",
  sourceKey: source.key,
  title: "Original title",
  content: "Original source evidence",
  description: null,
  url: "https://example.test/entry1",
  publishedAt: "2026-01-01T00:00:00.000Z",
  read: true,
  collected: true,
}
function publish(store: Store, config: RuleSet) {
  const revision = store.automation.draft().revision
  store.automation.saveDraft(config, revision)
  return store.automation.publish(revision + 1, { mode: "future" }, randomUUID())
}
function fixture() {
  const store = new Store(":memory:")
  stores.push(store)
  store.bindOwner("owner")
  store.replaceSources([source, source2])
  const config: RuleSet = {
    ...store.automation.draft().config,
    formatVersion: 5,
    rules: [
      {
        id: "noise",
        ownerId: "owner",
        name: "Noise filter",
        enabled: true,
        executionLocation: "processing_service",
        order: 0,
        version: 1,
        when: {
          anyOf: [
            {
              allOf: [
                { field: "source_id", operator: "in", value: [source.key] },
                { field: "entry_tag", operator: "contains_any", value: ["signal:social_chatter"] },
              ],
            },
          ],
        },
        actions: [{ type: "reading_decision", visibility: "hide", aggregationEligibility: "deny" }],
      },
    ],
  }
  publish(store, config)
  return { store, config }
}
function complete(store: Store, body = entry, state: TagAssessment["state"] = "present") {
  store.saveEntry(body)
  const saved = store.automation
    .inputs()
    .find(
      (input) => input.itemId === body.id && input.sourceKey === body.sourceKey && input.current,
    )!
  const input = store.automation.assign(saved.seq)
  const assessments: TagAssessment[] = [
    {
      tagId: "signal:social_chatter",
      state,
      confidence: state === "unknown" ? null : 0.95,
      definitionVersion: 1,
      reason: "Original chatter assessment",
      evidenceIds: ["e1"],
    },
    {
      tagId: "topic:ai",
      state: "absent",
      confidence: 0.9,
      definitionVersion: 1,
      reason: "No AI subject",
      evidenceIds: ["e1"],
    },
  ]
  const output: EntryModelOutput = {
    entryId: body.id,
    title: "Generated title",
    summary: "Original summary",
    reason: "Source reason",
    disposition: "keep",
    aggregation: true,
    rewrite: true,
    labels: [],
    facts: [],
    tagAssessments: assessments,
  }
  const decision: ProcessingDecision = {
    schemaVersion: 2,
    fingerprint: body.id,
    provider: "codex",
    model: "synthetic",
    generatedAt: body.publishedAt,
    durationMs: 1,
    usage: null,
    status: "keep",
    title: output.title,
    summary: output.summary,
    reason: output.reason,
    labels: [],
    policy: { standalone: "auto", aggregation: "allow", rewrite: "allow" },
    sourceRole: "reporting",
    context: {
      source_id: body.sourceKey,
      contextId: body.sourceKey,
      read: body.read,
      collected: body.collected,
    },
    facts: [],
    semantic: output,
    semanticProfile: createSemanticProfile({
      contentVersion: input.contentVersion,
      text: body.content!,
      output,
      evidence: { e1: body.content! },
    }),
    reused: false,
  }
  store.semantics.publish(
    input,
    projectSemanticDecision(
      decision,
      store.automation.release(input.releaseVersion!)!,
      decision.context,
    ),
  )
  return store.processingState.published([input.seq])[0]!
}
function correct(
  store: Store,
  inputSeq: number,
  contentVersion: string,
  expectedRevision = 0,
  state: "absent" | "present" | "automatic" = "absent",
  requestId = randomUUID(),
) {
  return processingSemanticApi(
    store,
    "POST",
    `/processing/entries/${inputSeq}/semantic-overrides`,
    {
      expectedRevision,
      expectedContentVersion: contentVersion,
      requestId,
      changes: [{ tagId: "signal:social_chatter", state }],
    },
  )
}
function target(published: ReturnType<typeof complete>) {
  return {
    inputSeq: published.input.seq,
    expectedContentVersion: published.input.contentVersion,
    expectedDecisionId: published.decisionId,
    expectedGeneration: published.input.generation,
  }
}

afterEach(() => {
  stores.splice(0).forEach((store) => store.close())
  expect(runCodexJson).not.toHaveBeenCalled()
  vi.clearAllMocks()
})

describe("semantic processing API", () => {
  it("非本路由交还主API，标签定义要求账号且返回稳定定义", () => {
    const store = new Store(":memory:")
    stores.push(store)
    expect(processingSemanticApi(store, "GET", "/processing/entries", {})).toBeUndefined()
    expect(() => processingSemanticApi(store, "GET", "/processing/semantic-tags", {})).toThrow(
      "owner_required",
    )
    store.bindOwner("owner")
    expect(processingSemanticApi(store, "GET", "/processing/semantic-tags", {})).toMatchObject({
      definitions: expect.arrayContaining([
        expect.objectContaining({ id: "signal:social_chatter", definitionVersion: 1 }),
      ]),
    })
  })

  it("纠正单字段只更改覆盖层和阅读投影，保留原画像、证据、已读与收藏", () => {
    const { store } = fixture()
    const previous = complete(store)
    const originalProfile = structuredClone(previous.decision.semanticProfile)
    const invalidate = vi.spyOn(store.stories, "invalidateInputs")
    const result = correct(store, previous.input.seq, previous.input.contentVersion)
    expect(result).toMatchObject({
      profile: originalProfile,
      overrideRevision: 1,
      assessments: [
        expect.objectContaining({ tagId: "signal:social_chatter", state: "absent" }),
        expect.objectContaining({ tagId: "topic:ai", state: "absent", reason: "No AI subject" }),
      ],
    })
    const current = store.processingState.published([previous.input.seq])[0]!
    expect(current.decisionId).not.toBe(previous.decisionId)
    expect(current.decision.status).toBe("keep")
    expect(current.decision.semanticProfile).toEqual(originalProfile)
    expect(current.input.releaseVersion).toBe(previous.input.releaseVersion)
    expect(store.entry(entry.sourceKey, entry.id)).toMatchObject({ read: true, collected: true })
    expect(invalidate).toHaveBeenCalledWith([previous.input.seq])
  })

  it("恢复自动判断、请求幂等、修订冲突和旧正文校验", () => {
    const { store } = fixture()
    const previous = complete(store)
    const requestId = randomUUID()
    const first = correct(
      store,
      previous.input.seq,
      previous.input.contentVersion,
      0,
      "absent",
      requestId,
    )
    const generation = store.processingState.published([previous.input.seq])[0]!.input.generation
    expect(
      correct(store, previous.input.seq, previous.input.contentVersion, 0, "absent", requestId),
    ).toEqual(first)
    expect(store.processingState.published([previous.input.seq])[0]!.input.generation).toBe(
      generation,
    )
    expect(() => correct(store, previous.input.seq, previous.input.contentVersion)).toThrow(
      "revision_conflict",
    )
    expect(() => correct(store, previous.input.seq, "old-version", 1)).toThrow("revision_conflict")
    correct(store, previous.input.seq, previous.input.contentVersion, 1, "automatic")
    expect(store.processingState.published([previous.input.seq])[0]!.decision.status).toBe("hide")
  })

  it("原版本规则处理纠错并保留当前展示人工覆盖", () => {
    const { store, config } = fixture()
    const previous = complete(store)
    publish(store, {
      ...config,
      rules: [
        {
          ...config.rules[0]!,
          when: { all: true },
          actions: [{ type: "reading_decision", visibility: "hide" }],
        },
      ],
    })
    store.processingState.setOverride(previous.input.seq, "restore", 0)
    correct(store, previous.input.seq, previous.input.contentVersion)
    const current = store.processingState.published([previous.input.seq])[0]!
    expect(current.input.releaseVersion).toBe(1)
    expect(current.decision.status).toBe("keep")
    expect(current.decision.policy).toMatchObject({ standalone: "always", aggregation: "deny" })
  })

  it("查询在筛选和分页前排除撤回资料，未知独立计数且来源变更使旧快照失效", () => {
    const { store } = fixture()
    const chatter = complete(store)
    const unknown = complete(
      store,
      { ...entry, id: "unknown", publishedAt: "2026-01-02T00:00:00.000Z" },
      "unknown",
    )
    const query = { includeTagIds: ["signal:social_chatter"], sourceKeys: [source.key], limit: 1 }
    const first = processingSemanticApi(store, "POST", "/processing/semantics/query", query)
    expect(first).toMatchObject({
      entries: [{ inputSeq: chatter.input.seq }],
      counts: { matched: 1, unknown: 1, indexed: 2, scopeTotal: 2 },
    })
    expect(
      processingSemanticApi(store, "POST", "/processing/semantics/query", {
        ...query,
        state: "unknown",
      }),
    ).toMatchObject({ entries: [{ inputSeq: unknown.input.seq }] })
    store.stories.withdrawMaterial(chatter.input.seq, "Withdraw source material")
    expect(
      processingSemanticApi(store, "POST", "/processing/semantics/query", query),
    ).toMatchObject({ entries: [], counts: { matched: 0, unknown: 1, indexed: 1, scopeTotal: 1 } })
    expect(() =>
      processingSemanticApi(store, "GET", `/processing/entries/${chatter.input.seq}/semantics`, {}),
    ).toThrow("invalid_target")
    expect(() => correct(store, chatter.input.seq, chatter.input.contentVersion)).toThrow(
      "invalid_target",
    )
    const snapshotId = (first as { snapshotId: string }).snapshotId
    expect(() =>
      processingSemanticApi(store, "POST", "/processing/semantics/query", { ...query, snapshotId }),
    ).toThrow("invalid_target")
    store.replaceSources([])
    expect(() =>
      processingSemanticApi(store, "GET", `/processing/entries/${unknown.input.seq}/semantics`, {}),
    ).toThrow("invalid_target")
    expect(() =>
      processingSemanticApi(store, "POST", "/processing/semantics/query", query),
    ).toThrow("invalid_target")
  })

  it("缺失画像维持空响应，旧正文、重复字段或未知标签不能纠错", () => {
    const { store } = fixture()
    store.saveEntry(entry)
    const input = store.automation.inputs()[0]!
    expect(
      processingSemanticApi(store, "GET", `/processing/entries/${input.seq}/semantics`, {}),
    ).toMatchObject({ profile: null, assessments: [], decisionId: null })
    expect(() => correct(store, input.seq, input.contentVersion)).toThrow("invalid_target")
    const previous = complete(store)
    const request = {
      expectedRevision: 0,
      expectedContentVersion: previous.input.contentVersion,
      requestId: randomUUID(),
      changes: [
        { tagId: "topic:ai", state: "absent" },
        { tagId: "topic:ai", state: "present" },
      ],
    }
    expect(() =>
      processingSemanticApi(
        store,
        "POST",
        `/processing/entries/${input.seq}/semantic-overrides`,
        request,
      ),
    ).toThrow()
    store.saveEntry({ ...entry, content: "New content version" })
    expect(() =>
      processingSemanticApi(
        store,
        "GET",
        `/processing/entries/${previous.input.seq}/semantics`,
        {},
      ),
    ).toThrow("invalid_target")
  })

  it("显式选定目标无模型重算到effective发布版，未选文章和原画像不变", () => {
    const { store, config } = fixture()
    const previous = complete(store)
    const unselected = complete(store, { ...entry, id: "unselected" })
    const originalProfile = structuredClone(previous.decision.semanticProfile)
    publish(store, {
      ...config,
      rules: [
        {
          ...config.rules[0]!,
          actions: [
            { type: "reading_decision", visibility: "show", aggregationEligibility: "allow" },
          ],
        },
      ],
    })
    expect(
      processingSemanticApi(store, "POST", "/processing/recompute-decisions", {
        ruleReleaseVersion: 2,
        targets: [target(previous)],
      }),
    ).toMatchObject({
      modelCalls: 0,
      decisions: [{ inputSeq: previous.input.seq, releaseVersion: 2 }],
    })
    const current = store.processingState.published([previous.input.seq])[0]!
    expect(current.decision.status).toBe("keep")
    expect(current.decision.semanticProfile).toEqual(originalProfile)
    expect(store.processingState.published([unselected.input.seq])[0]!.decisionId).toBe(
      unselected.decisionId,
    )
    expect(() =>
      processingSemanticApi(store, "POST", "/processing/recompute-decisions", {
        ruleReleaseVersion: 2,
        targets: [target(previous)],
      }),
    ).toThrow("revision_conflict")
  })

  it("重算拒绝非effective版、范围外或失效指针，整批失败不改任何目标", () => {
    const { store, config } = fixture()
    const previous = complete(store)
    const outside = complete(store, { ...entry, id: "outside", sourceKey: source2.key })
    publish(store, {
      ...config,
      rules: [{ ...config.rules[0]!, actions: [{ type: "reading_decision", visibility: "show" }] }],
    })
    expect(() =>
      processingSemanticApi(store, "POST", "/processing/recompute-decisions", {
        ruleReleaseVersion: 1,
        targets: [target(previous)],
      }),
    ).toThrow("revision_conflict")
    expect(() =>
      processingSemanticApi(store, "POST", "/processing/recompute-decisions", {
        ruleReleaseVersion: 2,
        targets: [target(previous), target(outside)],
      }),
    ).toThrow("invalid_target")
    expect(store.processingState.published([previous.input.seq])[0]!.decisionId).toBe(
      previous.decisionId,
    )
  })

  it("新transform、全局指令或语言需要明确重新处理，长度裁剪允许无模型更新", () => {
    for (const change of ["transform", "global", "language"] as const) {
      const { store, config } = fixture()
      const previous = complete(store)
      const next = structuredClone(config)
      if (change === "transform")
        next.rules[0]!.actions.push({ type: "ai_transform", prompt: "New material transformation" })
      if (change === "global") next.global.markdown = "Changed model analysis instructions"
      if (change === "language") next.rules[0]!.actions.push({ type: "display", language: "ja" })
      publish(store, next)
      expect(() =>
        processingSemanticApi(store, "POST", "/processing/recompute-decisions", {
          ruleReleaseVersion: 2,
          targets: [target(previous)],
        }),
      ).toThrow("invalid_target")
      expect(store.processingState.published([previous.input.seq])[0]!.decisionId).toBe(
        previous.decisionId,
      )
    }
    const { store, config } = fixture()
    const previous = complete(store)
    const next = structuredClone(config)
    next.rules[0]!.actions.push({ type: "display", summaryMaxGraphemes: 4 })
    publish(store, next)
    processingSemanticApi(store, "POST", "/processing/recompute-decisions", {
      ruleReleaseVersion: 2,
      targets: [target(previous)],
    })
    expect(store.processingState.published([previous.input.seq])[0]!.decision.summary).toBe("Orig")
  })

  it("无模型重算继续保留未知条件为待上下文，不推断不存在", () => {
    const { store, config } = fixture()
    const previous = complete(store, entry, "unknown")
    const next = structuredClone(config)
    next.rules[0]!.actions = [{ type: "reading_decision", visibility: "show" }]
    publish(store, next)
    processingSemanticApi(store, "POST", "/processing/recompute-decisions", {
      ruleReleaseVersion: 2,
      targets: [target(previous)],
    })
    const current = store.processingState.published([previous.input.seq])[0]!
    expect(current.decision.status).toBe("needs_context")
    expect(current.decision.semanticProfile?.assessments[0]!.state).toBe("unknown")
  })

  it("纠错移除特定transform恢复基础缓存，新匹配transform保持可见待重新处理", () => {
    for (const { newlyMatched, hasPointer } of [
      { newlyMatched: false, hasPointer: true },
      { newlyMatched: true, hasPointer: true },
      { newlyMatched: true, hasPointer: false },
    ]) {
      const { store, config } = fixture()
      const transformConfig = structuredClone(config)
      transformConfig.rules.push({
        ...transformConfig.rules[0]!,
        id: "tag-transform",
        order: 1,
        when: {
          anyOf: [
            {
              allOf: [
                {
                  field: "entry_tag",
                  operator: newlyMatched ? "not_contains_any" : "contains_any",
                  value: ["signal:social_chatter"],
                },
              ],
            },
          ],
        },
        actions: [{ type: "ai_transform", prompt: "Specific transform for this tag state" }],
      })
      publish(store, transformConfig)
      const previous = complete(store)
      const profile = structuredClone(previous.decision.semanticProfile!)
      store.processingState.saveCache({
        ...previous.decision,
        fingerprint: "base-analysis",
        summary: "Base summary",
        semanticProfile: { ...profile, contentVersion: "donor-version" },
        semantic: {
          ...previous.decision.semantic!,
          entryId: "donor-entry",
          summary: "Base summary",
        },
      })
      const decision = {
        ...previous.decision,
        fingerprint: newlyMatched ? "base-analysis" : "specific-transform",
        ...(hasPointer ? { analysisFingerprint: "base-analysis" } : {}),
        summary: newlyMatched ? "Base summary" : "Specific transformed summary",
        semantic: {
          ...previous.decision.semantic!,
          summary: newlyMatched ? "Base summary" : "Specific transformed summary",
        },
      }
      const result = store.automation.recalculate(previous.input, decision)
      store.semantics.index(result.input, decision, result.id)
      correct(store, previous.input.seq, previous.input.contentVersion)
      const current = store.processingState.published([previous.input.seq])[0]!
      expect(current.decision.summary).toBe("Base summary")
      expect(current.decision.semanticProfile).toEqual(profile)
      expect(current.decision.semantic?.entryId).toBe(entry.id)
      expect(store.semantics.view(current.input).assessments[0]!.state).toBe("absent")
      if (newlyMatched) {
        expect(current.decision).toMatchObject({
          status: "needs_context",
          policy: { standalone: "always", aggregation: "deny", rewrite: "deny" },
        })
        expect(current.decision.reason).toContain("尚未执行")
        // 后续单字段纠错仍不能把等待中的新transform声明为已执行。
        processingSemanticApi(
          store,
          "POST",
          `/processing/entries/${previous.input.seq}/semantic-overrides`,
          {
            expectedRevision: 1,
            expectedContentVersion: previous.input.contentVersion,
            requestId: randomUUID(),
            changes: [{ tagId: "topic:ai", state: "absent" }],
          },
        )
        expect(store.processingState.published([previous.input.seq])[0]!.decision.status).toBe(
          "needs_context",
        )
      } else expect(current.decision.status).toBe("keep")
    }
  })

  it("纠错回调失败同时回滚字段覆盖、修订、代际与索引", () => {
    const { store } = fixture()
    const previous = complete(store)
    const index = vi.spyOn(store.semantics, "index").mockImplementationOnce(() => {
      throw new Error("failed_index")
    })
    expect(() => correct(store, previous.input.seq, previous.input.contentVersion)).toThrow(
      "failed_index",
    )
    index.mockRestore()
    expect(store.semantics.view(previous.input)).toMatchObject({
      overrideRevision: 0,
      decisionId: previous.decisionId,
      assessments: [
        expect.objectContaining({ state: "present" }),
        expect.objectContaining({ tagId: "topic:ai" }),
      ],
    })
    expect(store.processingState.published([previous.input.seq])[0]!.input.generation).toBe(
      previous.input.generation,
    )
  })
})
