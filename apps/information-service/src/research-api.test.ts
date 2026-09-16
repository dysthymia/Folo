import { randomUUID } from "node:crypto"

import { afterEach, expect, it } from "vitest"

import { processingApi } from "./processing-api"
import type { ProcessingDecision } from "./processing-decision"
import type { ResearchRecord } from "./research-store"
import { Store } from "./store"

const stores: Store[] = []
afterEach(() => stores.splice(0).forEach((store) => store.close()))

function fixture() {
  const store = new Store(":memory:")
  stores.push(store)
  store.bindOwner("owner")
  store.automation.publish(0, { mode: "future" }, randomUUID())
  store.saveEntry({
    id: "entry",
    sourceKey: "feed/f1",
    title: "材料标题",
    url: "https://example.test/article",
    publishedAt: "2026-09-01T00:00:00Z",
    read: false,
    content: "可核查原文",
    description: null,
  })
  const input = store.automation.assign(store.automation.inputs()[0]!.seq)
  const decision: ProcessingDecision = {
    schemaVersion: 1,
    fingerprint: "test",
    provider: "qianwen",
    model: "test",
    generatedAt: new Date().toISOString(),
    durationMs: 1,
    usage: null,
    status: "keep",
    title: "处理标题",
    summary: "研究材料摘要",
    reason: "有用",
    labels: [],
    policy: { standalone: "auto", aggregation: "allow", rewrite: "allow" },
    sourceRole: "source",
    context: { source_id: "f1", contextId: input.sourceKey },
    facts: [{ text: "可核查原文", quote: "可核查原文", kind: "fact" }],
    semantic: null,
    reused: false,
  }
  store.automation.complete(input, decision)
  store.processingState.setMaterial(input, "complete")
  const request = {
    target: { kind: "entry", inputSeq: input.seq },
    question: "哪些事实仍需核实？",
    goal: "核对原始披露",
    knownQuestions: ["日期是否一致？"],
  }
  return { store, request, input }
}

it("研究材料包含目标、完整性、规则摘要和引文，文件准备不等于研究执行", () => {
  const { store, request } = fixture()
  const { pack } = processingApi(store, "POST", "/research-packs", request) as {
    pack: ResearchRecord
  }
  expect(pack.status).toBe("prepared")
  expect(pack.markdown).toContain("哪些事实仍需核实？")
  expect(pack.markdown).toContain("核对原始披露")
  expect(pack.markdown).toContain("材料完整性：complete")
  expect(pack.markdown).toContain("发布版本 1")
  expect(pack.markdown).toContain("> 可核查原文")
  expect(pack.markdown).toContain("https://example.test/article")
  expect(pack.markdown).not.toContain("qianwen")
  expect(() => store.research.transition(pack.id, 1, "completed", "结果")).toThrow("invalid_target")
  const submitted = store.research.transition(pack.id, 1, "submitted", "用户手动交给研究任务 A")
  expect(submitted.submissionReference).toContain("研究任务 A")
  expect(() => store.research.transition(pack.id, 1, "completed", "结果")).toThrow(
    "revision_conflict",
  )
  const completed = store.research.transition(pack.id, 2, "completed", "研究报告 A")
  expect(completed.status).toBe("completed")
  expect(completed.markdown).toBe(pack.markdown)
})

it("缺失或失效材料不能准备新包，已经准备的文件保持冻结", () => {
  const { store, request, input } = fixture()
  const { pack } = processingApi(store, "POST", "/research-packs", request) as {
    pack: ResearchRecord
  }
  store.automation.invalidateSources([input.sourceKey])
  expect(() => processingApi(store, "POST", "/research-packs", request)).toThrow("invalid_target")
  expect(store.research.get(pack.id).markdown).toBe(pack.markdown)
  expect(() =>
    processingApi(store, "POST", "/research-packs", { ...request, apiKey: "unwanted" }),
  ).toThrow()
})
