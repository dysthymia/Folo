import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"

import { join } from "pathe"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { AIConfigStore } from "./ai-config"
import type { CodexJsonOptions } from "./codex"
import { ProcessingTrial } from "./processing-trial"
import { Store } from "./store"

describe("规则 AI 试运行", () => {
  let store: Store
  let directory: string
  let aiConfig: AIConfigStore
  const entry = {
    id: "e1",
    sourceKey: "feed/1",
    title: "原文标题",
    content: "<p>原文明确支持的事实。</p>",
    description: null,
    url: "https://example.test/e1",
    publishedAt: "2026-09-19T00:00:00.000Z",
    read: false,
  }
  const output = {
    entryId: "e1",
    title: "试运行标题",
    summary: "原文明确支持的事实。",
    disposition: "hide",
    reason: "模型建议隐藏",
    aggregation: false,
    rewrite: true,
    labels: [],
    // 试运行与正式请求使用同一必填身份契约；未知事件显式返回null。
    event: null,
    facts: [{ text: "原文明确支持的事实。", evidenceId: "E000001", kind: "fact" }],
  }
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "folo-trial-test-"))
    aiConfig = new AIConfigStore(join(directory, "ai.json"))
    await aiConfig.save({ provider: "codex", model: "test-model" })
    store = new Store(":memory:")
    store.bindOwner("owner")
    store.replaceSources([
      { key: "feed/1", kind: "feed", id: "1", title: "订阅", view: 0, category: null },
    ])
    store.saveEntry(entry)
    store.processingState.setMaterial(
      store.automation.current(entry.sourceKey, entry.id)!,
      "complete",
    )
  })
  afterEach(async () => {
    store.close()
    await rm(directory, { recursive: true, force: true })
  })
  function request() {
    const config = store.automation.draft().config
    config.rules = [
      {
        id: "rule",
        ownerId: "owner",
        name: "保留例外",
        order: 0,
        version: 1,
        enabled: true,
        executionLocation: "processing_service",
        when: { all: true },
        actions: [
          {
            type: "presentation",
            policy: { standalone: "always", aggregation: "allow", rewrite: "deny" },
          },
        ],
      },
    ]
    return { config, sourceKey: entry.sourceKey, entryId: entry.id }
  }
  function trial(beforeReturn?: () => void, prompts: string[] = [], effort = "low") {
    return new ProcessingTrial({
      store,
      aiConfig,
      runtimeDir: directory,
      execute: async <T>(options: CodexJsonOptions<T>) => {
        prompts.push(options.prompt)
        expect(options.purpose).toBe("preview")
        expect(options.reasoningEffort).toBe(effort)
        if (!options.validate(output)) throw new Error("bad_fixture")
        beforeReturn?.()
        return { result: output, model: options.model, durationMs: 1, usage: null, toolCalls: 0 }
      },
    })
  }
  it.each([true, null] as const)("当前读态为 %s 时明确拒绝试运行且不调用模型", async (read) => {
    // 只更新来源读态，输入的旧未读快照仍存在。
    store.saveEntry({ ...entry, read })
    const prompts: string[] = []
    await expect(
      trial(undefined, prompts).run(request(), new AbortController().signal),
    ).rejects.toMatchObject({ code: read === true ? "target_read" : "read_state_unknown" })
    expect(prompts).toEqual([])
    expect(store.automation.current(entry.sourceKey, entry.id)?.status).toBe("pending")
  })

  it("复用正式引用和显式策略，不发布规则、改队列或阅读结果", async () => {
    const dump = () =>
      JSON.stringify({
        snapshot: store.snapshot(),
        draft: store.automation.draft(),
        releases: store.automation.releases(),
        inputs: store.automation.inputs(),
        published: store.processingState.published(),
        stories: store.stories.list(),
        entry: store.entry(entry.sourceKey, entry.id),
      })
    const before = dump()
    const result = await trial().run(request(), new AbortController().signal)
    expect(result).toMatchObject({
      before: null,
      after: {
        status: "keep",
        policy: { standalone: "always", aggregation: "allow", rewrite: "deny" },
        facts: [{ quote: "原文明确支持的事实。" }],
      },
      original: { title: entry.title },
    })
    expect(dump()).toBe(before)
  })
  it.each([false, true])(
    "v5 标签隐藏预览正确投影，后置变换=%s 且不写正式状态",
    async (transform) => {
      store.saveEntry({ ...entry, content: "<p>GM，大家早上好。</p>" })
      const input = store.automation.current(entry.sourceKey, entry.id)!
      store.processingState.setMaterial(input, "complete")
      const body = request()
      body.config.formatVersion = 5
      body.config.rules = [
        {
          ...body.config.rules[0]!,
          name: "隐藏纯闲聊",
          when: {
            anyOf: [
              {
                allOf: [
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
          actions: [
            { type: "reading_decision", visibility: "hide", aggregationEligibility: "deny" },
            ...(transform
              ? [{ type: "ai_transform" as const, prompt: "把问候说明为一句简短摘要" }]
              : []),
          ],
        },
      ]
      const dump = () =>
        JSON.stringify({
          snapshot: store.snapshot(),
          draft: store.automation.draft(),
          releases: store.automation.releases(),
          inputs: store.automation.inputs(),
          published: store.processingState.published(),
          semantics: store.semantics.view(input),
          stories: store.stories.list(),
        })
      const before = dump()
      const cache = vi.spyOn(store.processingState, "cache")
      const saveCache = vi.spyOn(store.processingState, "saveCache")
      const publish = vi.spyOn(store.semantics, "publish")
      const prompts: string[] = []
      const preview = new ProcessingTrial({
        store,
        aiConfig,
        runtimeDir: directory,
        execute: async <T>(options: CodexJsonOptions<T>) => {
          prompts.push(options.prompt)
          expect(options.purpose).toBe("preview")
          const selected = {
            ...output,
            disposition: "keep",
            facts: [],
            summary: prompts.length === 1 ? "简单问候" : "二次变换摘要",
            eventMentions: [],
            materialCoverage: "complete",
            substantiveContribution: {
              state: "absent",
              confidence: 0.98,
              reason: "全文只有问候。",
              evidenceIds: [],
            },
            entities: [],
            tagAssessments: [
              {
                tagId: "signal:social_chatter",
                definitionVersion: 1,
                state: "present",
                confidence: 0.98,
                reason: "全文只有问候",
                evidenceIds: ["E000001"],
              },
            ],
          }
          if (!options.validate(selected)) throw new Error("bad_semantic_trial_fixture")
          return {
            result: selected,
            model: options.model,
            durationMs: 1,
            usage: {
              inputTokens: prompts.length * 10,
              outputTokens: prompts.length,
              cachedInputTokens: 0,
            },
            toolCalls: 0,
          }
        },
      })
      const result = await preview.run(body, new AbortController().signal)
      expect(result.after).toMatchObject({
        status: "hide",
        policy: { standalone: "never", aggregation: "deny" },
        reason: "命中规则「隐藏纯闲聊」：全文只有问候",
        summary: transform ? "二次变换摘要" : "简单问候",
      })
      expect(prompts).toHaveLength(transform ? 2 : 1)
      if (transform) expect(prompts[1]).toContain("把问候说明为一句简短摘要")
      expect(result.usage).toEqual({
        inputTokens: transform ? 30 : 10,
        outputTokens: transform ? 3 : 1,
        cachedInputTokens: 0,
      })
      expect(cache).not.toHaveBeenCalled()
      expect(saveCache).not.toHaveBeenCalled()
      expect(publish).not.toHaveBeenCalled()
      expect(dump()).toBe(before)
    },
  )

  it("拒绝跨账号及正文缺失请求，不静默改成摘要试运行", async () => {
    const body = request()
    await expect(
      trial().run(
        {
          ...body,
          config: {
            ...body.config,
            ownerId: "other",
            rules: body.config.rules.map((rule) => ({ ...rule, ownerId: "other" })),
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "invalid_target" })
    store.processingState.setMaterial(
      store.automation.current(entry.sourceKey, entry.id)!,
      "missing",
    )
    await expect(trial().run(body, new AbortController().signal)).rejects.toMatchObject({
      code: "material_missing",
    })
  })
  it("展示语言进入实际指令，摘要长度限制不改写原文引用", async () => {
    const body = request()
    body.config.rules[0]!.actions.push({ type: "display", language: "en", summaryMaxGraphemes: 3 })
    const prompts: string[] = []
    const result = await trial(undefined, prompts).run(body, new AbortController().signal)
    expect(prompts[0]).toContain("标题与摘要使用语言：en")
    expect(result.after.summary).toBe("原文明确支持的事实。".slice(0, 3))
    expect(result.after.facts[0]!.quote).toBe("原文明确支持的事实。")
  })

  it("模型等待期间正文已更新时丢弃试运行结果", async () => {
    await expect(
      trial(() => store.saveEntry({ ...entry, content: "正文已经更新" })).run(
        request(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "stale_target" })
  })
  it("推理强度试运行沿用一次读取快照，不发布正式决定", async () => {
    const read = vi
      .spyOn(aiConfig, "read")
      .mockResolvedValue({ provider: "codex", model: "test-model", reasoningEffort: "high" })
    await trial(undefined, [], "high").run(request(), new AbortController().signal)
    expect(read).toHaveBeenCalledTimes(1)
    expect(store.processingState.published()).toEqual([])
  })
})
