import { randomUUID } from "node:crypto"

import type { RuleSet, TagAssessment } from "@follow/information-core"
import { describe, expect, it, vi } from "vitest"

import type { AIConfigStore } from "./ai-config"
import type { CodexJsonOptions } from "./codex"
import { processingApi } from "./processing-api"
import { runEntryProcessing } from "./processing-engine"
import { Store } from "./store"

const config: RuleSet = {
  formatVersion: 5,
  ownerId: "owner",
  global: { version: 1, markdown: "" },
  rules: [
    {
      id: "noise",
      ownerId: "owner",
      name: "隐藏闲聊",
      enabled: true,
      order: 0,
      version: 1,
      executionLocation: "processing_service",
      when: {
        anyOf: [
          {
            allOf: [
              { field: "source_id", operator: "in", value: ["feed/1"] },
              {
                field: "entry_tag",
                operator: "contains_any",
                value: ["signal:social_chatter"],
                minConfidence: 0.9,
              },
            ],
          },
        ],
      },
      actions: [{ type: "reading_decision", visibility: "hide", aggregationEligibility: "deny" }],
    },
  ],
}
const assessment: TagAssessment = {
  tagId: "signal:social_chatter",
  definitionVersion: 1,
  state: "present",
  confidence: 0.98,
  reason: "全文只有问候。",
  evidenceIds: ["E000001"],
}
function fixture(count = 1) {
  const store = new Store(":memory:")
  store.bindOwner("owner")
  store.replaceSources([
    { key: "feed/1", kind: "feed", id: "1", title: "来源", view: 0, category: null },
  ])
  store.automation.saveDraft(config, 0)
  store.automation.publish(1, { mode: "future" }, randomUUID())
  for (let index = 1; index <= count; index++)
    store.saveEntry({
      id: `e${index}`,
      sourceKey: "feed/1",
      title: "问候",
      url: `https://example.test/${index}`,
      publishedAt: "2026-10-06T00:00:00Z",
      content: "大家早上好！",
      description: null,
      read: false,
    })
  for (const input of store.automation.inputs())
    store.processingState.setMaterial(input, "complete")
  const aiConfig = {
    read: async () => ({ provider: "codex", model: "fake", reasoningEffort: "low" }),
    execution: async () => undefined,
  } as unknown as AIConfigStore
  return {
    store,
    options: {
      store,
      aiConfig,
      sourceKeys: ["feed/1"],
      runtimeDir: "/tmp",
      historySince: "2026-10-01T00:00:00Z",
      signal: new AbortController().signal,
    },
  }
}
function output(entryId: string, tag: TagAssessment) {
  return {
    entryId,
    event: null,
    title: "问候",
    summary: "原始完整摘要保留证据",
    disposition: "hide",
    reason: "模型建议",
    aggregation: false,
    rewrite: false,
    labels: [],
    facts: [],
    tagAssessments: [tag],
    materialCoverage: "complete",
    substantiveContribution: {
      state: "absent",
      confidence: 0.98,
      reason: "全文只有问候。",
      evidenceIds: [],
    },
    eventMentions: [],
    entities: [],
  }
}
function executor(tag = assessment) {
  return async <T>(request: CodexJsonOptions<T>) => {
    const ids = [...request.prompt.matchAll(/"entryId":"(e\d+)"/gu)].map((match) => match[1]!)
    const result =
      ids.length > 1
        ? {
            items: ids.map((id, index) =>
              output(id, {
                ...tag,
                evidenceIds: tag.state === "present" ? [`B${index + 1}E000001`] : [],
              }),
            ),
          }
        : output(ids[0] ?? /entryId=(e\d+)/u.exec(request.prompt)?.[1] ?? "e1", tag)
    expect(request.validate(result)).toBe(true)
    return { result: result as T, model: request.model, durationMs: 1, usage: null, toolCalls: 0 }
  }
}

describe("语义分类正式发布链路", () => {
  it("独立标签分类在全局语言指令下不会因模型 hide 建议隐藏条目", async () => {
    const { store, options } = fixture()
    try {
      const classify = {
        ...config,
        global: { version: 1, markdown: "使用中文输出" },
        rules: [
          {
            ...config.rules[0]!,
            id: "classify",
            when: { all: true as const },
            actions: [{ type: "ai_classify" as const, tagIds: [assessment.tagId] }],
          },
        ],
      }
      store.automation.saveDraft(classify, 1)
      store.automation.publish(2, { mode: "future" }, randomUUID())
      const entry = store.entry("feed/1", "e1")!
      store.saveEntry({ ...entry, content: "大家早上好！标签分类验收。" })
      store.processingState.setMaterial(store.automation.current("feed/1", "e1")!, "complete")
      await runEntryProcessing({ ...options, execute: executor() })
      const published = store.processingState.published()[0]!
      expect(published.decision.status).toBe("keep")
      expect(published.decision.policy.standalone).toBe("auto")
      expect(published.decision.semanticProfile?.assessments).toEqual([assessment])
    } finally {
      store.close()
    }
  })
  it("既有定时批次不会因为新增分类动作请求标签", async () => {
    const { store, options } = fixture()
    try {
      store.automation.saveDraft(
        {
          ...config,
          rules: [
            {
              ...config.rules[0]!,
              id: "classify",
              when: { all: true },
              actions: [{ type: "ai_classify", tagIds: [assessment.tagId] }],
            },
          ],
        },
        1,
      )
      store.automation.publish(
        2,
        { mode: "selected", inputIds: store.automation.inputs().map((input) => input.seq) },
        randomUUID(),
      )
      const execute = async () => {
        throw new Error("classification_must_not_run")
      }
      await runEntryProcessing({ ...options, allowClassification: false, execute })
      expect(store.processingState.published()).toHaveLength(0)
    } finally {
      store.close()
    }
  })
  it("一次基础分析原子发布主次事件及原文证据，事件登记不额外请求模型", async () => {
    const { store, options } = fixture()
    try {
      const original =
        "Acme released Widget 2.0. https://official.test/widget/2 Beta released Tool 3.0. https://official.test/tool/3"
      store.saveEntry({ ...store.entry("feed/1", "e1")!, title: "两项发布", content: original })
      for (const input of store.automation.inputs().filter((item) => item.current))
        store.processingState.setMaterial(input, "complete")
      const identity = (subject: string, object: string, version: string, reference: string) => ({
        kind: "event" as const,
        subject: { value: subject, evidenceId: "E000001" },
        action: { value: "product_release" as const, evidenceId: "E000001" },
        object: { value: object, evidenceId: "E000001" },
        version: { value: version, evidenceId: "E000001" },
        round: null,
        anchor: {
          kind: "official_reference" as const,
          value: reference,
          evidenceId: "E000001",
          timeZone: null,
        },
      })
      const primary = identity("Acme", "Widget", "2.0", "https://official.test/widget/2")
      const secondary = identity("Beta", "Tool", "3.0", "https://official.test/tool/3")
      let calls = 0
      const execute = async <T>(request: CodexJsonOptions<T>) => {
        calls++
        const result = {
          ...output("e1", { ...assessment, state: "absent", evidenceIds: [] }),
          title: "两项发布",
          // 具体名称与事件共用原文证据，一次调用同时完成分类与实体提取。
          entities: [
            {
              kind: "organization",
              name: "Acme",
              parentName: null,
              aliases: [],
              confidence: 0.98,
              evidenceIds: ["E000001"],
            },
          ],
          disposition: "keep",
          aggregation: true,
          rewrite: true,
          event: primary,
          eventMentions: [
            { identity: primary, role: "reports", isPrimary: true },
            { identity: secondary, role: "mentions", isPrimary: false },
          ],
        }
        expect(request.validate(result)).toBe(true)
        return {
          result: result as T,
          model: request.model,
          durationMs: 1,
          usage: null,
          toolCalls: 0,
        }
      }
      expect(await runEntryProcessing({ ...options, execute })).toMatchObject({
        completed: 1,
        failures: [],
        metrics: { modelCalls: 1 },
      })
      const published = store.processingState.published()[0]!
      expect(published.decision.semantic?.eventMentions).toMatchObject([
        { identity: { subject: { quote: original } }, isPrimary: true },
        { identity: { subject: { quote: original } }, isPrimary: false },
      ])
      expect(
        processingApi(store, "GET", `/processing/entries/${published.input.seq}/events`, undefined),
      ).toMatchObject({
        decisionId: published.decisionId,
        events: [
          { role: "reports", state: "confirmed" },
          { role: "mentions", state: "confirmed" },
        ],
      })
      expect(
        store.events.confirmedEventIdsForMembers([
          { inputSeq: published.input.seq, decisionId: published.decisionId },
        ]),
      ).toHaveLength(1)
      // 只有已确认的主事件可作为当前条目代表，次要提及不混入成员投影。
      expect(processingApi(store, "GET", "/processing/entry-results", null)).toMatchObject({
        results: [{ semanticEntities: [{ name: "Acme", kind: "organization" }] }],
      })
      expect(store.stories.list()).toEqual([])
      expect(calls).toBe(1)
      expect(store.entry("feed/1", "e1")?.read).toBe(false)
    } finally {
      store.close()
    }
  })

  it("纯标签规则首次分类、持久化画像与索引，并暴露现有结果入口", async () => {
    const { store, options } = fixture()
    try {
      const result = await runEntryProcessing({ ...options, execute: executor() })
      expect(result).toMatchObject({ completed: 1, failures: [], metrics: { modelCalls: 1 } })
      const published = store.processingState.published()[0]!
      expect(published.decision).toMatchObject({
        schemaVersion: 2,
        status: "hide",
        policy: { aggregation: "deny" },
      })
      expect(store.semantics.view(published.input)).toMatchObject({
        profile: { assessments: [assessment], evidence: { E000001: "大家早上好！" } },
      })
      expect(processingApi(store, "GET", "/processing/entry-results", undefined)).toMatchObject({
        results: [{ inputSeq: published.input.seq }],
      })
      expect(
        processingApi(
          store,
          "GET",
          `/processing/entries/${published.input.seq}/semantics`,
          undefined,
        ),
      ).toMatchObject({ profile: { assessments: [assessment] }, overrideRevision: 0 })
      expect(
        processingApi(
          store,
          "POST",
          `/processing/entries/${published.input.seq}/semantic-overrides`,
          {
            expectedRevision: 0,
            expectedContentVersion: published.input.contentVersion,
            requestId: randomUUID(),
            changes: [{ tagId: assessment.tagId, state: "absent" }],
          },
        ),
      ).toMatchObject({ assessments: [{ state: "absent" }], overrideRevision: 1 })
      expect(store.processingState.published()[0]!.decision.status).toBe("keep")
      expect(store.entry("feed/1", "e1")?.read).toBe(false)
    } finally {
      store.close()
    }
  })
  it.each(["unknown", "low-confidence"])("%s 不会绕过三态规则隐藏文章", async (mode) => {
    const { store, options } = fixture()
    try {
      const tag =
        mode === "unknown"
          ? { ...assessment, state: "unknown" as const, confidence: null, evidenceIds: [] }
          : { ...assessment, confidence: 0.2 }
      expect(await runEntryProcessing({ ...options, execute: executor(tag) })).toMatchObject({
        completed: 1,
        failures: [],
      })
      expect(store.processingState.published()[0]!.decision).toMatchObject({
        status: "keep",
        policy: { standalone: "always" },
        pendingPolicyFields: ["standalone", "aggregation"],
      })
    } finally {
      store.close()
    }
  })
  it("只改展示策略时复用原始语义缓存并重新求值，不调用模型", async () => {
    const { store, options } = fixture()
    try {
      expect(await runEntryProcessing({ ...options, execute: executor() })).toMatchObject({
        completed: 1,
      })
      store.automation.saveDraft(
        {
          ...config,
          rules: [
            {
              ...config.rules[0]!,
              actions: [
                { type: "reading_decision", visibility: "show", aggregationEligibility: "deny" },
                { type: "display", summaryMaxGraphemes: 5 },
              ],
            },
          ],
        },
        1,
      )
      store.automation.publish(
        2,
        { mode: "selected", inputIds: store.automation.inputs().map((input) => input.seq) },
        randomUUID(),
      )
      const result = await runEntryProcessing({
        ...options,
        execute: async () => {
          throw new Error("unexpected_paid_call")
        },
      })
      expect(result).toMatchObject({
        completed: 1,
        failures: [],
        metrics: { modelCalls: 0, cacheHits: 1 },
      })
      const decision = store.processingState.published()[0]!.decision
      expect(decision.status).toBe("keep")
      expect(decision.summary).toBe("原始完整摘")
      expect(decision.semantic?.summary).toBe("原始完整摘要保留证据")
    } finally {
      store.close()
    }
  })
  it("批量分类使用独立证据命名空间，逐项建立画像", async () => {
    const { store, options } = fixture(2)
    try {
      expect(await runEntryProcessing({ ...options, execute: executor() })).toMatchObject({
        completed: 2,
        failures: [],
        metrics: { modelCalls: 1 },
      })
      for (const { input, decision } of store.processingState.published()) {
        const id = decision.semanticProfile!.assessments[0]!.evidenceIds[0]!
        expect(store.semantics.view(input).profile!.evidence[id]).toBe("大家早上好！")
      }
    } finally {
      store.close()
    }
  })
  it("先分类再执行标签选中的提示，重算时两层缓存均可复用", async () => {
    const { store, options } = fixture()
    try {
      const transform = {
        ...config.rules[0]!,
        id: "selected-transform",
        name: "专门处理",
        order: 1,
        actions: [{ type: "ai_transform" as const, prompt: "按问候文章提取社交语气" }],
      }
      store.automation.saveDraft({ ...config, rules: [...config.rules, transform] }, 1)
      store.automation.publish(
        2,
        { mode: "selected", inputIds: store.automation.inputs().map((input) => input.seq) },
        randomUUID(),
      )
      const prompts: string[] = []
      const execute = async <T>(request: CodexJsonOptions<T>) => {
        prompts.push(request.prompt)
        const result = {
          ...output("e1", assessment),
          summary: prompts.length === 1 ? "基础摘要" : "专门摘要",
        }
        expect(request.validate(result)).toBe(true)
        return {
          result: result as T,
          model: request.model,
          durationMs: 1,
          usage: null,
          toolCalls: 0,
        }
      }
      expect(await runEntryProcessing({ ...options, execute })).toMatchObject({
        completed: 1,
        failures: [],
        metrics: { modelCalls: 2 },
      })
      expect(prompts[0]).not.toContain("按问候文章提取社交语气")
      expect(prompts[1]).toContain("按问候文章提取社交语气")
      expect(store.processingState.published()[0]!.decision.summary).toBe("专门摘要")
      store.automation.invalidateSources(["feed/1"])
      expect(await runEntryProcessing({ ...options, execute })).toMatchObject({
        completed: 1,
        failures: [],
        metrics: { modelCalls: 0 },
      })
      expect(prompts).toHaveLength(2)
      expect(store.processingState.published()[0]!.decision.semanticProfile!.assessments).toEqual([
        assessment,
      ])
    } finally {
      store.close()
    }
  })
})

// 验证最早入库水位，而非换代后 seq 或文章发布时间，防止水合回跑旧历史。
it("后台主动分类仅消费水位后的新文，旧文水合不越界且entry_tag依赖继续运行", async () => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-10-01T00:00:00Z"))
  const { store, options } = fixture()
  try {
    const classification = {
      ...config,
      rules: [
        {
          ...config.rules[0]!,
          when: { all: true } as const,
          actions: [{ type: "ai_classify" as const, tagIds: [assessment.tagId] }],
        },
      ],
    }
    store.automation.saveDraft(classification, 1)
    store.automation.publish(
      2,
      { mode: "selected", inputIds: store.automation.inputs().map((item) => item.seq) },
      randomUUID(),
    )
    vi.setSystemTime(new Date("2026-10-08T00:00:00Z"))
    store.saveEntry({ ...store.entry("feed/1", "e1")!, content: "大家早上好！补齐正文" })
    store.saveEntry({ ...store.entry("feed/1", "e1")!, id: "e2", content: "大家早上好！" })
    for (const input of store.automation.inputs().filter((item) => item.current))
      store.processingState.setMaterial(input, "complete")
    const execute = executor()
    expect(
      await runEntryProcessing({
        ...options,
        classificationSince: "2026-10-07T00:00:00Z",
        execute,
      }),
    ).toMatchObject({ completed: 1, failures: [] })
    expect(store.processingState.published().map((item) => item.input.itemId)).toEqual(["e2"])
    // 旧文虽不主动分类，显式阅读规则的entry_tag依赖仍获准分析。
    store.automation.saveDraft(config, 2)
    const old = store.automation.inputs().find((item) => item.current && item.itemId === "e1")!
    store.automation.publish(3, { mode: "selected", inputIds: [old.seq] }, randomUUID())
    expect(
      await runEntryProcessing({
        ...options,
        classificationSince: "2026-10-07T00:00:00Z",
        execute,
      }),
    ).toMatchObject({ completed: 1, failures: [] })
    expect(
      store.processingState.published().find((item) => item.input.itemId === "e1")?.decision.status,
    ).toBe("hide")
  } finally {
    store.close()
    vi.useRealTimers()
  }
})

it("单篇贡献冲突的有效标签、索引与阅读解释一致且原始档案不变", async () => {
  const { store, options } = fixture()
  try {
    store.saveEntry({
      ...store.entry("feed/1", "e1")!,
      content: "邀请码。先安装工具，再配置参数并验证输出。",
    })
    for (const input of store.automation.inputs())
      store.processingState.setMaterial(input, "complete")
    const execute = async <T>(request: CodexJsonOptions<T>) => {
      const result = {
        ...output("e1", assessment),
        substantiveContribution: {
          state: "present",
          confidence: 0.98,
          reason: "完整配置方法。",
          evidenceIds: ["E000002"],
        },
      }
      expect(request.validate(result)).toBe(true)
      return { result: result as T, model: request.model, durationMs: 1, usage: null, toolCalls: 0 }
    }
    expect(await runEntryProcessing({ ...options, execute })).toMatchObject({
      completed: 1,
      failures: [],
    })
    const published = store.processingState.published()[0]!
    expect(published.decision).toMatchObject({
      status: "keep",
      pendingPolicyFields: ["standalone", "aggregation"],
    })
    expect(published.decision.reason).toContain("实质贡献冲突")
    expect(store.semantics.view(published.input)).toMatchObject({
      profile: { assessments: [{ state: "present" }] },
      assessments: [{ state: "unknown", reason: expect.stringContaining("实质贡献冲突") }],
    })
    expect(store.semantics.tagAssessmentsByInput().get(published.input.seq)?.[0]?.state).toBe(
      "unknown",
    )
  } finally {
    store.close()
  }
})
