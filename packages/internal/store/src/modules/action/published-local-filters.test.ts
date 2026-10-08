import type { RuleSet, TagAssessment } from "@follow/information-core"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useCollectionStore } from "../collection/store"
import { useEntryStore } from "../entry/store"
import type { EntryModel } from "../entry/types"
import {
  getLocalActionSilenceEntryIds,
  getPublishedLocalActionResult,
  isEntryBlockedByLocalActions,
} from "./local-match"
import { useLocalActionStore } from "./local-store"
import {
  clearPublishedLocalFilters,
  evaluatePublishedLocalFilters,
  hydratePublishedLocalFilters,
  setPublishedLocalFilters,
  usePublishedLocalFilterStore,
} from "./published-local-filters"

const config = (mode: "block" | "silence" | "dim" = "block"): RuleSet => ({
  formatVersion: 4,
  ownerId: "owner",
  global: { markdown: "", version: 1 },
  rules: [
    {
      id: "canonical-rule",
      ownerId: "owner",
      name: "共享本地规则",
      enabled: true,
      order: 0,
      version: 1,
      executionLocation: "processing_service",
      when: { all: true },
      actions: [{ type: "local_filter", mode }],
    },
  ],
})

describe("published local filter mirror", () => {
  const cache = new Map<string, string>()
  const storage = {
    getItem: (key: string) => cache.get(key),
    setItem: vi.fn((key: string, value: string) => {
      cache.set(key, value)
    }),
  }
  beforeEach(() => {
    cache.clear()
    storage.setItem.mockClear()
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { localStorage: storage },
    })
    clearPublishedLocalFilters()
    useLocalActionStore.setState({ ownerKey: "owner", isHydrated: true, rules: [] })
    useCollectionStore.setState({ collections: {} })
    useEntryStore.setState({
      data: {
        entry: {
          id: "entry",
          guid: "entry",
          feedId: "1",
          title: "AI",
          read: false,
          insertedAt: new Date(),
          publishedAt: new Date(),
        } as EntryModel,
      },
    })
  })

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "window")
  })

  it("离线刷新从账号缓存恢复，退出只清内存，损坏或跨账号缓存不会执行", () => {
    setPublishedLocalFilters({ ownerId: "owner", ruleSet: config() })
    clearPublishedLocalFilters()
    expect(isEntryBlockedByLocalActions("entry")).toBe(false)
    expect(hydratePublishedLocalFilters("owner")).toBe(true)
    expect(isEntryBlockedByLocalActions("entry")).toBe(true)
    cache.set(
      "follow:published-local-filters:v1:other",
      cache.get("follow:published-local-filters:v1:owner")!,
    )
    expect(hydratePublishedLocalFilters("other")).toBe(false)
    expect(usePublishedLocalFilterStore.getState().snapshot).toBeNull()
    cache.set("follow:published-local-filters:v1:owner", '{"ownerId":"owner","ruleSet":{}}')
    expect(hydratePublishedLocalFilters("owner")).toBe(false)
  })

  it("持久化失败时向上传递错误，内存仍为最后成功发布的镜像", () => {
    setPublishedLocalFilters({ ownerId: "owner", ruleSet: config() })
    storage.setItem.mockImplementationOnce(() => {
      throw new Error("quota")
    })
    const next = config("silence")
    expect(() => setPublishedLocalFilters({ ownerId: "owner", ruleSet: next })).toThrow("quota")
    expect(isEntryBlockedByLocalActions("entry")).toBe(true)
  })

  it("发布后直接接入既有屏蔽和标记已读链路，block 优先于 silence", () => {
    const ruleSet = config("silence")
    setPublishedLocalFilters({ ownerId: "owner", ruleSet })
    expect(getLocalActionSilenceEntryIds(["entry"])).toEqual(["entry"])
    expect(isEntryBlockedByLocalActions("entry")).toBe(false)
    ruleSet.rules[0]!.actions.push({ type: "local_filter", mode: "block" })
    setPublishedLocalFilters({ ownerId: "owner", ruleSet })
    expect(isEntryBlockedByLocalActions("entry")).toBe(true)
    expect(getLocalActionSilenceEntryIds(["entry"])).toEqual([])
  })

  // 虚化仅改变显示，发布、离线恢复和停用均沿用同一份规则快照。
  it("虚化可保存并离线恢复，不隐藏条目也不自动标记已读，停用后恢复显示", () => {
    const ruleSet = config("dim")
    setPublishedLocalFilters({ ownerId: "owner", ruleSet })
    expect(getPublishedLocalActionResult("entry")).toMatchObject({
      dimmed: true,
      blocked: false,
      silenced: false,
    })
    expect(getLocalActionSilenceEntryIds(["entry"])).toEqual([])
    expect(useEntryStore.getState().data.entry!.read).toBe(false)
    clearPublishedLocalFilters()
    expect(getPublishedLocalActionResult("entry").dimmed).toBe(false)
    expect(hydratePublishedLocalFilters("owner")).toBe(true)
    expect(getPublishedLocalActionResult("entry").dimmed).toBe(true)
    ruleSet.rules[0]!.enabled = false
    setPublishedLocalFilters({ ownerId: "owner", ruleSet })
    expect(getPublishedLocalActionResult("entry").dimmed).toBe(false)
    ruleSet.rules[0]!.enabled = true
    ruleSet.rules[0]!.actions = [{ type: "display", language: "zh-CN" }]
    setPublishedLocalFilters({ ownerId: "owner", ruleSet })
    expect(getPublishedLocalActionResult("entry").dimmed).toBe(false)
  })

  it("虚化按条件匹配，未知元数据和切换账号不执行，组合动作保持各自效果", () => {
    const ruleSet = config("dim")
    ruleSet.rules[0]!.when = {
      anyOf: [{ allOf: [{ field: "entry_title", operator: "contains", value: "AI" }] }],
    }
    setPublishedLocalFilters({ ownerId: "owner", ruleSet })
    expect(getPublishedLocalActionResult("entry").dimmed).toBe(true)
    for (const entry_title of ["其他内容", null])
      expect(
        evaluatePublishedLocalFilters(ruleSet, {
          source_id: "feed/1",
          contextId: "entry",
          entry_title,
        }).dimmed,
      ).toBe(false)
    useLocalActionStore.setState({ ownerKey: "other" })
    expect(getPublishedLocalActionResult("entry").dimmed).toBe(false)
    useLocalActionStore.setState({ ownerKey: "owner" })
    ruleSet.rules[0]!.actions.push({ type: "local_filter", mode: "silence" })
    setPublishedLocalFilters({ ownerId: "owner", ruleSet })
    expect(getPublishedLocalActionResult("entry")).toMatchObject({ dimmed: true, silenced: true })
  })

  // 使用截图中的实际置信度，确保显示标签不会绕过规则阈值。
  it("虚化读取 AI 标签判断，高置信命中，低置信、缺失和陈旧定义保持正常显示", () => {
    const ruleSet = config("dim")
    ruleSet.formatVersion = 5
    ruleSet.rules[0]!.when = {
      anyOf: [
        {
          allOf: [
            {
              field: "entry_tag",
              operator: "contains_any",
              value: ["form:pure_entertainment", "signal:social_chatter"],
              minConfidence: 0.8,
            },
          ],
        },
      ],
    }
    setPublishedLocalFilters({ ownerId: "owner", ruleSet })
    const assessment: TagAssessment = {
      tagId: "form:pure_entertainment",
      definitionVersion: 1,
      state: "present",
      confidence: 0.96,
      reason: "主要用于调侃",
      evidenceIds: ["body"],
    }
    expect(getPublishedLocalActionResult("entry").dimmed).toBe(false)
    expect(getPublishedLocalActionResult("entry", [assessment]).dimmed).toBe(true)
    for (const tags of [
      [],
      [{ ...assessment, tagId: "signal:social_chatter" as const, confidence: 0.78 }],
      [{ ...assessment, definitionVersion: 2 }],
      [{ ...assessment, state: "absent" as const }],
    ])
      expect(getPublishedLocalActionResult("entry", tags).dimmed).toBe(false)
    expect(getLocalActionSilenceEntryIds(["entry"])).toEqual([])
  })

  it("账号切换立刻失效，旧账号清理回调不能移除新账号镜像", () => {
    setPublishedLocalFilters({ ownerId: "owner", ruleSet: config() })
    useLocalActionStore.setState({ ownerKey: "other" })
    expect(isEntryBlockedByLocalActions("entry")).toBe(false)
    const other = config()
    other.ownerId = "other"
    other.rules.forEach((rule) => {
      rule.ownerId = "other"
    })
    setPublishedLocalFilters({ ownerId: "other", ruleSet: other })
    clearPublishedLocalFilters("owner")
    expect(isEntryBlockedByLocalActions("entry")).toBe(true)
    expect(() => setPublishedLocalFilters({ ownerId: "owner", ruleSet: other })).toThrow(
      "owner_mismatch",
    )
  })

  it("标签和 List 资格缺失不匹配，完整元数据同步后驱动规则生效", () => {
    const ruleSet = config()
    ruleSet.rules[0]!.when = {
      anyOf: [
        {
          allOf: [
            { field: "subscription_tag", operator: "contains_any", value: ["tag"] },
            { field: "list_id", operator: "in", value: ["list/2"] },
          ],
        },
      ],
    }
    setPublishedLocalFilters({ ownerId: "owner", ruleSet })
    expect(isEntryBlockedByLocalActions("entry")).toBe(false)
    const previousRevision = usePublishedLocalFilterStore.getState().revision
    setPublishedLocalFilters({
      ownerId: "owner",
      ruleSet,
      sourceTags: [{ sourceKey: "feed/1", tagIds: ["tag"] }],
      listMemberships: [{ listKey: "list/2", feedIds: ["1"], complete: true, status: "complete" }],
    })
    expect(getPublishedLocalActionResult("entry").matchedRuleIds).toEqual(["canonical-rule"])
    expect(usePublishedLocalFilterStore.getState().revision).toBeGreaterThan(previousRevision)
  })

  it("只读镜像防止调用者继续修改已发布规则，禁用/AI-only 规则不执行普通动作", () => {
    const ruleSet = config()
    setPublishedLocalFilters({ ownerId: "owner", ruleSet })
    ruleSet.rules[0]!.enabled = false
    expect(isEntryBlockedByLocalActions("entry")).toBe(true)
    expect(
      evaluatePublishedLocalFilters(ruleSet, { source_id: "feed/1", contextId: "entry" }).blocked,
    ).toBe(false)
    ruleSet.rules[0]!.enabled = true
    ruleSet.rules[0]!.actions = [{ type: "ai_transform", prompt: "改写" }]
    expect(
      evaluatePublishedLocalFilters(ruleSet, { source_id: "feed/1", contextId: "entry" })
        .matchedRuleIds,
    ).toEqual([])
  })
})
