import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { DatabaseSync } from "node:sqlite"

import type { RuleSet } from "@follow/information-core"
import { afterEach, describe, expect, it } from "vitest"

import { AIConfigStore } from "./ai-config"
import type { ProcessingInput } from "./automation-store"
import type { CodexJsonOptions } from "./codex"
import type { PublishedDecision } from "./processing-decision"
import { runStoryRepair } from "./story-repair"
import type { StoryRevisionDraft } from "./story-store"
import { sourceSpanFragmentId, StoryStore } from "./story-store"

const databases: DatabaseSync[] = []
const directories: string[] = []

function fixture() {
  const db = new DatabaseSync(":memory:")
  databases.push(db)
  db.exec(
    `CREATE TABLE processing_inputs (seq INTEGER PRIMARY KEY,source_key TEXT,item_id TEXT,content_version TEXT,body TEXT,received_at TEXT,release_version INTEGER,generation INTEGER,status TEXT,current INTEGER,decision_id TEXT); CREATE TABLE entry_decisions (id TEXT PRIMARY KEY,input_seq INTEGER,generation INTEGER,release_version INTEGER,body TEXT,created_at TEXT);`,
  )
  const directory = mkdtempSync(`${tmpdir()}/story-repair-`)
  directories.push(directory)
  writeFileSync(`${directory}/ai.json`, JSON.stringify({ provider: "codex", model: "test" }))
  return {
    db,
    stories: new StoryStore(db),
    runtimeDir: directory,
    aiConfig: new AIConfigStore(`${directory}/ai.json`),
  }
}

function add(
  db: DatabaseSync,
  seq: number,
  version = "v1",
  current = true,
  content = `证据 ${seq}`,
  releaseVersion = 1,
) {
  const sourceKey = `feed/${seq}`
  const itemId = `entry-${seq}`
  const decisionId = `decision-${seq}-${version}`
  db.prepare("INSERT INTO processing_inputs VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
    seq,
    sourceKey,
    itemId,
    version,
    JSON.stringify({ id: itemId, sourceKey, content: `<p>${content}</p>` }),
    "2026-09-12T00:00:00.000Z",
    releaseVersion,
    1,
    "succeeded",
    Number(current),
    decisionId,
  )
  db.prepare("INSERT INTO entry_decisions VALUES(?,?,?,?,?,?)").run(
    decisionId,
    seq,
    1,
    releaseVersion,
    "{}",
    "2026-09-12T00:00:00.000Z",
  )
  const input: ProcessingInput = {
    seq,
    sourceKey,
    itemId,
    contentVersion: version,
    receivedAt: "2026-09-12T00:00:00.000Z",
    releaseVersion,
    generation: 1,
    status: "succeeded",
    current,
    body: {
      id: itemId,
      sourceKey,
      title: itemId,
      url: null,
      publishedAt: "2026-09-12T00:00:00.000Z",
      read: false,
      content: `<p>${content}</p>`,
      description: null,
    },
  }
  return {
    input,
    decisionId,
    decision: {
      schemaVersion: 1,
      fingerprint: decisionId,
      provider: "codex" as const,
      model: "test",
      generatedAt: input.receivedAt,
      durationMs: 1,
      usage: null,
      status: "keep" as const,
      title: itemId,
      summary: content,
      reason: "ok",
      labels: [],
      policy: {
        standalone: "auto" as const,
        aggregation: "allow" as const,
        rewrite: "allow" as const,
      },
      sourceRole: "source",
      context: { source_id: sourceKey, contextId: sourceKey },
      facts: [{ text: content, quote: content, kind: "fact" as const }],
      semantic: null,
      reused: false,
    },
  } satisfies PublishedDecision
}

function draft(items: PublishedDecision[]): StoryRevisionDraft {
  const spans = items.map((item) => ({
    id: `span-${item.input.seq}`,
    inputSeq: item.input.seq,
    sourceItemId: item.input.itemId,
    contentVersion: item.input.contentVersion,
    fragmentId: sourceSpanFragmentId(
      item.input.itemId,
      item.input.contentVersion,
      item.decision.facts[0]!.quote,
    ),
    quote: item.decision.facts[0]!.quote,
    sourceRole: "source",
  }))
  const citations = items.map((item) => ({
    id: `citation-${item.input.seq}`,
    sourceSpanId: `span-${item.input.seq}`,
    sentenceId: `sentence-${item.input.seq}`,
  }))
  return {
    title: "旧 Story",
    body: items.map((item) => item.decision.facts[0]!.quote).join("\n"),
    aggregationRuleId: "rule",
    aggregationScopeVersion: scope(),
    appliedRuleSetVersion: 1,
    instructionFingerprint: "old",
    members: items.map((item) => ({ inputSeq: item.input.seq, decisionId: item.decisionId })),
    sourceSpans: spans,
    citations,
    sentences: items.map((item) => ({
      id: `sentence-${item.input.seq}`,
      text: item.decision.facts[0]!.quote,
      citationIds: [`citation-${item.input.seq}`],
    })),
    facts: [
      ...items.map((item) => ({
        id: `fact-${item.input.seq}`,
        kind: "fact" as const,
        text: item.decision.facts[0]!.quote,
        citationIds: [`citation-${item.input.seq}`],
        dependsOnFactIds: [],
      })),
      {
        id: "inference",
        kind: "inference" as const,
        text: "旧推断",
        citationIds: ["citation-1"],
        dependsOnFactIds: ["fact-1"],
      },
    ],
  }
}

function scope() {
  return "83a1baa8d8f951a135d5fa17080d8e82009243c427159a163029852885d698ae"
}
function rules(when: RuleSet["rules"][number]["when"] = { all: true }): RuleSet {
  return {
    formatVersion: 4,
    ownerId: "owner",
    global: { version: 1, markdown: "" },
    rules: [
      {
        id: "rule",
        ownerId: "owner",
        name: "修复",
        enabled: true,
        order: 0,
        when,
        actions: [
          {
            type: "ai_aggregate",
            createPrompt: "create",
            updatePrompt: "repair",
            mode: "same_event",
            scope: { all: true },
          },
        ],
        version: 1,
        executionLocation: "processing_service",
      },
    ],
  }
}
function evidenceId(inputSeq: number, factIndex = 0) {
  return `evidence-${inputSeq}-${factIndex}`
}

function addSemantic(decision: PublishedDecision) {
  decision.decision = {
    ...decision.decision,
    semantic: {
      entryId: decision.input.itemId,
      title: decision.decision.title,
      summary: decision.decision.summary,
      disposition: "keep",
      reason: "ok",
      aggregation: true,
      rewrite: true,
      labels: [],
      facts: decision.decision.facts,
    },
  }
}

function rulesWithDeniedSource(sourceId: string): RuleSet {
  const config = rules()
  config.rules[0]!.order = 1
  config.rules.unshift({
    id: "target-policy",
    ownerId: "owner",
    name: "目标版本资格",
    enabled: true,
    order: 0,
    when: {
      anyOf: [{ allOf: [{ field: "source_id", operator: "in", value: [sourceId] }] }],
    },
    actions: [{ type: "presentation", policy: { aggregation: "deny", rewrite: "deny" } }],
    version: 1,
    executionLocation: "processing_service",
  })
  return config
}

function output(seqs: number[], quotes: string[]) {
  return {
    title: "修复 Story",
    sentences: seqs.map((inputSeq, index) => ({
      text: quotes[index]!,
      sources: [{ inputSeq, evidenceId: evidenceId(inputSeq) }],
    })),
    facts: seqs.map((_, index) => ({
      text: quotes[index]!,
      kind: "fact" as const,
      sentenceIndexes: [index],
      dependsOnFactIndexes: [],
    })),
  }
}
function execute(value: unknown) {
  return async <T>(options: CodexJsonOptions<T>) => {
    if (!options.validate(value)) throw new Error("bad_output")
    return { result: value, model: options.model, durationMs: 1, usage: null, toolCalls: 0 }
  }
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("Story repair", () => {
  it("移除三成员之一后沿用原 ID 修复为两成员", async () => {
    const { db, stories, aiConfig, runtimeDir } = fixture()
    const values = [add(db, 1), add(db, 2), add(db, 3)]
    const original = stories.create(draft(values))
    stories.removeMember(original.storyId, 1, 3)
    const result = await runStoryRepair({
      decisions: values,
      ruleSets: [rules()],
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      execute: execute(output([1, 2], ["证据 1", "证据 2"])),
    })
    expect(result.repaired).toEqual([{ storyId: original.storyId, revision: 2 }])
    expect(stories.currentSnapshot(original.storyId)?.members.map((item) => item.inputSeq)).toEqual(
      [1, 2],
    )
  })

  it("修复时拒绝跨候选 evidenceId，不能借另一篇材料的原文引用", async () => {
    const { db, stories, aiConfig, runtimeDir } = fixture()
    const values = [add(db, 1), add(db, 2), add(db, 3)]
    const original = stories.create(draft(values))
    stories.removeMember(original.storyId, 1, 3)
    const invalid = output([1, 2], ["证据 1", "证据 2"])
    invalid.sentences[0]!.sources[0] = { inputSeq: 1, evidenceId: evidenceId(2) }

    const result = await runStoryRepair({
      decisions: values,
      ruleSets: [rules()],
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      execute: execute(invalid),
    })

    expect(result.failures).toEqual([{ storyId: original.storyId, reason: "invalid_model_output" }])
    expect(stories.resolveLink(original.storyId)).toMatchObject({ kind: "repairing" })
  })

  it("scope unknown 时保留 repairing，不以剩余材料补写 Story", async () => {
    const { db, stories, aiConfig, runtimeDir } = fixture()
    const values = [add(db, 1), add(db, 2), add(db, 3)]
    const original = stories.create(draft(values))
    stories.removeMember(original.storyId, 1, 3)
    const result = await runStoryRepair({
      decisions: values,
      ruleSets: [
        rules({
          anyOf: [{ allOf: [{ field: "subscription_tag", operator: "in", value: ["project"] }] }],
        }),
      ],
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      execute: async () => {
        throw new Error("unknown scope must not call model")
      },
    })
    expect(result.pending).toEqual([{ storyId: original.storyId, reason: "scope_unknown" }])
    expect(stories.resolveLink(original.storyId)).toMatchObject({ kind: "repairing" })
  })

  it("有 release 目录但不存在历史版本时不会把新规则套到旧 Story", async () => {
    const { db, stories, aiConfig, runtimeDir } = fixture()
    const values = [add(db, 1), add(db, 2), add(db, 3)]
    const original = stories.create(draft(values))
    stories.removeMember(original.storyId, 1, 3)
    const result = await runStoryRepair({
      decisions: values,
      ruleSets: [rules()],
      releasedRuleSets: [{ version: 2, config: rules() }],
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      execute: async () => {
        throw new Error("unavailable historical rule must not call model")
      },
    })
    expect(result.pending).toEqual([{ storyId: original.storyId, reason: "rule_unavailable" }])
    expect(stories.resolveLink(original.storyId)).toMatchObject({ kind: "repairing" })
  })

  it("混合 release 按成员最高目标版本重校验后完成修复", async () => {
    const { db, stories, aiConfig, runtimeDir } = fixture()
    const old = add(db, 1, "v1", true, "旧版本证据", 1)
    addSemantic(old)
    const current = add(db, 2, "v1", true, "新版本证据", 2)
    const removed = add(db, 3, "v1", true, "待移除证据", 2)
    const original = stories.create(draft([old, current, removed]))
    stories.removeMember(original.storyId, 1, 3)

    const result = await runStoryRepair({
      decisions: [old, current, removed],
      ruleSets: [rules(), rules()],
      releasedRuleSets: [
        { version: 1, config: rules() },
        { version: 2, config: rules() },
      ],
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      execute: execute(output([1, 2], ["旧版本证据", "新版本证据"])),
    })

    expect(result.pending).toEqual([])
    expect(result.repaired).toEqual([{ storyId: original.storyId, revision: 2 }])
    expect(stories.currentSnapshot(original.storyId)?.appliedRuleSetVersion).toBe(2)
  })

  it("混合 release 不沿用旧 allow，按目标版本将失去资格的成员移出修复", async () => {
    const { db, stories, aiConfig, runtimeDir } = fixture()
    const old = add(db, 1, "v1", true, "旧版本证据", 1)
    addSemantic(old)
    const current = add(db, 2, "v1", true, "新版本证据", 2)
    const removed = add(db, 3, "v1", true, "待移除证据", 2)
    const original = stories.create(draft([old, current, removed]))
    stories.removeMember(original.storyId, 1, 3)
    const targetRules = rulesWithDeniedSource("feed/1")

    const result = await runStoryRepair({
      decisions: [old, current, removed],
      ruleSets: [rules(), targetRules],
      releasedRuleSets: [
        { version: 1, config: rules() },
        { version: 2, config: targetRules },
      ],
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      execute: async () => {
        throw new Error("目标版本排除后不足两份，不应调用模型")
      },
    })

    expect(result.pending).toEqual([])
    expect(result.independent).toEqual([
      { storyId: original.storyId, inputSeqs: [2], reason: "insufficient_sources" },
    ])
    expect(stories.resolveLink(original.storyId)).toMatchObject({ kind: "independent" })
  })

  it("撤回材料后旧事实和推断不进入新 revision；不足两份进入独立入口", async () => {
    const { db, stories, aiConfig, runtimeDir } = fixture()
    const values = [add(db, 1), add(db, 2), add(db, 3)]
    const original = stories.create(draft(values))
    stories.withdrawMaterial(3, "撤回")
    await runStoryRepair({
      decisions: values,
      ruleSets: [rules()],
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      execute: execute(output([1, 2], ["证据 1", "证据 2"])),
    })
    expect(
      stories.currentSnapshot(original.storyId)?.facts.some((item) => item.kind === "inference"),
    ).toBe(false)
    expect(
      stories.currentSnapshot(original.storyId)?.sourceSpans.some((item) => item.inputSeq === 3),
    ).toBe(false)
    const second = stories.create(draft(values.slice(0, 2)))
    stories.removeMember(second.storyId, 1, 2)
    const independent = await runStoryRepair({
      decisions: values.slice(0, 1),
      ruleSets: [rules()],
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      execute: execute(output([1], ["证据 1"])),
    })
    expect(independent.independent).toContainEqual({
      storyId: second.storyId,
      inputSeqs: [1],
      reason: "insufficient_sources",
    })
    expect(stories.resolveLink(second.storyId)).toMatchObject({ kind: "independent" })
  })

  it("新正文按同来源身份映射 current 版本，deny 或 unknown 不会补回旧 Story", async () => {
    const { db, stories, aiConfig, runtimeDir } = fixture()
    const old = add(db, 1)
    const second = add(db, 2)
    const story = stories.create(draft([old, second]))
    const replacement = add(db, 4, "v2", true, "新版证据")
    db.prepare("UPDATE processing_inputs SET current=0 WHERE seq=1").run()
    db.prepare(
      "UPDATE processing_inputs SET source_key='feed/1',item_id='entry-1' WHERE seq=4",
    ).run()
    replacement.input = {
      ...replacement.input,
      sourceKey: "feed/1",
      itemId: "entry-1",
      body: { ...replacement.input.body, sourceKey: "feed/1", id: "entry-1" },
    }
    replacement.decision = {
      ...replacement.decision,
      context: { source_id: "feed/1", contextId: "feed/1" },
    }
    stories.invalidateInputs([1])
    const repaired = await runStoryRepair({
      decisions: [replacement, second],
      ruleSets: [rules()],
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      execute: execute(output([4, 2], ["新版证据", "证据 2"])),
    })
    expect(repaired.repaired).toEqual([{ storyId: story.storyId, revision: 2 }])
    expect(stories.currentSnapshot(story.storyId)?.sourceSpans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ inputSeq: 4, contentVersion: "v2", quote: "新版证据" }),
      ]),
    )

    stories.invalidateInputs([4])
    const denied = {
      ...replacement,
      decision: {
        ...replacement.decision,
        policy: { ...replacement.decision.policy, aggregation: "deny" as const },
      },
    }
    const noRepair = await runStoryRepair({
      decisions: [denied, second],
      ruleSets: [rules()],
      stories,
      aiConfig,
      runtimeDir,
      signal: new AbortController().signal,
      execute: execute(output([2], ["证据 2"])),
    })
    expect(noRepair.independent).toContainEqual({
      storyId: story.storyId,
      inputSeqs: [2],
      reason: "insufficient_sources",
    })
    expect(stories.resolveLink(story.storyId)).toMatchObject({ kind: "independent" })
  })
})
