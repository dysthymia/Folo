import { randomUUID } from "node:crypto"

import { afterEach, describe, expect, it, vi } from "vitest"

import { automationApi } from "./automation-api"
import type { ProcessingDecision } from "./processing-decision"
import { Store } from "./store"

const stores: Store[] = []
afterEach(() => {
  stores.splice(0).forEach((store) => store.close())
  vi.restoreAllMocks()
})

function fixture() {
  const store = new Store(":memory:")
  stores.push(store)
  store.bindOwner("owner")
  store.replaceSources([
    { key: "feed/1", kind: "feed", id: "1", title: "来源", view: 0, category: null },
  ])
  automationApi(store, "PUT", "/rules/active/activate", {
    expectedRevision: 0,
    requestId: randomUUID(),
    rule: {
      id: "active",
      ownerId: "owner",
      name: "摘要与分类",
      enabled: true,
      order: 0,
      when: { all: true },
      version: 1,
      executionLocation: "processing_service",
      actions: [{ type: "ai_transform", prompt: "摘要" }],
    },
  })
  return store
}

// 调试查询必须保持只读，并且只能读取当前有效发布结果和指定一轮报告。
describe("自动化规则调试快照", () => {
  it("汇总标签、过滤、事实和待定策略，忽略私人草稿且不改变输入", () => {
    const store = fixture()
    const draft = store.automation.draft()
    store.automation.saveDraft(
      { ...draft.config, rules: [{ ...draft.config.rules[0]!, name: "未发布草稿" }] },
      draft.revision,
    )
    store.saveEntry({
      id: "entry",
      sourceKey: "feed/1",
      title: "测试原文",
      url: null,
      publishedAt: new Date().toISOString(),
      read: false,
      content: "正文",
      description: null,
    })
    const input = store.automation.assign(store.automation.inputs()[0]!.seq)
    const decision = {
      schemaVersion: 2,
      fingerprint: "test",
      provider: "codex",
      model: "actual-model",
      generatedAt: new Date().toISOString(),
      durationMs: 1,
      usage: null,
      status: "hide",
      title: "测试原文",
      summary: "",
      reason: "筛选规则命中",
      labels: ["technology"],
      policy: { standalone: "auto", aggregation: "allow", rewrite: "allow" },
      pendingPolicyFields: ["aggregation"],
      sourceRole: "reporting",
      context: { source_id: "feed/1", contextId: "feed/1" },
      facts: [],
      semantic: null,
      reused: false,
    } satisfies ProcessingDecision
    store.automation.complete(input, decision)
    const before = store.automation.inputs()
    const originalInputs = vi.spyOn(store.automation, "inputs")
    const fullDecisions = vi.spyOn(store.processingState, "published")
    const result = automationApi(store, "GET", "/automation/debug", undefined)
    expect(originalInputs).not.toHaveBeenCalled()
    expect(fullDecisions).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      ownerId: "owner",
      releaseVersion: 1,
      rules: [{ id: "active", name: "摘要与分类", actions: ["ai_transform"] }],
      outcomes: { total: 1, hidden: 1, tagged: 1, facts: 0, policyPending: 1 },
      recent: [
        { title: "测试原文", status: "hide", model: "actual-model", labels: ["technology"] },
      ],
      run: null,
      report: null,
      queue: { running: 0, pending: 0 },
    })
    expect(JSON.stringify(result)).not.toContain("未发布草稿")
    expect(store.automation.inputs()).toEqual(before)
    // 正文换版后旧决定退出当前概览，调试信息不能继续冒充新内容的结果。
    store.saveEntry({ ...input.body, content: "更新后的正文" })
    expect(automationApi(store, "GET", "/automation/debug", undefined)).toMatchObject({
      outcomes: { total: 0, tagged: 0, hidden: 0 },
      recent: [],
    })
  })

  it("优先展示运行中批次，按 id 读取一轮报告，不加载全部历史运行与报告", () => {
    const store = fixture()
    const first = store.schedule.manual(randomUUID(), "2026-10-14T00:00:00Z")
    const running = store.schedule.claim("2026-10-14T00:00:01Z")!
    expect(running.id).toBe(first.id)
    store.schedule.manual(randomUUID(), "2026-10-14T00:00:02Z")
    store.processingState.report(running.id, { phase: "entries", entries: { completed: 2 } })
    const history = vi.spyOn(store.schedule, "triggers")
    const reports = vi.spyOn(store.processingState, "reports")
    expect(automationApi(store, "GET", "/automation/debug", undefined)).toMatchObject({
      queue: { running: 1, pending: 1 },
      run: { id: running.id, status: "running" },
      report: { phase: "entries", entries: { completed: 2 } },
    })
    expect(history).not.toHaveBeenCalled()
    expect(reports).toHaveBeenCalledExactlyOnceWith(running.id)
    store.schedule.finish(running.id, running.leaseToken!, "succeeded", "2026-10-14T00:00:03Z")
    expect(store.schedule.debugRun()).toMatchObject({
      pending: 1,
      running: 0,
      run: { status: "pending" },
    })
  })
})
