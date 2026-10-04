import { randomUUID } from "node:crypto"

import { afterEach, expect, it, vi } from "vitest"

import type { AIConfigStore } from "./ai-config"
import type { CodexJsonOptions, runCodexJson } from "./codex"
import { CodexRunError } from "./codex"
import type { FoloReader, Source, SourceEntry } from "./folo"
import { researchMaterialId, ResearchSelectionService } from "./research-selection"
import { Store } from "./store"

const stores: Store[] = []
afterEach(() => stores.splice(0).forEach((store) => store.close()))
const aiConfig = {
  read: async () => ({ provider: "codex", model: "test" }),
  execution: async () => undefined,
} as AIConfigStore
const output = {
  title: "所选历史材料综述",
  sentences: [
    {
      id: "s1",
      text: "这份原文披露正式发布日为2026年9月1日。",
      citations: [
        {
          materialId: researchMaterialId("owner", "feed/f1", "entry"),
          quote: "2026年9月1日正式发布。",
        },
      ],
    },
  ],
  limitations: ["未进行外部核实。"],
}
// 模型内部只选择目录编号；公共结果仍由服务端还原materialId与逐字引文。
const selectedOutput = {
  ...output,
  sentences: output.sentences.map((sentence) => ({
    ...sentence,
    citations: [{ evidenceId: "M1E000001" }],
  })),
}
function fixture(
  options: {
    url?: string
    complete?: boolean
    content?: string
    getReader?: () => Promise<FoloReader>
    execute?: typeof runCodexJson
  } = {},
) {
  const store = new Store(":memory:")
  stores.push(store)
  store.bindOwner("owner")
  store.automation.publish(0, { mode: "future" }, randomUUID())
  store.replaceSources([
    { key: "feed/f1", id: "f1", kind: "feed", title: "原文来源", view: 0, category: null },
  ])
  const entry = {
    id: "entry",
    sourceKey: "feed/f1",
    title: "历史原文",
    url: options.url ?? "https://example.test/article",
    read: true,
    publishedAt: "2026-09-01T00:00:00Z",
    content: options.content ?? "2026年9月1日正式发布。",
    description: null,
  }
  store.saveEntry(entry)
  const input = store.automation.assign(store.automation.current(entry.sourceKey, entry.id)!.seq)
  if (options.complete !== false) store.processingState.setMaterial(input, "complete")
  const execute =
    options.execute ??
    (async <T>(request: CodexJsonOptions<T>) => {
      const result = request.prompt.startsWith("研究支持检查")
        ? { supported: true, issues: [] }
        : selectedOutput
      expect(request.validate(result)).toBe(true)
      return {
        result: result as T,
        model: request.model,
        usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0 },
        durationMs: 5,
        toolCalls: 0,
      }
    })
  const service = new ResearchSelectionService({
    store,
    aiConfig,
    runtimeDir: "/tmp",
    execute,
    getReader: options.getReader
      ? async () => {
          const reader = await options.getReader!()
          if (!reader.session) reader.session = async () => ({ ownerId: "owner", expiresAt: null })
          return reader
        }
      : undefined,
  })
  const request = {
    target: { kind: "selection", entries: [{ sourceKey: entry.sourceKey, entryId: entry.id }] },
    question: "原文披露了什么？",
    goal: "综述明确披露",
    knownQuestions: [],
  }
  return { store, service, request, entry, input }
}

it("显式选中历史已读原文执行模型综述，正式队列、已读和Story不变", async () => {
  const { store, service, request, input } = fixture()
  // 已读仍然走日常跳过；手动选材只读取该输入，不复活正式处理。
  store.processingState.settleRead([input.seq], [])
  const before = JSON.stringify({
    input: store.automation.inputs(),
    published: store.processingState.published(),
    stories: store.stories.list(),
  })
  const preview = await service.preview(request)
  expect(preview).toMatchObject({
    canExecute: true,
    selectionCount: 1,
    estimatedModelCalls: 2,
    totalCharacters: 14,
  })
  const pack = await service.run({
    ...request,
    selectionToken: preview.selectionToken,
    idempotencyKey: "research_key_123456",
  })
  expect(pack).toMatchObject({
    status: "completed",
    result: output,
    metrics: { modelCalls: 2, usage: { inputTokens: 200 } },
  })
  expect(pack.markdown).toContain("2026年9月1日正式发布")
  expect(pack.markdown).toContain("## 原材料目录")
  expect(pack.markdown).toContain("https://example.test/article")
  expect(pack.markdown).toContain("发表时间：2026-09-01T00:00:00Z")
  expect(pack.markdown).toContain(`采集时间：${input.receivedAt}`)
  expect(pack.markdown).toContain("feed/f1 / entry")
  expect(store.research.get(pack.id)).toEqual(pack)
  expect(
    JSON.stringify({
      input: store.automation.inputs(),
      published: store.processingState.published(),
      stories: store.stories.list(),
    }),
  ).toBe(before)
})

it("补读未水合已读材料只冻结研究原文，不capture或改变读态", async () => {
  const detail = vi.fn(async (_source, entry) => ({ ...entry, content: "2026年9月1日正式发布。" }))
  const readability = vi.fn()
  const { store, service, request, input } = fixture({
    complete: false,
    content: "",
    getReader: async () => ({ detail, readability }) as unknown as FoloReader,
  })
  const before = store.automation.current(input.sourceKey, input.itemId)
  const preview = await service.preview(request)
  expect(preview.canExecute).toBe(true)
  expect(detail).toHaveBeenCalledTimes(1)
  expect(store.automation.current(input.sourceKey, input.itemId)).toEqual(before)
  expect(store.processingState.material(input)).toBeNull()
  const pack = await service.run({
    ...request,
    selectionToken: preview.selectionToken,
    idempotencyKey: randomUUID(),
  })
  expect(pack.status).toBe("completed")
  expect(store.entry(input.sourceKey, input.itemId)?.read).toBe(true)
  expect(store.entry(input.sourceKey, input.itemId)?.content).toBe("")
})

it("仍缺引用上下文、未知来源、重复选择、生成源和过量材料不进入模型", async () => {
  const execute = vi.fn()
  const { service, request } = fixture({
    url: "https://x.com/test/status/1",
    content: "引用原帖未读取",
    execute,
  })
  const preview = await service.preview(request)
  expect(preview.canExecute).toBe(false)
  expect(preview.estimatedModelCalls).toBe(0)
  await expect(
    service.run({
      ...request,
      selectionToken: preview.selectionToken,
      idempotencyKey: randomUUID(),
    }),
  ).rejects.toThrow("material_missing")
  await expect(
    service.preview({
      ...request,
      target: {
        kind: "selection",
        entries: [...request.target.entries, ...request.target.entries],
      },
    }),
  ).rejects.toThrow("invalid_target")
  await expect(
    service.preview({
      ...request,
      target: { kind: "selection", entries: [{ sourceKey: "generated:events", entryId: "entry" }] },
    }),
  ).rejects.toThrow("invalid_target")
  await expect(
    service.preview({
      ...request,
      target: {
        kind: "selection",
        entries: Array.from({ length: 21 }, () => request.target.entries[0]),
      },
    }),
  ).rejects.toThrow()
  expect(execute).not.toHaveBeenCalled()
})

it("超字符预算只返回不可执行预览，不截断后伪装研究", async () => {
  const { service, request } = fixture({ content: "字".repeat(60001) })
  const preview = await service.preview(request)
  expect(preview).toMatchObject({
    canExecute: false,
    totalCharacters: 60001,
    estimatedModelCalls: 0,
  })
  await expect(
    service.run({
      ...request,
      selectionToken: preview.selectionToken,
      idempotencyKey: randomUUID(),
    }),
  ).rejects.toThrow("selection_too_large")
})

it("模型只能选冻结目录短ID，拒绝未知ID、手写quote和重复句ID", async () => {
  const execute = async <T>(request: CodexJsonOptions<T>) => {
    expect(
      request.validate({
        ...selectedOutput,
        sentences: [{ ...selectedOutput.sentences[0], citations: [{ evidenceId: "M999E000001" }] }],
      }),
    ).toBe(false)
    expect(
      request.validate({
        ...selectedOutput,
        sentences: [selectedOutput.sentences[0], selectedOutput.sentences[0]],
      }),
    ).toBe(false)
    expect(request.validate(output)).toBe(false)
    const invalid = {
      ...selectedOutput,
      sentences: [{ ...selectedOutput.sentences[0], citations: [{ evidenceId: "M1E999999" }] }],
    }
    return { result: invalid as T, model: request.model, durationMs: 1, usage: null, toolCalls: 0 }
  }
  const { service, request } = fixture({ execute })
  const preview = await service.preview(request)
  const pack = await service.run({
    ...request,
    selectionToken: preview.selectionToken,
    idempotencyKey: randomUUID(),
  })
  expect(pack).toMatchObject({
    status: "failed",
    result: null,
    errorCode: "invalid_output",
    metrics: { modelCalls: 1 },
  })
})

it.each(["content", "withdrawn", "generation"])(
  "模型晚响应遇到%s变化不可发布研究结果",
  async (change) => {
    const { store, service, request, input, entry } = fixture({
      execute: async <T>(modelRequest: CodexJsonOptions<T>) => {
        if (change === "content") store.saveEntry({ ...entry, content: "正文已经改变" })
        if (change === "withdrawn") store.stories.withdrawMaterial(input.seq, "用户撤回")
        if (change === "generation") store.automation.invalidateSources([input.sourceKey])
        return {
          result: selectedOutput as T,
          model: modelRequest.model,
          durationMs: 1,
          usage: null,
          toolCalls: 0,
        }
      },
    })
    const preview = await service.preview(request)
    const pack = await service.run({
      ...request,
      selectionToken: preview.selectionToken,
      idempotencyKey: randomUUID(),
    })
    expect(pack).toMatchObject({ status: "failed", result: null, errorCode: "stale_selection" })
  },
)

it("重复执行key返回running/完成而不重复调用，失败新key才能重试", async () => {
  let release!: () => void
  let calls = 0
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  const { service, request } = fixture({
    execute: async <T>(modelRequest: CodexJsonOptions<T>) => {
      calls++
      await wait
      return {
        result: (modelRequest.prompt.startsWith("研究支持检查")
          ? { supported: true, issues: [] }
          : selectedOutput) as T,
        model: modelRequest.model,
        durationMs: 1,
        usage: null,
        toolCalls: 0,
      }
    },
  })
  const preview = await service.preview(request)
  const runRequest = {
    ...request,
    selectionToken: preview.selectionToken,
    idempotencyKey: randomUUID(),
  }
  const first = service.run(runRequest)
  await Promise.resolve()
  const second = await service.run(runRequest)
  expect(second.status).toBe("running")
  release()
  const completed = await first
  expect(await service.run(runRequest)).toEqual(completed)
  expect(calls).toBe(2)
})

it("模型失败保留用量与失败状态，新key显式重试；取消不可报完成", async () => {
  const execute = vi.fn(async () => {
    throw new CodexRunError("PROCESS_FAILED", {
      inputTokens: 7,
      outputTokens: 0,
      cachedInputTokens: 0,
    })
  })
  const { service, request } = fixture({ execute })
  const preview = await service.preview(request)
  const runRequest = {
    ...request,
    selectionToken: preview.selectionToken,
    idempotencyKey: randomUUID(),
  }
  const failed = await service.run(runRequest)
  expect(failed).toMatchObject({
    status: "failed",
    errorCode: "process_failed",
    metrics: { modelCalls: 1, usage: { inputTokens: 7 } },
  })
  expect(await service.run(runRequest)).toEqual(failed)
  await service.run({ ...runRequest, idempotencyKey: randomUUID() })
  expect(execute).toHaveBeenCalledTimes(2)
  const cancelled = await service.run(
    { ...runRequest, idempotencyKey: randomUUID() },
    AbortSignal.abort(),
  )
  expect(cancelled).toMatchObject({
    status: "failed",
    errorCode: "aborted",
    metrics: { modelCalls: 0 },
  })
})

it("预览与执行只查询所选current，过期token不调用模型", async () => {
  const execute = vi.fn()
  const { store, service, request, entry } = fixture({ execute })
  // 即使历史有其他材料，研究不得调用全量输入扫描路径。
  vi.spyOn(store.automation, "inputs").mockImplementation(() => {
    throw new Error("不得扫描历史")
  })
  const preview = await service.preview(request)
  store.saveEntry({ ...entry, content: "2026年9月2日正文改版。" })
  await expect(
    service.run({
      ...request,
      selectionToken: preview.selectionToken,
      idempotencyKey: randomUUID(),
    }),
  ).rejects.toThrow("stale_selection")
  expect(execute).not.toHaveBeenCalled()
})

it("网络补读遇到账号切换丢弃旧授权材料", async () => {
  const { store, service, request } = fixture({
    complete: false,
    content: "",
    getReader: async () =>
      ({
        detail: async (_source: Source, entry: SourceEntry) => {
          // 用只读getter模拟认证层切换，不改业务库或沿用原账号结果。
          vi.spyOn(store, "ownerId", "get").mockReturnValue("another-owner")
          return { ...entry, content: "2026年9月1日正式发布。" }
        },
      }) as unknown as FoloReader,
  })
  await expect(service.preview(request)).rejects.toThrow("owner_changed")
  expect(store.research.list()).toEqual([])
})

it("自然中文改写经第二轮支持检查后完成，检查发现归属升级或反证则失败", async () => {
  let supported = false
  const { service, request } = fixture({
    execute: async <T>(modelRequest: CodexJsonOptions<T>) => {
      const result = modelRequest.prompt.startsWith("研究支持检查")
        ? { supported, issues: supported ? [] : ["把来源观点升级为事实且未保留关键反证"] }
        : selectedOutput
      expect(modelRequest.validate(result)).toBe(true)
      return {
        result: result as T,
        model: modelRequest.model,
        durationMs: 1,
        usage: { inputTokens: 3, outputTokens: 2, cachedInputTokens: 0 },
        toolCalls: 0,
      }
    },
  })
  const preview = await service.preview(request)
  expect(preview.estimatedModelCalls).toBe(2)
  const runRequest = {
    ...request,
    selectionToken: preview.selectionToken,
    idempotencyKey: randomUUID(),
  }
  const failed = await service.run(runRequest)
  expect(failed).toMatchObject({
    status: "failed",
    result: null,
    errorCode: "unsupported_output",
    metrics: { modelCalls: 2, usage: { inputTokens: 6, outputTokens: 4 } },
  })
  supported = true
  const completed = await service.run({ ...runRequest, idempotencyKey: randomUUID() })
  expect(completed.status).toBe("completed")
  expect(completed.result?.sentences[0]?.text).toBe("这份原文披露正式发布日为2026年9月1日。")
})

it("第二轮失败保留首轮及失败调用用量，第二轮撤回不能产生完成结果", async () => {
  let withdraw = false
  const { store, service, request, input } = fixture({
    execute: async <T>(modelRequest: CodexJsonOptions<T>) => {
      if (modelRequest.prompt.startsWith("研究支持检查")) {
        if (!withdraw)
          throw new CodexRunError("TIMEOUT", {
            inputTokens: 2,
            outputTokens: 0,
            cachedInputTokens: 0,
          })
        store.stories.withdrawMaterial(input.seq, "核验期间撤回")
        return {
          result: { supported: true, issues: [] } as T,
          model: modelRequest.model,
          durationMs: 1,
          usage: null,
          toolCalls: 0,
        }
      }
      return {
        result: selectedOutput as T,
        model: modelRequest.model,
        durationMs: 1,
        usage: { inputTokens: 5, outputTokens: 2, cachedInputTokens: 0 },
        toolCalls: 0,
      }
    },
  })
  const preview = await service.preview(request)
  const runRequest = {
    ...request,
    selectionToken: preview.selectionToken,
    idempotencyKey: randomUUID(),
  }
  expect(await service.run(runRequest)).toMatchObject({
    status: "failed",
    errorCode: "timeout",
    metrics: { modelCalls: 2, usage: { inputTokens: 7, outputTokens: 2 } },
  })
  withdraw = true
  expect(await service.run({ ...runRequest, idempotencyKey: randomUUID() })).toMatchObject({
    status: "failed",
    result: null,
    errorCode: "stale_selection",
    metrics: { modelCalls: 2 },
  })
})

it.each(["owner", "cancel", "material"])(
  "研究第二轮晚响应遇到%s变更不显示旧授权完成结果",
  async (change) => {
    const controller = new AbortController()
    const { store, service, request, input } = fixture({
      execute: async <T>(modelRequest: CodexJsonOptions<T>) => {
        const verification = modelRequest.prompt.startsWith("研究支持检查")
        if (verification) {
          if (change === "owner") vi.spyOn(store, "ownerId", "get").mockReturnValue("another-owner")
          if (change === "cancel") controller.abort()
          if (change === "material") store.processingState.setMaterial(input, "missing")
        }
        return {
          result: (verification ? { supported: true, issues: [] } : selectedOutput) as T,
          model: modelRequest.model,
          durationMs: 1,
          usage: null,
          toolCalls: 0,
        }
      },
    })
    const preview = await service.preview(request)
    const running = service.run(
      { ...request, selectionToken: preview.selectionToken, idempotencyKey: randomUUID() },
      controller.signal,
    )
    if (change === "owner") {
      await expect(running).rejects.toThrow("owner_changed")
      expect(store.research.list()).toEqual([])
    } else
      expect(await running).toMatchObject({
        status: "failed",
        result: null,
        errorCode: change === "cancel" ? "aborted" : "stale_selection",
        metrics: { modelCalls: 2 },
      })
  },
)

it("预览正文为空时有限提取readability，未完整的图表引用仍阻止执行", async () => {
  const readability = vi.fn(async () => "2026年9月1日正式发布。")
  const detail = vi.fn(async (_source: Source, entry: SourceEntry) => ({ ...entry, content: "" }))
  const { service, request } = fixture({
    complete: false,
    content: "",
    getReader: async () => ({ detail, readability }) as unknown as FoloReader,
  })
  expect((await service.preview(request)).canExecute).toBe(true)
  expect(readability).toHaveBeenCalledWith("entry")
  const second = fixture({
    url: "https://x.com/test/status/2",
    complete: false,
    content: "",
    getReader: async () =>
      ({
        detail: async (_source: Source, entry: SourceEntry) => ({
          ...entry,
          content: '<p>如图，收入走势。</p><img src="https://example.test/chart.png" />',
        }),
      }) as unknown as FoloReader,
  })
  const preview = await second.service.preview(second.request)
  expect(preview.canExecute).toBe(false)
  expect(preview.missingContext[0]?.reasons).toContain("images")
})

function uncapturedFixture() {
  let body = {
    id: "old-untracked",
    sourceKey: "feed/f1",
    title: "未纳入计划的历史原文",
    url: "https://example.test/old",
    read: true,
    publishedAt: "2026-01-01T00:00:00Z",
    content: "2026年1月1日正式发布。",
    description: null,
  }
  const entry = vi.fn(async (_source: Source, _entryId: string): Promise<SourceEntry> => ({
    ...body,
  }))
  const session = vi.fn(async () => ({ ownerId: "owner", expiresAt: null }))
  const execute = vi.fn(async (modelRequest: CodexJsonOptions<unknown>) => {
    const payload = JSON.parse(modelRequest.prompt.split("\n").at(-1)!) as {
      materials: Array<{ evidenceCatalog: Array<{ evidenceId: string }> }>
    }
    const result = modelRequest.prompt.startsWith("研究支持检查")
      ? { supported: true, issues: [] }
      : {
          ...output,
          sentences: [
            {
              id: "s1",
              text: "所选旧文披露发布日期为2026年1月1日。",
              citations: [{ evidenceId: payload.materials[0]!.evidenceCatalog[0]!.evidenceId }],
            },
          ],
        }
    expect(modelRequest.validate(result)).toBe(true)
    return {
      result,
      model: modelRequest.model,
      durationMs: 1,
      usage: null,
      toolCalls: 0,
    }
  })
  const { store, service, request } = fixture({
    getReader: async () => ({ entry, session }) as unknown as FoloReader,
    execute: async <T>(modelRequest: CodexJsonOptions<T>) => {
      const response = await execute(modelRequest)
      return { ...response, result: response.result as T }
    },
  })
  request.target.entries = [{ sourceKey: body.sourceKey, entryId: body.id }]
  return {
    store,
    service,
    request,
    entry,
    session,
    execute,
    change: (next: Partial<typeof body>) => {
      body = { ...body, ...next }
    },
  }
}

it("显式官方未入队已读原文可研究，materialId稳定且不伪造正式seq/读态", async () => {
  const { store, service, request, entry } = uncapturedFixture()
  const before = JSON.stringify(store.automation.inputs())
  const preview = await service.preview(request)
  expect(preview.canExecute).toBe(true)
  expect(preview.materials[0]).toMatchObject({
    materialId: researchMaterialId("owner", "feed/f1", "old-untracked"),
  })
  expect(preview.materials[0]).not.toHaveProperty("inputSeq")
  const pack = await service.run({
    ...request,
    selectionToken: preview.selectionToken,
    idempotencyKey: randomUUID(),
  })
  expect(pack).toMatchObject({ status: "completed", metrics: { modelCalls: 2 } })
  expect(pack.result?.sentences[0]?.citations[0]).toMatchObject({
    materialId: preview.materials[0]!.materialId,
  })
  expect(pack.result?.sentences[0]?.citations[0]).not.toHaveProperty("inputSeq")
  expect(pack.markdown).toContain("发表时间：2026-01-01T00:00:00Z")
  expect(entry).toHaveBeenCalledTimes(3)
  expect(JSON.stringify(store.automation.inputs())).toBe(before)
  expect(store.automation.current("feed/f1", "old-untracked")).toBeNull()
  expect(store.entry("feed/f1", "old-untracked")).toBeNull()
})

it("未入队材料无reader或session不属于当前账号，不能借源快照信任其正文", async () => {
  const local = fixture()
  await expect(
    local.service.preview({
      ...local.request,
      target: { kind: "selection", entries: [{ sourceKey: "feed/f1", entryId: "uncaptured" }] },
    }),
  ).rejects.toThrow("invalid_target")
  const remote = uncapturedFixture()
  remote.session.mockResolvedValue({ ownerId: "other-owner", expiresAt: null })
  await expect(remote.service.preview(remote.request)).rejects.toThrow("owner_changed")
  expect(remote.entry).not.toHaveBeenCalled()
  expect(remote.execute).not.toHaveBeenCalled()
})

it("未入队原文预览后官方正文改版，在付费前拒绝旧冻结研究", async () => {
  const remote = uncapturedFixture()
  const preview = await remote.service.preview(remote.request)
  remote.change({ content: "2026年1月2日正文修订。" })
  const pack = await remote.service.run({
    ...remote.request,
    selectionToken: preview.selectionToken,
    idempotencyKey: randomUUID(),
  })
  expect(pack).toMatchObject({
    status: "failed",
    result: null,
    errorCode: "stale_selection",
    metrics: { modelCalls: 0 },
  })
  expect(remote.execute).not.toHaveBeenCalled()
})

it("未入队材料研究返回后还要核验版本，标题改版不能误报完成", async () => {
  const remote = uncapturedFixture()
  const original = remote.execute.getMockImplementation()!
  remote.execute.mockImplementation(async (modelRequest: CodexJsonOptions<unknown>) => {
    const response = await original(modelRequest)
    if (modelRequest.prompt.startsWith("研究支持检查")) remote.change({ title: "官方原文已更正" })
    return response
  })
  const preview = await remote.service.preview(remote.request)
  expect(
    await remote.service.run({
      ...remote.request,
      selectionToken: preview.selectionToken,
      idempotencyKey: randomUUID(),
    }),
  ).toMatchObject({
    status: "failed",
    result: null,
    errorCode: "stale_selection",
    metrics: { modelCalls: 2 },
  })
})

it("未入队材料网络预检中重复key返回running，等待结束后只执行两次模型", async () => {
  const remote = uncapturedFixture()
  const preview = await remote.service.preview(remote.request)
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  const originalEntry = remote.entry.getMockImplementation()!
  remote.entry.mockImplementation(async (source, entryId) => {
    await wait
    return originalEntry(source, entryId)
  })
  const runRequest = {
    ...remote.request,
    selectionToken: preview.selectionToken,
    idempotencyKey: randomUUID(),
  }
  const first = remote.service.run(runRequest)
  await Promise.resolve()
  expect(await remote.service.run(runRequest)).toMatchObject({ status: "running" })
  release()
  expect((await first).status).toBe("completed")
  expect(remote.execute).toHaveBeenCalledTimes(2)
})
