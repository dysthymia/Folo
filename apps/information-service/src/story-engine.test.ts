import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { DatabaseSync } from "node:sqlite"

import type { RuleSet } from "@follow/information-core"
import { afterEach, describe, expect, it } from "vitest"

import { AIConfigStore } from "./ai-config"
import type { ProcessingInput } from "./automation-store"
import type { CodexJsonOptions } from "./codex"
import type { PublishedDecision } from "./processing-decision"
import type { EventIdentity } from "./processing-event"
import type { SharedStoryGroup, StoryModelOutput } from "./story-engine"
import { runStoryAggregation, sharedStoryRuleFingerprint } from "./story-engine"
import { sourceSpanFragmentId, StoryStore } from "./story-store"

const databases: DatabaseSync[] = []
const directories: string[] = []

function fixture() {
  const db = new DatabaseSync(":memory:")
  databases.push(db)
  db.exec(`
    CREATE TABLE processing_inputs (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      source_key TEXT NOT NULL,
      item_id TEXT NOT NULL,
      content_version TEXT NOT NULL,
      body TEXT NOT NULL,
      received_at TEXT NOT NULL,
      release_version INTEGER,
      generation INTEGER NOT NULL,
      status TEXT NOT NULL,
      current INTEGER NOT NULL,
      decision_id TEXT
    );
    CREATE TABLE entry_decisions (
      id TEXT PRIMARY KEY,
      input_seq INTEGER NOT NULL,
      generation INTEGER NOT NULL,
      release_version INTEGER NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `)
  const directory = mkdtempSync(`${tmpdir()}/folo-story-engine-`)
  directories.push(directory)
  const configPath = `${directory}/ai.json`
  writeFileSync(configPath, JSON.stringify({ provider: "codex", model: "test-model" }))
  return {
    db,
    stories: new StoryStore(db),
    aiConfig: new AIConfigStore(configPath),
    runtimeDir: directory,
    configPath,
  }
}

function input(seq: number): ProcessingInput {
  const body = {
    id: `entry-${seq}`,
    sourceKey: `feed/${seq}`,
    title: `来源 ${seq}`,
    url: `https://example.test/${seq}`,
    publishedAt: "2026-09-12T00:00:00.000Z",
    read: false,
    content: `<p>来源 ${seq} 的可核查事实。</p>`,
    description: null,
  }
  return {
    seq,
    sourceKey: body.sourceKey,
    itemId: body.id,
    contentVersion: `version-${seq}`,
    receivedAt: "2026-09-12T00:00:00.000Z",
    releaseVersion: 1,
    generation: 1,
    status: "succeeded",
    current: true,
    body,
  }
}

function published(
  db: DatabaseSync,
  seq: number,
  overrides: Partial<PublishedDecision["decision"]> = {},
) {
  const saved = input(seq)
  const decisionId = `decision-${seq}`
  db.prepare("INSERT INTO processing_inputs VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
    saved.seq,
    saved.sourceKey,
    saved.itemId,
    saved.contentVersion,
    JSON.stringify(saved.body),
    saved.receivedAt,
    saved.releaseVersion,
    saved.generation,
    saved.status,
    1,
    decisionId,
  )
  db.prepare("INSERT INTO entry_decisions VALUES(?,?,?,?,?,?)").run(
    decisionId,
    saved.seq,
    saved.generation,
    saved.releaseVersion,
    JSON.stringify({ status: "keep" }),
    saved.receivedAt,
  )
  const result = {
    input: saved,
    decisionId,
    decision: {
      schemaVersion: 1,
      fingerprint: `decision-fingerprint-${seq}`,
      provider: "codex" as const,
      model: "test-model",
      generatedAt: saved.receivedAt,
      durationMs: 1,
      usage: null,
      status: "keep" as const,
      title: saved.body.title,
      summary: `摘要 ${seq}`,
      reason: "可聚合",
      labels: [],
      policy: { standalone: "auto", aggregation: "allow", rewrite: "allow" },
      sourceRole: seq === 1 ? "official" : "reporting",
      context: { source_id: `source-${seq}`, contextId: `context-${seq}` },
      facts: [{ text: `事实 ${seq}`, quote: `来源 ${seq} 的可核查事实。`, kind: "fact" as const }],
      semantic: {
        entryId: saved.itemId,
        title: "事件",
        summary: "摘要",
        disposition: "keep" as const,
        reason: "可核对",
        aggregation: true,
        rewrite: true,
        labels: [],
        facts: [],
        event: fixtureEvent(`来源 ${seq} 的可核查事实。`),
      },
      reused: false,
      ...overrides,
    },
  } satisfies PublishedDecision
  db.prepare("UPDATE entry_decisions SET body=? WHERE id=?").run(
    JSON.stringify(result.decision),
    decisionId,
  )
  return result
}

// 旧测试关注引用/版本行为，提供同一已确认事件；专项回归另用中英文实际原文与不同事件。
function fixtureEvent(quote: string): EventIdentity {
  const field = (value: string) => ({ value, quote })
  return {
    kind: "event",
    subject: field("OpenAI"),
    action: { value: "product_release", quote },
    object: field("GPT"),
    version: field("5.2"),
    round: null,
    anchor: null,
  }
}

function casePublished(
  db: DatabaseSync,
  seq: number,
  original: string,
  event: EventIdentity | null,
) {
  const item = published(db, seq)
  item.input.body.content = `<p>${original}</p>`
  item.input.body.title = original.slice(0, 100)
  item.decision.facts = [{ text: original, quote: original, kind: "fact" }]
  item.decision.semantic = event ? { ...item.decision.semantic!, event } : null
  db.prepare("UPDATE processing_inputs SET body=? WHERE seq=?").run(
    JSON.stringify(item.input.body),
    seq,
  )
  db.prepare("UPDATE entry_decisions SET body=? WHERE id=?").run(
    JSON.stringify(item.decision),
    item.decisionId,
  )
  return item
}

function caseEvent(
  original: string,
  subject: string,
  action: EventIdentity["action"]["value"],
  object: string,
  discriminator: { version?: string; round?: string; date?: string; reference?: string },
): EventIdentity {
  const field = (value: string) => ({ value, quote: original })
  return {
    kind: "event",
    subject: field(subject),
    action: { value: action, quote: original },
    object: field(object),
    version: discriminator.version ? field(discriminator.version) : null,
    round: discriminator.round ? field(discriminator.round) : null,
    anchor: discriminator.date
      ? { ...field(discriminator.date), kind: "event_date" }
      : discriminator.reference
        ? { ...field(discriminator.reference), kind: "official_reference" }
        : null,
  }
}

function rules(actions: RuleSet["rules"][number]["actions"], order = 0): RuleSet {
  return {
    formatVersion: 4,
    ownerId: "owner",
    global: { version: 1, markdown: "全局阅读基础" },
    rules: [
      {
        id: `aggregate-${order}`,
        ownerId: "owner",
        name: "聚合",
        enabled: true,
        order,
        when: { all: true },
        actions,
        version: 1,
        executionLocation: "processing_service",
      },
    ],
  }
}

function aggregateAction() {
  return {
    type: "ai_aggregate" as const,
    createPrompt: "将同一事件的多来源材料综合。",
    updatePrompt: "更新已有 Story，说明新增和修正。",
    mode: "same_event" as const,
    scope: { all: true } as const,
  }
}

function modelOutput(existingStoryId: string | null = null): StoryModelOutput {
  return {
    groups: [
      {
        existingStoryId,
        title: "同一事件",
        body: "两份来源都确认了该事件。",
        retainedSentenceIds: [],
        retainedFactIds: [],
        sentences: [
          {
            text: "两份来源都提供了可核查事实。",
            sources: [
              { inputSeq: 1, evidenceId: evidenceId(1) },
              { inputSeq: 2, evidenceId: evidenceId(2) },
            ],
          },
        ],
        facts: [
          {
            text: "事件已被两份来源描述。",
            kind: "fact",
            sentenceIndexes: [0],
            dependsOnFactIndexes: [],
            dependsOnRetainedFactIds: [],
          },
        ],
      },
    ],
  }
}

function evidenceId(inputSeq: number, factIndex = 0) {
  return `evidence-${inputSeq}-${factIndex}`
}

function pairsOutput(sequences: number[]): StoryModelOutput {
  return {
    groups: Array.from({ length: sequences.length / 2 }, (_, index) => {
      const first = sequences[index * 2]!
      const second = sequences[index * 2 + 1]!
      return {
        existingStoryId: null,
        title: `事件 ${first}-${second}`,
        body: `来源 ${first} 与 ${second} 的事实。`,
        retainedSentenceIds: [],
        retainedFactIds: [],
        sentences: [
          {
            text: `来源 ${first} 与 ${second} 的可核查事实。`,
            sources: [
              { inputSeq: first, evidenceId: evidenceId(first) },
              { inputSeq: second, evidenceId: evidenceId(second) },
            ],
          },
        ],
        facts: [
          {
            text: `事件 ${first}-${second} 已被两份来源描述。`,
            kind: "fact",
            sentenceIndexes: [0],
            dependsOnFactIndexes: [],
            dependsOnRetainedFactIds: [],
          },
        ],
      }
    }),
  }
}

function executeWith(outputs: unknown[], prompts: string[] = []) {
  return async function execute<T>(options: CodexJsonOptions<T>) {
    prompts.push(options.prompt)
    const output = outputs.shift()
    if (!options.validate(output)) throw new Error("test_output_rejected_by_schema")
    return {
      result: output,
      model: options.model,
      durationMs: 5,
      usage: { inputTokens: 40, outputTokens: 20, cachedInputTokens: 3 },
      toolCalls: 0,
    }
  }
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function sharedDraft(
  decisions: PublishedDecision[],
  ruleSet: RuleSet,
  output: StoryModelOutput = modelOutput(),
): SharedStoryGroup {
  return {
    ruleId: ruleSet.rules[0]!.id,
    ruleFingerprint: sharedStoryRuleFingerprint(ruleSet.rules[0]!, ruleSet.global),
    inputSeqs: decisions.map((decision) => decision.input.seq),
    inputs: decisions.map(({ input }) => ({
      seq: input.seq,
      generation: input.generation,
      contentVersion: input.contentVersion,
      sourceKey: input.sourceKey,
      itemId: input.itemId,
    })),
    // 单篇目录编号可在每条材料中重复，必须结合 inputSeq 才能还原来源。
    evidenceCatalogs: decisions.map((decision) => ({
      inputSeq: decision.input.seq,
      fragments: [{ evidenceId: "E000001", quote: decision.decision.facts[0]!.quote }],
    })),
    output: {
      groups: output.groups.map((group) => ({
        ...group,
        sentences: group.sentences.map((sentence) => ({
          ...sentence,
          sources: sentence.sources.map((source) => ({ ...source, evidenceId: "E000001" })),
        })),
      })),
    },
  }
}

describe("Story 模型聚合", () => {
  it("人工拆分后的稳定事件 ID 在模型前隔离候选，也不会召回另一个子事件的旧 Story", async () => {
    const { db, stories, aiConfig, runtimeDir } = fixture()
    const decisions = [published(db, 1), published(db, 2)]
    const prompts: string[] = []
    const options = {
      decisions,
      ruleSet: rules([aggregateAction()]),
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
    }
    // 原始事件字段完全相同，也须尊重人工划定的不同稳定事件身份。
    const separated = await runStoryAggregation({
      ...options,
      registeredEventId: (members) => `event-${members[0]!.inputSeq}`,
      execute: executeWith([], prompts),
    })
    expect(separated.created).toEqual([])
    expect(prompts).toEqual([])
    const first = await runStoryAggregation({
      ...options,
      registeredEventId: () => "event-A",
      execute: executeWith([modelOutput()]),
    })
    expect(first.created).toHaveLength(1)
    const next = await runStoryAggregation({
      ...options,
      decisions: [published(db, 3)],
      registeredEventId: (members) =>
        members.every((member) => member.inputSeq < 3) ? "event-A" : "event-B",
      execute: executeWith([], prompts),
    })
    expect(next.created).toEqual([])
    expect(prompts).toEqual([])
    expect(stories.currentSnapshot(first.created[0]!.storyId)?.revision).toBe(1)
  })

  it("多事件文章与人工失效成员不进入主事件综合，也不触发额外模型", async () => {
    const { db, stories, aiConfig, runtimeDir } = fixture()
    const original = "Acme released Widget 2.0. Beta released Tool 3.0."
    const primary = caseEvent(original, "Acme", "product_release", "Widget", { version: "2.0" })
    const secondary = caseEvent(original, "Beta", "product_release", "Tool", { version: "3.0" })
    const multi = casePublished(db, 1, original, primary)
    multi.decision.semantic!.eventMentions = [
      { identity: primary, role: "reports", isPrimary: true },
      { identity: secondary, role: "mentions", isPrimary: false },
    ]
    const decisions = [multi, casePublished(db, 2, original, primary)]
    const prompts: string[] = []
    const options = {
      decisions,
      ruleSet: rules([aggregateAction()]),
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      execute: executeWith([], prompts),
    }
    const multiResult = await runStoryAggregation(options)
    expect(multiResult.created).toEqual([])
    // 单事件另一篇仍独立保留；共享草稿也不能绕过多事件成员资格。
    const corrected = await runStoryAggregation({
      ...options,
      sameEventEligible: () => false,
      sharedGroups: [sharedDraft(decisions, options.ruleSet)],
    })
    expect(corrected.created).toEqual([])
    expect(prompts).toEqual([])
    expect(stories.list()).toEqual([])
  })

  it("普通主报道带背景提及时只综合隔离后的主事实，共享草稿不能偷渡背景", async () => {
    const { db, stories, aiConfig, runtimeDir } = fixture()
    const primaryText = "Acme released Widget 2.0 with faster sync."
    const otherText = "Acme released Widget 2.0 with a smaller database."
    const background = "Beta released Tool 3.0."
    const primary = caseEvent(primaryText, "Acme", "product_release", "Widget", { version: "2.0" })
    const secondary = caseEvent(background, "Beta", "product_release", "Tool", { version: "3.0" })
    const multi = casePublished(db, 1, `${primaryText}\n${background}`, primary)
    multi.input.body.title = "Acme released Widget 2.0"
    multi.decision.summary = background
    multi.decision.facts = [primaryText, background].map((quote) => ({
      text: quote,
      quote,
      kind: "fact",
    }))
    multi.decision.semantic!.eventMentions = [
      { identity: primary, role: "reports", isPrimary: true },
      { identity: secondary, role: "mentions", isPrimary: false },
    ]
    // 与生产一样持久化完整单篇材料，Store 会独立验证发布边界的主事实范围。
    db.prepare("UPDATE entry_decisions SET body=? WHERE id=?").run(
      JSON.stringify(multi.decision),
      multi.decisionId,
    )
    const second = casePublished(
      db,
      2,
      otherText,
      caseEvent(otherText, "Acme", "product_release", "Widget", { version: "2.0" }),
    )
    const decisions = [multi, second]
    const ruleSet = rules([aggregateAction()])
    const invalidShared = modelOutput()
    const shared = sharedDraft(decisions, ruleSet, invalidShared)
    shared.evidenceCatalogs[0]!.fragments = [
      ...shared.evidenceCatalogs[0]!.fragments,
      { evidenceId: "E000002", quote: background },
    ]
    // 背景 evidenceId 虽然存在于单篇目录，但不属于本次主事件许可证。
    shared.output.groups[0]!.sentences[0]!.sources[0]!.evidenceId =
      shared.evidenceCatalogs[0]!.fragments[1]!.evidenceId
    const prompts: string[] = []
    const result = await runStoryAggregation({
      decisions,
      ruleSet,
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      sharedGroups: [shared],
      execute: executeWith([modelOutput()], prompts),
    })
    expect(result.created).toHaveLength(1)
    expect(result.failures).toEqual([])
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).not.toContain(background)
    const revision = stories.currentSnapshot(result.created[0]!.storyId)!
    expect(revision.sourceSpans.map((span) => span.quote)).toEqual([primaryText, otherText])
    expect(stories.eventIdentityForMembers(revision.members)).toEqual(primary)
    // 直接改持久化草稿也不能把另一事件的原文塞进已确认主事件。
    expect(() =>
      stories.appendRevision(revision.storyId, 1, {
        ...revision,
        sourceSpans: revision.sourceSpans.map((span) =>
          span.inputSeq === 1
            ? {
                ...span,
                quote: background,
                fragmentId: sourceSpanFragmentId(
                  span.sourceItemId,
                  span.contentVersion,
                  background,
                ),
              }
            : span,
        ),
      }),
    ).toThrow("invalid_reference")
  })

  it("同批综述复用单篇分析的证据目录，不再请求模型", async () => {
    const { db, stories, aiConfig, runtimeDir } = fixture()
    const decisions = [published(db, 1), published(db, 2)]
    const ruleSet = rules([aggregateAction()])
    let calls = 0
    const result = await runStoryAggregation({
      decisions,
      ruleSet,
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      sharedGroups: [sharedDraft(decisions, ruleSet)],
      execute: async () => {
        calls++
        throw new Error("unexpected_model")
      },
    })
    expect(calls).toBe(0)
    expect(result.created).toHaveLength(1)
    expect(result.failures).toEqual([])
    expect(result.usage.inputTokens).toBe(0)
    const revision = stories.currentSnapshot(result.created[0]!.storyId)!
    expect(revision.sourceSpans.map((span) => [span.inputSeq, span.quote])).toEqual([
      [1, decisions[0]!.decision.facts[0]!.quote],
      [2, decisions[1]!.decision.facts[0]!.quote],
    ])
  })

  it("已有综述没有材料增量时不消费共享草稿，也不额外调用更新模型", async () => {
    const { db, stories, aiConfig, runtimeDir } = fixture()
    const decisions = [published(db, 1), published(db, 2)]
    const ruleSet = rules([aggregateAction()])
    const options = {
      decisions,
      ruleSet,
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      sharedGroups: [sharedDraft(decisions, ruleSet)],
    }
    const first = await runStoryAggregation(options)
    const prompts: string[] = []
    const second = await runStoryAggregation({
      ...options,
      execute: executeWith([modelOutput(first.created[0]!.storyId)], prompts),
    })
    expect(prompts).toEqual([])
    expect(second.created).toEqual([])
    expect(second.failures).toEqual([])
  })

  it("同批明确没有综述的结果不会再付费请求一次", async () => {
    const { db, stories, aiConfig, runtimeDir } = fixture()
    const decisions = [published(db, 1), published(db, 2)]
    const ruleSet = rules([aggregateAction()])
    const prompts: string[] = []
    const result = await runStoryAggregation({
      decisions,
      ruleSet,
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      sharedGroups: [sharedDraft(decisions, ruleSet, { groups: [] })],
      execute: executeWith([], prompts),
    })
    expect(prompts).toEqual([])
    expect(result.created).toEqual([])
    expect(result.pending).toEqual([
      { ruleId: ruleSet.rules[0]!.id, inputSeqs: [1, 2], reason: "no_story_group" },
    ])
  })

  it.each(["generation", "rule", "batch", "evidence", "unpublished_fact"] as const)(
    "共享草稿的 %s 不匹配时使用当前事实重新综合",
    async (mismatch) => {
      const { db, stories, aiConfig, runtimeDir } = fixture()
      const decisions = [published(db, 1), published(db, 2)]
      const ruleSet = rules([aggregateAction()])
      const draft = sharedDraft(decisions, ruleSet)
      if (mismatch === "generation")
        draft.inputs = draft.inputs.map((item) => ({ ...item, generation: 0 }))
      if (mismatch === "rule") draft.ruleFingerprint = "stale-rule"
      if (mismatch === "batch") draft.inputSeqs = [1, 2, 3]
      if (mismatch === "evidence") draft.evidenceCatalogs = []
      if (mismatch === "unpublished_fact") {
        // 原文存在但单篇 facts 未认可的摘引也不能借共享草稿进入正式综述。
        draft.evidenceCatalogs = [
          { inputSeq: 1, fragments: [{ evidenceId: "E000001", quote: "来源" }] },
        ]
      }
      const prompts: string[] = []
      const result = await runStoryAggregation({
        decisions,
        ruleSet,
        stories,
        aiConfig,
        runtimeDir,
        signal: new AbortController().signal,
        sharedGroups: [draft],
        execute: executeWith([modelOutput()], prompts),
      })
      expect(prompts).toHaveLength(1)
      expect(result.created).toHaveLength(1)
      expect(result.failures).toEqual([])
    },
  )

  it("去重已覆盖的来源不参与新综述，只消费草稿中的保留来源组", async () => {
    const { db, stories, aiConfig, runtimeDir } = fixture()
    const decisions = [published(db, 1), published(db, 2), published(db, 3)]
    const ruleSet = rules([aggregateAction()])
    const prompts: string[] = []
    const result = await runStoryAggregation({
      decisions,
      ruleSet,
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      sharedGroups: [sharedDraft(decisions, ruleSet, pairsOutput([1, 3]))],
      hiddenInputSeqs: [2],
      execute: executeWith([], prompts),
    })
    expect(prompts).toHaveLength(0)
    expect(result.created).toHaveLength(1)
    expect(
      stories.currentSnapshot(result.created[0]!.storyId)!.members.map((member) => member.inputSeq),
    ).toEqual([1, 3])
  })

  it("同事件批次包含未成组材料时保留完整请求覆盖，不重复综合", async () => {
    const { db, stories, aiConfig, runtimeDir } = fixture()
    const decisions = [published(db, 1), published(db, 2), published(db, 3)]
    const ruleSet = rules([aggregateAction()])
    const prompts: string[] = []
    const result = await runStoryAggregation({
      decisions,
      ruleSet,
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      sharedGroups: [sharedDraft(decisions, ruleSet)],
      execute: executeWith([], prompts),
    })
    expect(prompts).toEqual([])
    expect(result.created).toHaveLength(1)
    expect(result.pending).toEqual([
      { ruleId: ruleSet.rules[0]!.id, inputSeqs: [3], reason: "no_story_group" },
    ])
  })

  it.each(["groups", "empty", "cross_event"] as const)(
    "统一请求按两个事件拆批时复用完整 %s 结果",
    async (mode) => {
      const { db, stories, aiConfig, runtimeDir } = fixture()
      const decisions = [1, 2, 3, 4].map((seq) => {
        const version = seq < 3 ? "5.2" : "5.3"
        const original = `来源${seq}：OpenAI发布GPT ${version}。`
        return casePublished(
          db,
          seq,
          original,
          caseEvent(original, "OpenAI", "product_release", "GPT", { version }),
        )
      })
      const ruleSet = rules([aggregateAction()])
      const prompts: string[] = []
      const output =
        mode === "empty"
          ? { groups: [] }
          : mode === "cross_event"
            ? pairsOutput([1, 3, 2, 4])
            : pairsOutput([1, 2, 3, 4])
      const result = await runStoryAggregation({
        decisions,
        ruleSet,
        stories,
        aiConfig,
        runtimeDir,
        signal: new AbortController().signal,
        sharedGroups: [sharedDraft(decisions, ruleSet, output)],
        execute: executeWith([], prompts),
      })
      expect(prompts).toEqual([])
      expect(result.failures).toEqual([])
      expect(result.created).toHaveLength(mode === "groups" ? 2 : 0)
      expect(result.pending.flatMap((item) => item.inputSeqs)).toEqual(
        mode === "groups" ? [] : [1, 2, 3, 4],
      )
    },
  )

  it("共享请求中子批次以外的材料换代后也不能继续复用", async () => {
    const { db, stories, aiConfig, runtimeDir } = fixture()
    const decisions = [published(db, 1), published(db, 2), published(db, 3)]
    const ruleSet = rules([aggregateAction()])
    const draft = sharedDraft(decisions, ruleSet)
    draft.inputs = draft.inputs.map((input) =>
      input.seq === 3 ? { ...input, generation: 0 } : input,
    )
    const prompts: string[] = []
    const result = await runStoryAggregation({
      decisions,
      ruleSet,
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      hiddenInputSeqs: [3],
      sharedGroups: [draft],
      execute: executeWith([modelOutput()], prompts),
    })
    expect(prompts).toHaveLength(1)
    expect(result.created).toHaveLength(1)
  })

  it.each([true, null, undefined] as const)(
    "当前读态 %s 不允许旧未读决定参与综述",
    async (read) => {
      const { db, stories, aiConfig, runtimeDir } = fixture()
      const decisions = [published(db, 1), published(db, 2)]
      // 模拟单篇成功之后改为已读或读态缺失，输入仍保存旧未读状态。
      let calls = 0
      const result = await runStoryAggregation({
        decisions,
        currentEntry: () => (read === undefined ? undefined : { read }),
        ruleSet: rules([aggregateAction()]),
        stories,
        aiConfig,
        runtimeDir,
        signal: new AbortController().signal,
        execute: async () => {
          calls++
          throw new Error("unexpected_model")
        },
      })
      expect(calls).toBe(0)
      expect(result.created).toEqual([])
      expect(result.updated).toEqual([])
      expect(result.failures).toEqual([])
    },
  )

  it.each([
    [
      "ASvanevik 于2026-09-26发表代理式交易将成常态的预测。",
      "Hsin-Ju Chuang 的死因于2026-09-26确认为自杀。",
      "ASvanevik",
      "public_statement",
      "agent_trading_prediction",
      "Hsin-Ju Chuang",
      "death",
      "cause_of_death",
    ],
    [
      "SEC Uyeda 于2026-09-26解释撤销加密案件。",
      "2026-09-26 BTC跌破80427美元将触发多单清算。",
      "SEC",
      "legal_case",
      "crypto_case_withdrawals",
      "BTC",
      "market_event",
      "liquidation_threshold",
    ],
    [
      "SEC Uyeda 于2026-09-26解释撤销加密案件。",
      "2026-09-26 ETH跌破2576美元将触发多单清算。",
      "SEC",
      "legal_case",
      "crypto_case_withdrawals",
      "ETH",
      "market_event",
      "liquidation_threshold",
    ],
  ] as const)(
    "真实误合并回归：%s 与 %s 不进入同一模型分组",
    async (
      firstText,
      secondText,
      firstSubject,
      firstAction,
      firstObject,
      secondSubject,
      secondAction,
      secondObject,
    ) => {
      const { db, stories, aiConfig, runtimeDir } = fixture()
      const decisions = [
        casePublished(
          db,
          1,
          firstText,
          caseEvent(firstText, firstSubject, firstAction, firstObject, { date: "2026-09-26" }),
        ),
        casePublished(
          db,
          2,
          secondText,
          caseEvent(secondText, secondSubject, secondAction, secondObject, { date: "2026-09-26" }),
        ),
      ]
      let calls = 0
      const result = await runStoryAggregation({
        decisions,
        ruleSet: rules([aggregateAction()]),
        stories,
        aiConfig,
        runtimeDir,
        signal: new AbortController().signal,
        execute: async () => {
          calls++
          throw new Error("must_not_call")
        },
      })
      expect(calls).toBe(0)
      expect(result.created).toEqual([])
      expect(db.prepare("SELECT COUNT(*) AS count FROM stories").get()?.count).toBe(0)
      expect(result.pending).toHaveLength(2)
    },
  )

  it("中英文同一官方发布无发生日期也可聚合；可核对版本相同，不依赖标题主题", async () => {
    const { db, stories, aiConfig, runtimeDir } = fixture()
    const originals = [
      "OpenAI 发布 GPT 5.2，官方公告 https://openai.com/index/gpt-5-2/。",
      "GPT 5.2 is released by OpenAI. Official post https://openai.com/index/gpt-5-2/.",
    ]
    const decisions = originals.map((text, index) =>
      casePublished(
        db,
        index + 1,
        text,
        caseEvent(text, "OpenAI", "product_release", "GPT", {
          version: "5.2",
          reference: "https://openai.com/index/gpt-5-2/",
        }),
      ),
    )
    // 两份不同语言原文各有独立证据；模型只生成综述，不能替服务端决定身份兼容。
    const result = await runStoryAggregation({
      decisions,
      ruleSet: rules([aggregateAction()]),
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      execute: executeWith([modelOutput()]),
    })
    expect(result.created).toHaveLength(1)
    const current = stories.currentSnapshot(result.created[0]!.storyId)!
    expect(current.eventIdentity?.version?.value).toBe("5.2")
    expect(current.sourceSpans.map((span) => span.quote)).toEqual(originals)
  })

  it.each(["deadline", "round", "version", "legacy"] as const)("更新核验：%s", async (change) => {
    const { db, stories, aiConfig, runtimeDir } = fixture()
    const config = rules([aggregateAction()])
    const initial = [
      "Alpha 活动第一轮v1领取已开放，截止10月4日。",
      "Alpha 第一轮v1官方公告确认领取，截止10月4日。",
    ]
    const identity = (text: string) =>
      caseEvent(text, "Alpha", "campaign", "claim_campaign", { round: "1", version: "v1" })
    const previous = initial.map((text, index) =>
      casePublished(db, index + 1, text, identity(text)),
    )
    const initialResult = await runStoryAggregation({
      decisions: previous,
      ruleSet: config,
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      execute: executeWith([modelOutput()]),
    })
    const storyId = initialResult.created[0]!.storyId
    if (change === "legacy") {
      // 只改内存测试库，模拟历史决定缺事件字段；记录/链接必须保留而不自动续写。
      for (const item of previous)
        db.prepare("UPDATE entry_decisions SET body=? WHERE id=?").run(
          JSON.stringify({ ...item.decision, semantic: null }),
          item.decisionId,
        )
    }
    const text =
      change === "round"
        ? "Alpha 活动第二轮v1领取开放。"
        : change === "version"
          ? "Alpha 第一轮v2正式发布。"
          : "Alpha 第一轮v1领取截止延长到10月5日，资格已调整。"
    const event = identity(text)
    if (change === "round") event.round!.value = "2"
    if (change === "version") event.version!.value = "v2"
    const next = casePublished(db, 3, text, event)
    let calls = 0
    const output = {
      groups: [
        {
          ...modelOutput(storyId).groups[0]!,
          sentences: [{ text, sources: [{ inputSeq: 3, evidenceId: evidenceId(3) }] }],
        },
      ],
    }
    const result = await runStoryAggregation({
      decisions: [next],
      ruleSet: config,
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      execute: async <T>(request: CodexJsonOptions<T>) => {
        calls++
        expect(request.validate(output)).toBe(true)
        return {
          result: output as T,
          model: request.model,
          durationMs: 1,
          usage: null,
          toolCalls: 0,
        }
      },
    })
    expect(calls).toBe(change === "deadline" ? 1 : 0)
    expect(result.updated).toHaveLength(change === "deadline" ? 1 : 0)
    expect(stories.currentSnapshot(storyId)!.revision).toBe(change === "deadline" ? 2 : 1)
    expect(stories.resolveLink(storyId).kind).toBe("current")
  })

  it("模型指定另一真实事件的旧Story也不能绕过更新校验", async () => {
    const { db, stories, aiConfig, runtimeDir } = fixture()
    const first = ["Alpha 第一轮领取开放。", "Alpha 第一轮公告确认领取开放。"].map((text, index) =>
      casePublished(
        db,
        index + 1,
        text,
        caseEvent(text, "Alpha", "campaign", "claim", { round: "1" }),
      ),
    )
    const old = await runStoryAggregation({
      decisions: first,
      ruleSet: rules([aggregateAction()]),
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      execute: executeWith([modelOutput()]),
    })
    const storyId = old.created[0]!.storyId
    const next = ["Alpha 第二轮领取开放。", "Alpha 第二轮公告确认领取开放。"].map((text, index) =>
      casePublished(
        db,
        index + 3,
        text,
        caseEvent(text, "Alpha", "campaign", "claim", { round: "2" }),
      ),
    )
    const malicious = {
      groups: pairsOutput([3, 4]).groups.map((group) => ({ ...group, existingStoryId: storyId })),
    }
    const result = await runStoryAggregation({
      decisions: next,
      ruleSet: rules([aggregateAction()]),
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      execute: executeWith([malicious]),
    })
    expect(result.updated).toEqual([])
    expect(result.created).toEqual([])
    expect(result.failures[0]?.reason).toBe("invalid_model_output")
    expect(stories.currentSnapshot(storyId)!.revision).toBe(1)
  })

  it("已识别观点和教程正常保留独立，不进入同事件模型或未知待补计数", async () => {
    const { db, stories, aiConfig, runtimeDir } = fixture()
    const decisions = ["analysis", "tutorial"].map((kind, index) => {
      const item = published(db, index + 1)
      item.decision.semantic!.event = {
        ...item.decision.semantic!.event!,
        kind: kind as "analysis" | "tutorial",
      }
      return item
    })
    let calls = 0
    const result = await runStoryAggregation({
      decisions,
      ruleSet: rules([aggregateAction()]),
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      execute: async () => {
        calls++
        throw new Error("不应执行模型")
      },
    })
    expect(result.created).toEqual([])
    expect(result.pending).toEqual([])
    expect(calls).toBe(0)
    expect(decisions.every((item) => item.decision.status === "keep")).toBe(true)
  })

  it("明确折叠但允许综合的材料仍可参与 Story", async () => {
    const { db, stories, aiConfig, runtimeDir } = fixture()
    const result = await runStoryAggregation({
      decisions: [
        published(db, 1, {
          status: "hide",
          policy: { standalone: "never", aggregation: "allow", rewrite: "allow" },
        }),
        published(db, 2),
      ],
      ruleSet: rules([aggregateAction()]),
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      execute: executeWith([modelOutput()]),
    })
    expect(result.created).toHaveLength(1)
  })
  it("通过 Codex 执行边界创建多来源 Story，并由服务端生成可验证引用", async () => {
    const { db, stories, aiConfig, runtimeDir } = fixture()
    const prompts: string[] = []
    const result = await runStoryAggregation({
      decisions: [published(db, 1), published(db, 2)],
      ruleSet: rules([aggregateAction()]),
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      execute: async <T>(options: CodexJsonOptions<T>) => {
        // 断言真正传入 CLI 的 schema 含有嵌套引用和事实类型约束，不能退化为裸数组。
        prompts.push(options.prompt)
        expect(options.schema).toMatchObject({
          properties: {
            groups: {
              items: {
                properties: {
                  sentences: {
                    items: {
                      properties: {
                        sources: {
                          items: {
                            properties: {
                              inputSeq: { type: "integer" },
                              evidenceId: { type: "string" },
                            },
                          },
                        },
                      },
                    },
                  },
                  facts: {
                    items: {
                      properties: {
                        kind: { enum: ["fact", "source_claim", "inference"] },
                      },
                    },
                  },
                },
              },
            },
          },
        })
        const value = modelOutput()
        if (!options.validate(value)) throw new Error("test_output_rejected_by_schema")
        return {
          result: value,
          model: options.model,
          durationMs: 5,
          usage: { inputTokens: 40, outputTokens: 20, cachedInputTokens: 3 },
          toolCalls: 0,
        }
      },
    })

    expect(result).toMatchObject({
      created: [{ ruleId: "aggregate-0", revision: 1 }],
      failures: [],
    })
    expect(result.usage).toEqual({ inputTokens: 40, outputTokens: 20, cachedInputTokens: 3 })
    const revision = stories.revision(result.created[0]!.storyId, 1)!
    expect(revision.members.map((member) => member.inputSeq)).toEqual([1, 2])
    expect(revision.sourceSpans.map((span) => span.quote)).toEqual([
      "来源 1 的可核查事实。",
      "来源 2 的可核查事实。",
    ])
    expect(prompts[0]).toContain("evidenceId")
  })

  it("相同成员再次命中 updatePrompt 时不凭模型转述制造 revision", async () => {
    const { db, stories, aiConfig, runtimeDir } = fixture()
    const firstDecisions = [published(db, 1), published(db, 2)]
    const first = await runStoryAggregation({
      decisions: firstDecisions,
      ruleSet: rules([aggregateAction()]),
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      execute: executeWith([modelOutput()]),
    })
    const prompts: string[] = []
    const changed = firstDecisions.map((item) => ({
      ...item,
      decision: { ...item.decision, fingerprint: `${item.decision.fingerprint}-changed` },
    }))
    const second = await runStoryAggregation({
      decisions: changed,
      ruleSet: rules([aggregateAction()]),
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      execute: executeWith(
        [
          {
            ...modelOutput(first.created[0]!.storyId),
            groups: [
              { ...modelOutput(first.created[0]!.storyId).groups[0]!, title: "修正后的事件" },
            ],
          },
        ],
        prompts,
      ),
    })

    expect(second.created).toEqual([])
    expect(second.updated).toEqual([])
    expect(stories.story(first.created[0]!.storyId)?.currentRevision).toBe(1)
    expect(prompts).toEqual([])
  })

  it("相同内容再次运行复用当前 revision，不新增空历史版本", async () => {
    const { db, stories, aiConfig, runtimeDir } = fixture()
    const decisions = [published(db, 1), published(db, 2)]
    const first = await runStoryAggregation({
      decisions,
      ruleSet: rules([aggregateAction()]),
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      execute: executeWith([modelOutput()]),
    })
    const storyId = first.created[0]!.storyId
    const second = await runStoryAggregation({
      decisions,
      ruleSet: rules([aggregateAction()]),
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      execute: executeWith([modelOutput()]),
    })

    expect(second.created).toEqual([])
    expect(second.updated).toEqual([])
    expect(stories.story(storyId)?.currentRevision).toBe(1)
  })

  it("模型设置切换不会命中旧模型缓存", async () => {
    const { db, stories, aiConfig, runtimeDir, configPath } = fixture()
    const decisions = [published(db, 1), published(db, 2)]
    let calls = 0
    const execute = async <T>(options: CodexJsonOptions<T>) => {
      calls++
      const output = { groups: [] }
      if (!options.validate(output)) throw new Error("invalid_stub_output")
      return {
        result: output,
        model: options.model,
        durationMs: 1,
        usage: null,
        toolCalls: 0,
      }
    }
    const base = {
      decisions,
      ruleSet: rules([aggregateAction()]),
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      execute,
    }
    await runStoryAggregation(base)
    writeFileSync(configPath, JSON.stringify({ provider: "codex", model: "other-model" }))
    await runStoryAggregation(base)

    expect(calls).toBe(2)
  })

  it("同一原文的多个 context 只算一个材料，不能伪造多来源", async () => {
    const { db, stories, aiConfig, runtimeDir } = fixture()
    const first = published(db, 1)
    const duplicate = published(db, 2)
    duplicate.input = {
      ...duplicate.input,
      sourceKey: first.input.sourceKey,
      itemId: first.input.itemId,
      contentVersion: first.input.contentVersion,
      body: first.input.body,
    }
    duplicate.decision = {
      ...duplicate.decision,
      semantic: first.decision.semantic,
      context: {
        ...duplicate.decision.context,
        source_id: first.decision.context.source_id,
        contextId: "another-context",
      },
    }
    const result = await runStoryAggregation({
      decisions: [first, duplicate],
      ruleSet: rules([aggregateAction()]),
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      execute: executeWith([modelOutput()]),
    })

    expect(result.created).toEqual([])
    expect(result.pending).toContainEqual({
      ruleId: "aggregate-0",
      inputSeqs: [2],
      reason: "insufficient_sources",
    })
  })

  it("rewrite deny 仅允许原文摘引句与事实，仍可作为 Story 材料", async () => {
    const { db, stories, aiConfig, runtimeDir } = fixture()
    const quoteOnly = published(db, 1, {
      policy: { standalone: "auto", aggregation: "allow", rewrite: "deny" },
    })
    const output = {
      groups: [
        {
          existingStoryId: null,
          title: "原文摘引",
          body: "模型自由正文不会被使用",
          retainedSentenceIds: [] as string[],
          retainedFactIds: [],
          sentences: [
            {
              text: "来源 1 的可核查事实。",
              sources: [{ inputSeq: 1, evidenceId: evidenceId(1) }],
            },
            {
              text: "来源 2 的可核查事实。",
              sources: [{ inputSeq: 2, evidenceId: evidenceId(2) }],
            },
          ],
          facts: [
            {
              text: "来源 1 的可核查事实。",
              kind: "fact",
              sentenceIndexes: [0],
              dependsOnFactIndexes: [],
              dependsOnRetainedFactIds: [] as string[],
            },
            {
              text: "来源 2 的可核查事实。",
              kind: "fact",
              sentenceIndexes: [1],
              dependsOnFactIndexes: [],
              dependsOnRetainedFactIds: [],
            },
          ],
        },
      ],
    }
    const result = await runStoryAggregation({
      decisions: [quoteOnly, published(db, 2)],
      ruleSet: rules([aggregateAction()]),
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      execute: executeWith([output]),
    })

    expect(result.created).toHaveLength(1)
    expect(stories.currentSnapshot(result.created[0]!.storyId)?.body).toContain(
      "来源 1 的可核查事实。",
    )
  })

  it("跨批更新保留既有成员与原文引用，随后单条新增也能附着同一 Story", async () => {
    const { db, stories, aiConfig, runtimeDir } = fixture()
    const decisions = Array.from({ length: 22 }, (_, index) => published(db, index + 1))
    let calls = 0
    const result = await runStoryAggregation({
      decisions,
      ruleSet: rules([aggregateAction()]),
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      execute: async (options) => {
        calls++
        const firstBatch = Array.from({ length: 20 }, (_, index) => index + 1)
        const storyId = stories.list()[0]?.id ?? null
        const sources = calls === 1 ? firstBatch : [21, 22]
        const output = {
          groups: [
            {
              existingStoryId: storyId,
              title: "同一持续事件",
              body: "自由正文不参与持久化",
              retainedSentenceIds: calls === 1 ? [] : ["sentence-base-0"],
              retainedFactIds: calls === 1 ? [] : ["fact-base-0"],
              sentences: [
                {
                  text: `第 ${calls} 批来源事实。`,
                  sources: sources.map((inputSeq) => ({
                    inputSeq,
                    evidenceId: evidenceId(inputSeq),
                  })),
                },
              ],
              facts: [
                {
                  text: `第 ${calls} 批事实。`,
                  kind: "fact",
                  sentenceIndexes: [0],
                  dependsOnFactIndexes: [],
                  dependsOnRetainedFactIds: [],
                },
              ],
            },
          ],
        }
        if (!options.validate(output)) throw new Error("invalid_stub_output")
        return { result: output, model: options.model, durationMs: 1, usage: null, toolCalls: 0 }
      },
    })

    const storyId = result.created[0]!.storyId
    const revision = stories.currentSnapshot(storyId)!
    expect(calls).toBe(2)
    expect(result.updated).toEqual([{ storyId, ruleId: "aggregate-0", revision: 2 }])
    expect(revision.members.map((member) => member.inputSeq)).toEqual(
      Array.from({ length: 22 }, (_, index) => index + 1),
    )
    expect(revision.sourceSpans.map((span) => span.quote)).toEqual(
      expect.arrayContaining([
        "来源 1 的可核查事实。",
        "来源 20 的可核查事实。",
        "来源 21 的可核查事实。",
        "来源 22 的可核查事实。",
      ]),
    )

    const oneNew = published(db, 23)
    const attached = await runStoryAggregation({
      decisions: [oneNew],
      ruleSet: rules([aggregateAction()]),
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      execute: async (options) => {
        const output = {
          groups: [
            {
              existingStoryId: storyId,
              title: "同一持续事件",
              body: "自由正文不参与持久化",
              retainedSentenceIds: ["sentence-base-0", "sentence-revision-2-0"],
              retainedFactIds: ["fact-base-0", "fact-revision-2-0"],
              sentences: [
                {
                  text: "来源 23 的可核查事实。",
                  sources: [{ inputSeq: 23, evidenceId: evidenceId(23) }],
                },
              ],
              facts: [
                {
                  text: "来源 23 的可核查事实。",
                  kind: "inference",
                  sentenceIndexes: [0],
                  dependsOnFactIndexes: [],
                  dependsOnRetainedFactIds: ["fact-base-0"],
                },
              ],
            },
          ],
        }
        if (!options.validate(output)) throw new Error("invalid_stub_output")
        return { result: output, model: options.model, durationMs: 1, usage: null, toolCalls: 0 }
      },
    })

    expect(attached.updated).toEqual([{ storyId, ruleId: "aggregate-0", revision: 3 }])
    expect(stories.currentSnapshot(storyId)?.members.map((member) => member.inputSeq)).toContain(23)
    expect(stories.currentSnapshot(storyId)?.sourceSpans.map((span) => span.quote)).toContain(
      "来源 1 的可核查事实。",
    )
    expect(stories.currentSnapshot(storyId)?.facts.at(-1)?.dependsOnFactIds).toEqual([
      "fact-base-0",
    ])
  })

  it("后续反驳可撤回旧结论并生成不可变的新 revision", async () => {
    const { db, stories, aiConfig, runtimeDir } = fixture()
    const created = await runStoryAggregation({
      decisions: [published(db, 1), published(db, 2)],
      ruleSet: rules([aggregateAction()]),
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      execute: executeWith([modelOutput()]),
    })
    const storyId = created.created[0]!.storyId
    const original = stories.currentSnapshot(storyId)!
    const correction = {
      groups: [
        {
          existingStoryId: storyId,
          title: "事件结论已修正",
          body: "模型自由正文不会被使用",
          retainedSentenceIds: [],
          retainedFactIds: [],
          sentences: [
            {
              text: "来源 3 的可核查事实。",
              sources: [{ inputSeq: 3, evidenceId: evidenceId(3) }],
            },
          ],
          facts: [
            {
              text: "旧结论已被后续来源修正。",
              kind: "source_claim",
              sentenceIndexes: [0],
              dependsOnFactIndexes: [],
              dependsOnRetainedFactIds: [],
            },
          ],
        },
      ],
    }
    const updated = await runStoryAggregation({
      decisions: [published(db, 3)],
      ruleSet: rules([aggregateAction()]),
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      execute: executeWith([correction]),
    })

    const current = stories.currentSnapshot(storyId)!
    expect(updated.updated).toEqual([{ storyId, ruleId: "aggregate-0", revision: 2 }])
    expect(current.body).toBe("来源 3 的可核查事实。")
    expect(current.facts.map((fact) => fact.text)).toEqual(["旧结论已被后续来源修正。"])
    expect(current.members.map((member) => member.inputSeq)).toEqual([1, 2, 3])
    expect(current.sourceSpans.map((span) => span.inputSeq)).toEqual([1, 2, 3])
    expect(stories.revision(storyId, 1)).toEqual(original)
  })

  it("拒绝保留引用句段或依赖不完整的旧事实", async () => {
    const { db, stories, aiConfig, runtimeDir } = fixture()
    const created = await runStoryAggregation({
      decisions: [published(db, 1), published(db, 2)],
      ruleSet: rules([aggregateAction()]),
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      execute: executeWith([modelOutput()]),
    })
    const storyId = created.created[0]!.storyId
    const invalid = {
      groups: [
        {
          existingStoryId: storyId,
          title: "不完整保留",
          body: "模型自由正文不会被使用",
          retainedSentenceIds: [] as string[],
          retainedFactIds: ["fact-base-0"] as string[],
          sentences: [
            {
              text: "来源 3 的可核查事实。",
              sources: [{ inputSeq: 3, evidenceId: evidenceId(3) }],
            },
          ],
          facts: [
            {
              text: "新增事实。",
              kind: "fact",
              sentenceIndexes: [0],
              dependsOnFactIndexes: [],
              dependsOnRetainedFactIds: [] as string[],
            },
          ],
        },
      ],
    }
    const result = await runStoryAggregation({
      decisions: [published(db, 3)],
      ruleSet: rules([aggregateAction()]),
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      execute: executeWith([invalid]),
    })

    expect(result.updated).toEqual([])
    expect(result.failures).toEqual([
      { ruleId: "aggregate-0", reason: "invalid_model_output", inputSeqs: [3] },
    ])
    expect(stories.story(storyId)?.currentRevision).toBe(1)

    const invalidDependency = structuredClone(invalid)
    invalidDependency.groups[0]!.retainedSentenceIds = ["sentence-base-0"]
    invalidDependency.groups[0]!.retainedFactIds = ["fact-base-0"]
    invalidDependency.groups[0]!.sentences[0]!.sources = [
      { inputSeq: 4, evidenceId: evidenceId(4) },
    ]
    invalidDependency.groups[0]!.facts[0]!.dependsOnRetainedFactIds = ["missing-fact"]
    const dependencyResult = await runStoryAggregation({
      decisions: [published(db, 4)],
      ruleSet: rules([aggregateAction()]),
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      execute: executeWith([invalidDependency]),
    })
    expect(dependencyResult.updated).toEqual([])
    expect(dependencyResult.failures).toEqual([
      { ruleId: "aggregate-0", reason: "invalid_model_output", inputSeqs: [4] },
    ])
    expect(stories.story(storyId)?.currentRevision).toBe(1)
  })

  it(">100 候选按连续批次全部处理，不因首批容量饥饿", async () => {
    const { db, stories, aiConfig, runtimeDir } = fixture()
    const decisions = Array.from({ length: 120 }, (_, index) => published(db, index + 1))
    let batch = 0
    const result = await runStoryAggregation({
      decisions,
      ruleSet: rules([aggregateAction()]),
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      execute: async (options) => {
        const start = batch * 20 + 1
        batch++
        const output = pairsOutput(Array.from({ length: 20 }, (_, index) => start + index))
        if (!options.validate(output)) throw new Error("invalid_stub_output")
        return {
          result: output,
          model: options.model,
          durationMs: 1,
          usage: null,
          toolCalls: 0,
        }
      },
    })

    expect(batch).toBe(6)
    expect(result.created).toHaveLength(60)
    expect(result.pending).toEqual([])
  })

  it("topic 模式明确按主题组织，不把材料描述为同一事件", async () => {
    const { db, stories, aiConfig, runtimeDir } = fixture()
    const prompts: string[] = []
    const result = await runStoryAggregation({
      decisions: [published(db, 1), published(db, 2)],
      ruleSet: rules([{ ...aggregateAction(), mode: "topic" }]),
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      execute: executeWith([modelOutput()], prompts),
    })

    expect(result.created).toHaveLength(1)
    expect(prompts[0]).toContain("不要声称它们是同一事件")
  })

  it("拒绝模型编造输入引用，也不把 deny 或重复规则的材料变成第二个 Story", async () => {
    const { db, stories, aiConfig, runtimeDir } = fixture()
    const denied = published(db, 3, {
      policy: { standalone: "auto", aggregation: "deny", rewrite: "allow" },
    })
    const twoRules: RuleSet = {
      ...rules([aggregateAction()]),
      rules: [
        rules([aggregateAction()]).rules[0]!,
        { ...rules([aggregateAction()]).rules[0]!, id: "aggregate-1", name: "重复规则", order: 1 },
      ],
    }
    const invalid = modelOutput()
    invalid.groups[0]!.sentences[0]!.sources[1] = { inputSeq: 99, evidenceId: evidenceId(99) }
    const result = await runStoryAggregation({
      decisions: [published(db, 1), published(db, 2), denied],
      ruleSet: twoRules,
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      execute: executeWith([invalid]),
    })

    expect(result.created).toEqual([])
    expect(result.failures).toEqual([
      { ruleId: "aggregate-0", reason: "invalid_model_output", inputSeqs: [1] },
    ])
    expect(result.pending).toEqual(
      expect.arrayContaining([
        { ruleId: "aggregate-0", inputSeqs: [3], reason: "aggregation_denied" },
        { ruleId: "aggregate-0", inputSeqs: [1, 2], reason: "no_story_group" },
      ]),
    )
    expect(result.cacheHits).toBe(0)
  })

  it("拒绝把另一候选的 evidenceId 冒充为当前 inputSeq 的引用", async () => {
    const { db, stories, aiConfig, runtimeDir } = fixture()
    const invalid = modelOutput()
    invalid.groups[0]!.sentences[0]!.sources[0] = {
      inputSeq: 1,
      evidenceId: evidenceId(2),
    }
    const result = await runStoryAggregation({
      decisions: [published(db, 1), published(db, 2)],
      ruleSet: rules([aggregateAction()]),
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      execute: executeWith([invalid]),
    })

    expect(result.created).toEqual([])
    expect(result.failures).toEqual([
      { ruleId: "aggregate-0", reason: "invalid_model_output", inputSeqs: [1, 2] },
    ])
    expect(result.pending).toContainEqual({
      ruleId: "aggregate-0",
      inputSeqs: [1, 2],
      reason: "no_story_group",
    })
  })
})

it("同模型换自定义端点不会命中前一个端点的Story模型缓存", async () => {
  const { db, stories, aiConfig, runtimeDir } = fixture()
  const decisions = [published(db, 1), published(db, 2)]
  let calls = 0
  const execute = async <T>(options: CodexJsonOptions<T>) => {
    calls++
    const output = { groups: [] }
    if (!options.validate(output)) throw new Error("invalid_stub_output")
    return { result: output, model: options.model, durationMs: 1, usage: null, toolCalls: 0 }
  }
  const options = {
    decisions,
    ruleSet: rules([aggregateAction()]),
    stories,
    aiConfig,
    runtimeDir,
    signal: new AbortController().signal,
    execute,
  }
  await aiConfig.save({
    provider: "openai-compatible",
    model: "same-model",
    baseUrl: "https://first.test/v1",
    apiKey: "first-key",
  })
  await runStoryAggregation(options)
  await aiConfig.save({
    provider: "openai-compatible",
    model: "same-model",
    baseUrl: "https://second.test/v1",
    apiKey: "second-key",
  })
  await runStoryAggregation(options)
  await runStoryAggregation(options)
  expect(calls).toBe(2)
})

it("推理强度隔离Story模型缓存，同强度仍可复用", async () => {
  const { db, stories, aiConfig, runtimeDir } = fixture()
  const decisions = [published(db, 1), published(db, 2)]
  let calls = 0
  const efforts: Array<string | undefined> = []
  const execute = async <T>(options: CodexJsonOptions<T>) => {
    calls++
    efforts.push(options.reasoningEffort)
    const output = { groups: [] }
    if (!options.validate(output)) throw new Error("invalid_stub_output")
    return { result: output, model: options.model, durationMs: 1, usage: null, toolCalls: 0 }
  }
  const options = {
    decisions,
    ruleSet: rules([aggregateAction()]),
    stories,
    aiConfig,
    runtimeDir,
    signal: new AbortController().signal,
    execute,
  }
  aiConfig.read = async () => ({ provider: "codex", model: "same-model", reasoningEffort: "low" })
  await runStoryAggregation(options)
  aiConfig.read = async () => ({ provider: "codex", model: "same-model", reasoningEffort: "high" })
  await runStoryAggregation(options)
  await runStoryAggregation(options)
  expect(calls).toBe(2)
  expect(efforts).toEqual(["low", "high"])
})

// 列表目标只唤醒有关事件，模型返回的旁支组也不能顺便发布。
describe("列表触发 Story 范围", () => {
  it("没有本次目标的事件不读取模型配置或执行聚合", async () => {
    const { db, stories, aiConfig, runtimeDir } = fixture()
    const decisions = [published(db, 1), published(db, 2)]
    let calls = 0
    const result = await runStoryAggregation({
      decisions,
      ruleSet: rules([aggregateAction()]),
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      targets: [{ sourceKey: "feed/unloaded", itemId: "unloaded" }],
      execute: async () => {
        calls++
        throw new Error("unexpected_model")
      },
    })
    expect(calls).toBe(0)
    expect(result.created).toEqual([])
    expect(result.updated).toEqual([])
  })
  it("同批上下文可参与，但完全不含目标的模型分组不会发布", async () => {
    const { db, stories, aiConfig, runtimeDir } = fixture()
    const decisions = [1, 2, 3, 4].map((seq) => published(db, seq))
    const result = await runStoryAggregation({
      decisions,
      ruleSet: rules([aggregateAction()]),
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      targets: [{ sourceKey: "feed/1", itemId: "entry-1" }],
      execute: executeWith([pairsOutput([1, 2, 3, 4])]),
    })
    expect(result.created).toHaveLength(1)
    expect(
      stories.currentSnapshot(result.created[0]!.storyId)?.members.map((member) => member.inputSeq),
    ).toEqual([1, 2])
  })
})

it.each(["same_body", "same_fact_wrapper"] as const)(
  "不同URL的%s不冒充两个独立Story来源，原文保持可读",
  async (mode) => {
    const { db, stories, aiConfig, runtimeDir } = fixture()
    const first = published(db, 1)
    const quote = first.decision.facts[0]!.quote
    const secondText = mode === "same_body" ? quote : `转载导语。${quote}`
    const second = casePublished(db, 2, secondText, fixtureEvent(secondText))
    second.input.body.title = "改标题的转载"
    second.decision.facts = [{ text: "抽取换一种措辞", quote, kind: "source_claim" }]
    const prompts: string[] = []
    const result = await runStoryAggregation({
      decisions: [first, second],
      ruleSet: rules([aggregateAction()]),
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      execute: executeWith([], prompts),
    })
    expect(prompts).toEqual([])
    expect(result.created).toEqual([])
    expect(stories.list()).toEqual([])
    expect([first.decision.status, second.decision.status]).toEqual(["keep", "keep"])
    expect([first.input.body.read, second.input.body.read]).toEqual([false, false])
  },
)

it("完整转载和仅改标题/抽取措辞不更新Story，不刷新实质未读或收藏", async () => {
  const { db, stories, aiConfig, runtimeDir } = fixture()
  const first = [published(db, 1), published(db, 2)]
  const base = {
    decisions: first,
    ruleSet: rules([aggregateAction()]),
    stories,
    aiConfig,
    runtimeDir,
    signal: new AbortController().signal,
  }
  const created = await runStoryAggregation({ ...base, execute: executeWith([modelOutput()]) })
  const storyId = created.created[0]!.storyId
  const prior = stories.currentSnapshot(storyId)!
  stories.markRead(storyId, "reader")
  stories.setCollected(storyId, "reader", true)
  const body = first[0]!.decision.facts[0]!.quote
  const repost = casePublished(db, 3, body, fixtureEvent(body))
  repost.input.body.title = "原标题改名，但事实未变"
  repost.decision.facts = [{ text: "换一种写法的同一事实", quote: body, kind: "source_claim" }]
  const prompts: string[] = []
  const unchanged = await runStoryAggregation({
    ...base,
    decisions: [repost],
    execute: executeWith([], prompts),
  })
  expect(prompts).toEqual([])
  expect(unchanged.created).toEqual([])
  expect(unchanged.updated).toEqual([])
  expect(unchanged.pending).toEqual([])
  expect(stories.currentSnapshot(storyId)).toEqual(prior)
  expect(stories.readStatus(storyId, "reader").unread).toBe(false)
  expect(stories.isCollected(storyId, "reader")).toBe(true)
  expect(repost.decision.status).toBe("keep")
})

it("新增限制进入更新并保留旧句、事实和原始引用", async () => {
  const { db, stories, aiConfig, runtimeDir } = fixture()
  const base = {
    decisions: [published(db, 1), published(db, 2)],
    ruleSet: rules([aggregateAction()]),
    stories,
    aiConfig,
    runtimeDir,
    signal: new AbortController().signal,
  }
  const created = await runStoryAggregation({ ...base, execute: executeWith([modelOutput()]) })
  const storyId = created.created[0]!.storyId
  const prior = stories.currentSnapshot(storyId)!
  stories.markRead(storyId, "reader")
  const update = published(db, 3)
  const quote = update.decision.facts[0]!.quote
  const output: StoryModelOutput = {
    groups: [
      {
        existingStoryId: storyId,
        title: prior.title,
        body: "自由正文不作为持久化来源",
        retainedSentenceIds: prior.sentences.map((sentence) => sentence.id),
        retainedFactIds: prior.facts.map((fact) => fact.id),
        sentences: [{ text: quote, sources: [{ inputSeq: 3, evidenceId: evidenceId(3) }] }],
        facts: [
          {
            text: "新增明确限制",
            kind: "source_claim",
            sentenceIndexes: [0],
            dependsOnFactIndexes: [],
            dependsOnRetainedFactIds: [],
          },
        ],
      },
    ],
  }
  const prompts: string[] = []
  const result = await runStoryAggregation({
    ...base,
    decisions: [update],
    execute: executeWith([output], prompts),
  })
  expect(prompts).toHaveLength(1)
  expect(result.updated).toEqual([{ storyId, ruleId: "aggregate-0", revision: 2 }])
  const current = stories.currentSnapshot(storyId)!
  expect(current.sentences).toEqual(expect.arrayContaining(prior.sentences))
  expect(current.facts).toEqual(expect.arrayContaining(prior.facts))
  expect(current.sourceSpans).toEqual(expect.arrayContaining(prior.sourceSpans))
  expect(current.citations).toEqual(expect.arrayContaining(prior.citations))
  expect(stories.readStatus(storyId, "reader").unread).toBe(true)
})

it("事实子集不能证明未抽取的新限制不存在，未知增量仍交给更新模型且不隐藏原文", async () => {
  const { db, stories, aiConfig, runtimeDir } = fixture()
  const first = [published(db, 1), published(db, 2)]
  const base = {
    decisions: first,
    ruleSet: rules([aggregateAction()]),
    stories,
    aiConfig,
    runtimeDir,
    signal: new AbortController().signal,
  }
  const created = await runStoryAggregation({ ...base, execute: executeWith([modelOutput()]) })
  const original = first[0]!.decision.facts[0]!.quote
  const text = `${original}额外限制：只适用于测试环境，生产不适用。`
  const update = casePublished(db, 3, text, fixtureEvent(text))
  update.decision.facts = [
    { text: first[0]!.decision.facts[0]!.text, quote: original, kind: "fact" },
  ]
  const prompts: string[] = []
  const result = await runStoryAggregation({
    ...base,
    decisions: [update],
    execute: executeWith([{ groups: [] }], prompts),
  })
  expect(prompts).toHaveLength(1)
  expect(result.updated).toEqual([])
  expect(stories.currentSnapshot(created.created[0]!.storyId)?.revision).toBe(1)
  expect(update.decision.status).toBe("keep")
  expect(update.input.body.content).toContain("生产不适用")
})

it("更新缓存绑定当前Story revision，人工展示修订后不复用先前update草稿", async () => {
  const { db, stories, aiConfig, runtimeDir } = fixture()
  const base = {
    decisions: [published(db, 1), published(db, 2)],
    ruleSet: rules([aggregateAction()]),
    stories,
    aiConfig,
    runtimeDir,
    signal: new AbortController().signal,
  }
  const created = await runStoryAggregation({ ...base, execute: executeWith([modelOutput()]) })
  const storyId = created.created[0]!.storyId
  const update = published(db, 3)
  const prompts: string[] = []
  const options = {
    ...base,
    decisions: [update],
    execute: executeWith([{ groups: [] }, { groups: [] }], prompts),
  }
  await runStoryAggregation(options)
  const current = stories.currentSnapshot(storyId)!
  stories.appendRevision(storyId, 1, { ...current, title: "人工修订标题" })
  const differentRevision = await runStoryAggregation(options)
  expect(prompts).toHaveLength(2)
  expect(differentRevision.cacheHits).toBe(0)
  const sameRevision = await runStoryAggregation(options)
  expect(prompts).toHaveLength(2)
  expect(sameRevision.cacheHits).toBe(1)
})

const unresolvedStoryMaterials: Array<[string, Partial<ProcessingInput["body"]>]> = [
  ["图片未读", { imageCount: 1, context: { images: "missing" } }],
  ["引用未读", { context: { quote: "missing" } }],
  [
    "外链失败",
    {
      linkedMaterials: [
        {
          url: "https://example.test/context",
          resolvedUrl: null,
          title: null,
          content: null,
          status: "failed",
          failure: "fetch_failed",
        },
      ],
    },
  ],
  ["视频未读", { mediaLength: 1, imageCount: 0 }],
  ["附件时长", { attachmentsDuration: 10 }],
  ["图已读但材料身份不同", { imageCount: 1, context: { images: "complete" } }],
  [
    "已读新外链仍有独立材料",
    {
      linkedMaterials: [
        {
          url: "https://example.test/new-context",
          resolvedUrl: "https://example.test/new-context",
          title: "额外方法",
          content: "旧摘引之外的新方法。",
          status: "complete",
          failure: null,
        },
      ],
    },
  ],
]
it.each(unresolvedStoryMaterials)("正文相同但%s不能用有限证据判零增量", async (_name, context) => {
  const { db, stories, aiConfig, runtimeDir } = fixture()
  const first = [published(db, 1), published(db, 2)]
  const base = {
    decisions: first,
    ruleSet: rules([aggregateAction()]),
    stories,
    aiConfig,
    runtimeDir,
    signal: new AbortController().signal,
  }
  const created = await runStoryAggregation({ ...base, execute: executeWith([modelOutput()]) })
  const body = first[0]!.decision.facts[0]!.quote
  const update = casePublished(db, 3, body, fixtureEvent(body))
  update.input.body = { ...update.input.body, ...context }
  const prompts: string[] = []
  const result = await runStoryAggregation({
    ...base,
    decisions: [update],
    execute: executeWith([{ groups: [] }], prompts),
  })
  expect(prompts).toHaveLength(1)
  expect(result.updated).toEqual([])
  expect(stories.currentSnapshot(created.created[0]!.storyId)?.revision).toBe(1)
  expect(update.decision.status).toBe("keep")
})

// 并列周报的序号绑定不可变单篇决定；两段都有独立原文范围，不能以主题代替事实归属。
function weeklyPublished(db: DatabaseSync, seq: number, first: string, second: string) {
  const primary = caseEvent(first, "Acme", "product_release", "Widget", { version: "2.0" })
  const other = caseEvent(second, "Beta", "product_release", "Tool", { version: "3.0" })
  const item = casePublished(db, seq, `${first}\n${second}`, primary)
  item.decision.semantic!.event = null
  item.decision.semantic!.eventMentions = [
    { identity: primary, role: "reports", isPrimary: false },
    { identity: other, role: "reports", isPrimary: false },
  ]
  item.decision.facts = [first, second].map((quote, eventMentionIndex) => ({
    text: quote,
    quote,
    kind: "fact",
    eventMentionIndex,
  }))
  db.prepare("UPDATE entry_decisions SET body=? WHERE id=?").run(
    JSON.stringify(item.decision),
    item.decisionId,
  )
  return item
}

it("无主事件的两篇周报分别向两个Story贡献，发布边界拒绝交叉引用并保留原文", async () => {
  const { db, stories, aiConfig, runtimeDir } = fixture()
  const a = [
    "Acme released Widget 2.0 with faster sync.",
    "Beta released Tool 3.0 with offline support.",
  ]
  const b = [
    "Acme released Widget 2.0 with encryption.",
    "Beta released Tool 3.0 with regional storage.",
  ]
  const decisions = [weeklyPublished(db, 1, a[0]!, a[1]!), weeklyPublished(db, 2, b[0]!, b[1]!)]
  const prompts: string[] = []
  const output = await runStoryAggregation({
    decisions,
    ruleSet: rules([aggregateAction()]),
    stories,
    aiConfig,
    runtimeDir,
    signal: new AbortController().signal,
    execute: executeWith([modelOutput(), modelOutput()], prompts),
    alreadyClaimedInputSeqs: [1, 2],
    sameEventEligible: (_, eventMentionIndex) => eventMentionIndex === 0 || eventMentionIndex === 1,
    registeredEventId: (members) =>
      new Set(members.map((member) => member.eventMentionIndex)).size === 1
        ? `event-${members[0]!.eventMentionIndex}`
        : null,
  })
  expect(output.created).toHaveLength(2)
  expect(prompts).toHaveLength(2)
  expect(prompts[0]).toContain(a[0]!)
  expect(prompts[0]).not.toContain(a[1]!)
  expect(prompts[1]).toContain(a[1]!)
  expect(prompts[1]).not.toContain(a[0]!)
  const revisions = output.created.map((created) => stories.currentSnapshot(created.storyId)!)
  expect(
    revisions.map((revision) => revision.members.map((member) => member.eventMentionIndex)),
  ).toEqual([
    [0, 0],
    [1, 1],
  ])
  expect(revisions.map((revision) => revision.sourceSpans.map((span) => span.quote))).toEqual([
    [a[0], b[0]],
    [a[1], b[1]],
  ])
  const contaminated = {
    ...revisions[0]!,
    sourceSpans: revisions[0]!.sourceSpans.map((span) =>
      span.inputSeq === 1
        ? {
            ...span,
            quote: a[1]!,
            fragmentId: sourceSpanFragmentId(
              decisions[0]!.input.itemId,
              decisions[0]!.input.contentVersion,
              a[1]!,
            ),
          }
        : span,
    ),
  }
  expect(() => stories.appendRevision(revisions[0]!.storyId, 1, contaminated)).toThrow(
    "invalid_reference",
  )
  expect(
    decisions.every(
      (published) => published.decision.status === "keep" && published.decision.facts.length === 2,
    ),
  ).toBe(true)
})

it("事件片段被人工禁用、没有归属或跨片段证据时不会借其他事实发布", async () => {
  const { db, stories, aiConfig, runtimeDir } = fixture()
  const decisions = [
    weeklyPublished(
      db,
      1,
      "Acme released Widget 2.0 with sync.",
      "Beta released Tool 3.0 with offline support.",
    ),
    weeklyPublished(
      db,
      2,
      "Acme released Widget 2.0 with encryption.",
      "Beta released Tool 3.0 with storage.",
    ),
  ]
  const prompts: string[] = []
  const output = await runStoryAggregation({
    decisions,
    ruleSet: rules([aggregateAction()]),
    stories,
    aiConfig,
    runtimeDir,
    signal: new AbortController().signal,
    execute: executeWith([modelOutput()], prompts),
    sameEventEligible: (_, eventMentionIndex) => eventMentionIndex === 1,
  })
  expect(output.created).toHaveLength(1)
  expect(
    stories
      .currentSnapshot(output.created[0]!.storyId)!
      .members.every((member) => member.eventMentionIndex === 1),
  ).toBe(true)
  expect(prompts[0]).not.toContain("Acme")
  const invalid = decisions[0]!.decision.facts[0]!
  invalid.eventMentionIndex = 1
  decisions[0]!.decision.facts[1]!.eventMentionIndex = null
  expect(
    await runStoryAggregation({
      decisions,
      ruleSet: rules([aggregateAction()]),
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      sameEventEligible: (_, index) => index === 1,
      execute: async () => {
        throw new Error("无许可证不应调用模型")
      },
    }),
  ).toMatchObject({ created: [], updated: [], failures: [] })
})

it("有显式事件事实许可证的分析可贡献独有解释，旧无归属观点仍独立", async () => {
  const { db, stories, aiConfig, runtimeDir } = fixture()
  const report = "Acme released Widget 2.0 with encryption."
  const analysis =
    "Acme released Widget 2.0; analysis finds encryption reduces synchronization risk."
  const first = casePublished(
    db,
    1,
    report,
    caseEvent(report, "Acme", "product_release", "Widget", { version: "2.0" }),
  )
  const second = casePublished(
    db,
    2,
    analysis,
    caseEvent(analysis, "Acme", "product_release", "Widget", { version: "2.0" }),
  )
  const identity = { ...second.decision.semantic!.event!, kind: "analysis" as const }
  second.decision.semantic!.event = identity
  second.decision.semantic!.eventMentions = [{ identity, role: "analysis_of", isPrimary: true }]
  second.decision.facts = [
    {
      text: "Encryption reduces synchronization risk",
      quote: analysis,
      kind: "source_claim",
      eventMentionIndex: 0,
    },
  ]
  db.prepare("UPDATE entry_decisions SET body=? WHERE id=?").run(
    JSON.stringify(second.decision),
    second.decisionId,
  )
  const result = await runStoryAggregation({
    decisions: [first, second],
    ruleSet: rules([aggregateAction()]),
    stories,
    aiConfig,
    runtimeDir,
    signal: new AbortController().signal,
    execute: executeWith([modelOutput()]),
    sameEventEligible: () => true,
  })
  expect(result.created).toHaveLength(1)
  expect(
    stories.currentSnapshot(result.created[0]!.storyId)!.sourceSpans.map((span) => span.quote),
  ).toContain(analysis)
  expect(second.decision.status).toBe("keep")
})
