import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { DatabaseSync } from "node:sqlite"

import type { RuleSet } from "@follow/information-core"
import { afterEach, describe, expect, it } from "vitest"

import { AIConfigStore } from "./ai-config"
import type { ProcessingInput } from "./automation-store"
import type { CodexJsonOptions } from "./codex"
import type { PublishedDecision } from "./processing-decision"
import { runStoryAggregation } from "./story-engine"
import { StoryStore } from "./story-store"

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
  return {
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
      semantic: null,
      reused: false,
      ...overrides,
    },
  } satisfies PublishedDecision
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

function modelOutput(existingStoryId: string | null = null) {
  return {
    groups: [
      {
        existingStoryId,
        title: "同一事件",
        body: "两份来源都确认了该事件。",
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
          },
        ],
      },
    ],
  }
}

function evidenceId(inputSeq: number, factIndex = 0) {
  return `evidence-${inputSeq}-${factIndex}`
}

function pairsOutput(sequences: number[]) {
  return {
    groups: Array.from({ length: sequences.length / 2 }, (_, index) => {
      const first = sequences[index * 2]!
      const second = sequences[index * 2 + 1]!
      return {
        existingStoryId: null,
        title: `事件 ${first}-${second}`,
        body: `来源 ${first} 与 ${second} 的事实。`,
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

describe("Story 模型聚合", () => {
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
    expect(prompts[0]).toContain("更新已有 Story，说明新增和修正。")
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
            },
            {
              text: "来源 2 的可核查事实。",
              kind: "fact",
              sentenceIndexes: [1],
              dependsOnFactIndexes: [],
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
              sentences: [
                {
                  text: "来源 23 的可核查事实。",
                  sources: [{ inputSeq: 23, evidenceId: evidenceId(23) }],
                },
              ],
              facts: [
                {
                  text: "来源 23 的可核查事实。",
                  kind: "fact",
                  sentenceIndexes: [0],
                  dependsOnFactIndexes: [],
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
