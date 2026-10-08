import { randomUUID } from "node:crypto"

import { describe, expect, it } from "vitest"

import type { ProcessingDecision } from "./processing-decision"
import type { DecisionQuarantine } from "./processing-state"
import { Store } from "./store"

function fixture() {
  const store = new Store(":memory:")
  store.bindOwner("owner")
  for (const id of ["1", "2"])
    store.saveEntry({
      sourceKey: "feed/1",
      id,
      title: `融资公告${id}`,
      url: null,
      publishedAt: "2026-10-01T00:00:00Z",
      read: false,
      content: "融资一亿美元，部署32套设备。",
      description: null,
    })
  store.automation.publish(0, { mode: "future" }, randomUUID())
  const manifests: DecisionQuarantine[] = []
  for (const original of store.automation.inputs()) {
    const { input } = store.processingState.prepare(original.seq, {
      context: { source_id: "feed/1", contextId: "feed/1" },
      provider: "codex",
      model: "fake",
      sourceRole: "媒体",
      metadataVersion: 1,
    })
    const decision: ProcessingDecision = {
      schemaVersion: 1,
      fingerprint: `bad-${input.seq}`,
      provider: "codex",
      model: "fake",
      generatedAt: "2026-10-01T01:00:00Z",
      durationMs: 1,
      usage: null,
      status: "hide",
      title: "错配奖励计划",
      summary: "错配摘要",
      reason: "错误证据",
      labels: [],
      policy: { standalone: "auto", aggregation: "allow", rewrite: "deny" },
      sourceRole: "媒体",
      context: { source_id: "feed/1", contextId: "feed/1" },
      facts: [],
      semantic: null,
      reused: false,
    }
    store.processingState.saveCache(decision)
    const completed = store.automation.complete(input, decision)
    manifests.push({
      inputSeq: input.seq,
      contentVersion: input.contentVersion,
      decisionId: completed.id,
      status: "keep",
      reason: "已核验材料错配，恢复原文。",
      summary: "融资一亿美元，部署32套设备。",
    })
  }
  return { store, manifests }
}

describe("已确认错误决定的定向隔离", () => {
  it("新代际恢复原文并隔离缓存，重复执行不改代际或读态", () => {
    const { store, manifests } = fixture()
    try {
      const original = store.automation.inputs()[0]!
      store.processingState.quarantine(manifests)
      const current = store.automation.inputs()[0]!
      const published = store.processingState.published([current.seq])[0]!
      expect(current.generation).toBe(original.generation + 1)
      expect(current.body.read).toBe(false)
      expect(published.decision).toMatchObject({
        status: "keep",
        title: original.body.title,
        semantic: null,
        facts: [],
        repair: { sourceDecisionId: manifests[0]!.decisionId },
        policy: { standalone: "always", aggregation: "deny" },
      })
      expect(store.processingState.cache(`bad-${current.seq}`)).toBeNull()
      expect(store.processingState.quarantine(manifests).every((item) => item.repeated)).toBe(true)
      expect(store.automation.inputs()[0]!.generation).toBe(current.generation)
      // 旧缓存重写仍不能复活已经隔离的错误指纹。
      store.processingState.saveCache({
        ...published.decision,
        fingerprint: `bad-${current.seq}`,
        status: "hide",
      })
      expect(store.processingState.cache(`bad-${current.seq}`)).toBeNull()
    } finally {
      store.close()
    }
  })

  it("清单任一正文守卫失效时整份清单不产生半修复", () => {
    const { store, manifests } = fixture()
    try {
      expect(() =>
        store.processingState.quarantine([
          manifests[0]!,
          { ...manifests[1]!, contentVersion: "stale" },
        ]),
      ).toThrow("revision_conflict")
      expect(
        store.processingState.published().every(({ decision }) => decision.status === "hide"),
      ).toBe(true)
      expect(store.processingState.cache(`bad-${manifests[0]!.inputSeq}`)).not.toBeNull()
    } finally {
      store.close()
    }
  })

  it("材料不足修复明确待补，不把错误摘要作为综述材料", () => {
    const { store, manifests } = fixture()
    try {
      store.processingState.quarantine([
        { ...manifests[0]!, status: "needs_context", summary: "仅有原始标题，待补正文。" },
      ])
      expect(store.processingState.published([manifests[0]!.inputSeq])[0]!.decision).toMatchObject({
        status: "needs_context",
        summary: "仅有原始标题，待补正文。",
        policy: { aggregation: "deny", rewrite: "deny" },
      })
    } finally {
      store.close()
    }
  })
})
