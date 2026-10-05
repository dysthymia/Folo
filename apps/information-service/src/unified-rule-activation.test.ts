import { randomUUID } from "node:crypto"

import type { AutomationRule, Condition, RuleSet } from "@follow/information-core"
import { compileInstructions } from "@follow/information-core"
import { afterEach, describe, expect, it } from "vitest"

import { automationApi } from "./automation-api"
import type { Source } from "./folo"
import { resolveAIRuleSourceKeys, runnableReleasedConfig } from "./processing-rule-scope"
import { Store } from "./store"

const stores: Store[] = []
afterEach(() => stores.splice(0).forEach((store) => store.close()))
const source: Source = {
  key: "feed/1",
  kind: "feed",
  id: "1",
  title: "科技",
  view: 0,
  category: "科技",
}
function fixture() {
  const store = new Store(":memory:")
  stores.push(store)
  store.bindOwner("owner")
  store.replaceSources([source], "2026-09-29T00:00:00.000Z")
  return store
}
function rule(id = "rule-a", extra: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id,
    ownerId: "owner",
    name: id,
    enabled: true,
    order: 0,
    when: { all: true },
    actions: [{ type: "ai_transform", prompt: "摘要" }],
    version: 1,
    executionLocation: "processing_service",
    ...extra,
  }
}
function activate(
  store: Store,
  value: AutomationRule,
  requestId = randomUUID(),
  expectedRevision = store.automation.draft().revision,
) {
  return automationApi(store, "PUT", `/rules/${value.id}/activate`, {
    rule: value,
    requestId,
    expectedRevision,
  })
}
function effective(store: Store): RuleSet {
  return store.automation.effective().config!
}

describe("统一规则的单条保存生效", () => {
  it("运行概览只统计有效规则覆盖，未发布草稿不扩大范围", () => {
    const store = fixture()
    activate(store, rule("active"))
    const draft = store.automation.draft()
    store.automation.saveDraft(
      { ...draft.config, rules: [...draft.config.rules, rule("private-draft", { order: 1 })] },
      draft.revision,
    )
    store.saveEntry({
      id: "entry",
      sourceKey: source.key,
      title: "待处理",
      url: null,
      publishedAt: new Date().toISOString(),
      read: false,
      content: "正文",
      description: null,
    })
    const status = automationApi(store, "GET", "/automation/status", undefined)
    expect(status).toMatchObject({
      sourceInventory: { available: 1, covered: 1, unknown: 0 },
      counts: { processed: 0, pending: 1, needsContext: 0, uncovered: 0 },
      rules: [{ ruleId: "active", sourceKeys: [source.key] }],
    })
    expect((status as { rules: unknown[] }).rules).toHaveLength(1)
  })
  it("批量启用只发布选中的规则，保留其它草稿和私人全局说明", () => {
    const store = fixture()
    activate(store, rule("active"))
    const draft = store.automation.draft()
    store.automation.saveDraft(
      {
        ...draft.config,
        global: { ...draft.config.global, markdown: "私人待审全局" },
        rules: [
          ...draft.config.rules.map((item) => ({ ...item, name: "待审旧规则" })),
          rule("new-a", { order: 1 }),
          rule("new-b", { order: 2 }),
          rule("unselected", { order: 3 }),
        ],
      },
      draft.revision,
    )
    const input = {
      rules: [rule("new-a"), rule("new-b")],
      expectedRevision: store.automation.draft().revision,
      requestId: randomUUID(),
    }
    const result = automationApi(store, "POST", "/rules/activate-batch", input)
    expect(effective(store).rules.map((item) => item.id)).toEqual(["active", "new-a", "new-b"])
    expect(effective(store).rules[0]?.name).toBe("active")
    expect(effective(store).global.markdown).toBe("")
    expect(store.automation.draft().config.global.markdown).toBe("私人待审全局")
    expect(automationApi(store, "POST", "/rules/activate-batch", input)).toEqual(result)
    expect(store.automation.releases()[0]?.targetInputIds).toEqual([])
  })

  it("发布重排只调整有效规则顺序，不偷发布规则内容或草稿新规则", () => {
    const store = fixture()
    activate(store, rule("a"))
    activate(store, rule("b"))
    const draft = store.automation.draft()
    store.automation.saveDraft(
      {
        ...draft.config,
        global: { ...draft.config.global, markdown: "未发布全局" },
        rules: [
          ...draft.config.rules.map((item) => ({ ...item, name: `未发布${item.id}` })),
          rule("draft-only", { order: 2 }),
        ],
      },
      draft.revision,
    )
    const input = {
      ruleIds: ["b", "a"],
      expectedRevision: store.automation.draft().revision,
      requestId: randomUUID(),
    }
    const result = automationApi(store, "POST", "/rules/reorder-active", input)
    expect(effective(store).rules.map((item) => [item.id, item.name, item.order])).toEqual([
      ["b", "b", 0],
      ["a", "a", 1],
    ])
    expect(store.automation.draft().config.rules.map((item) => item.name)).toEqual([
      "未发布b",
      "未发布a",
      "draft-only",
    ])
    expect(effective(store).global.markdown).toBe("")
    expect(automationApi(store, "POST", "/rules/reorder-active", input)).toEqual(result)
    expect(() =>
      automationApi(store, "POST", "/rules/reorder-active", {
        ...input,
        ruleIds: ["a", "draft-only"],
        expectedRevision: store.automation.draft().revision,
        requestId: randomUUID(),
      }),
    ).toThrow("invalid_rule_set")
  })

  it("只发布选中规则，保留其他草稿与全局草稿，并不重算既有结果", () => {
    const store = fixture()
    activate(store, rule("a"))
    activate(store, rule("b"))
    const before = effective(store)
    const draft = store.automation.draft()
    store.automation.saveDraft(
      {
        ...draft.config,
        global: { version: 1, markdown: "未发布全局" },
        rules: draft.config.rules.map((item) =>
          item.id === "b" ? { ...item, name: "未发布B" } : item,
        ),
      },
      draft.revision,
    )
    activate(store, rule("a", { name: "新版A" }))
    expect(effective(store).rules.map((item) => item.name)).toEqual(["新版A", "b"])
    expect(effective(store).global).toEqual(before.global)
    expect(store.automation.draft().config.rules.find((item) => item.id === "b")?.name).toBe(
      "未发布B",
    )
    expect(store.automation.draft().config.global.markdown).toBe("未发布全局")
    expect(store.automation.releases()[0]?.targetInputIds).toEqual([])
    expect(automationApi(store, "GET", "/configuration/effective", null)).toMatchObject({
      config: { rules: [{ name: "新版A" }, { name: "b" }] },
      sources: [{ key: "feed/1" }],
    })
  })

  it("重复请求幂等，旧 revision 或同 requestId 不同内容拒绝覆盖", () => {
    const store = fixture()
    const id = randomUUID()
    const first = activate(store, rule(), id, 0)
    expect(activate(store, rule(), id, 0)).toEqual(first)
    expect(store.automation.releases()).toHaveLength(1)
    expect(() => activate(store, rule("other"), randomUUID(), 0)).toThrow("revision_conflict")
    expect(() => activate(store, rule("other"), id, 0)).toThrow("revision_conflict")
  })

  it("删除只移除当前规则；全局保存不发布其他草稿", () => {
    const store = fixture()
    activate(store, rule("a"))
    activate(store, rule("b"))
    const draft = store.automation.draft()
    store.automation.saveDraft(
      {
        ...draft.config,
        rules: draft.config.rules.map((item) => ({ ...item, name: `草稿${item.id}` })),
      },
      draft.revision,
    )
    automationApi(store, "PUT", "/global-instructions/activate", {
      expectedRevision: store.automation.draft().revision,
      markdown: "全局生效",
      requestId: randomUUID(),
    })
    expect(effective(store).global.markdown).toBe("全局生效")
    expect(effective(store).rules[0]?.name).toBe("a")
    automationApi(store, "DELETE", "/rules/a/activate", {
      expectedRevision: store.automation.draft().revision,
      requestId: randomUUID(),
    })
    expect(effective(store).rules.map((item) => item.name)).toEqual(["b"])
    expect(store.automation.draft().config.rules.map((item) => item.name)).toEqual(["草稿b"])
  })

  it("不存在的分类发布失败时原子回滚草稿和计划", () => {
    const store = fixture()
    expect(() =>
      activate(
        store,
        rule("a", {
          when: {
            anyOf: [
              {
                allOf: [
                  { field: "category_ref", operator: "eq", value: { view: 0, name: "不存在" } },
                ],
              },
            ],
          },
        }),
      ),
    ).toThrow("invalid_rule_set")
    expect(store.automation.draft().revision).toBe(0)
    expect(store.automation.releases()).toEqual([])
    expect(store.schedule.snapshot().config).toBeNull()
  })

  it("旧计划迁移为规则范围，保留时间、历史边界和暂停状态；新增来源自动纳入", () => {
    const store = fixture()
    store.schedule.save(
      {
        sourceKeys: ["feed/1"],
        historySince: "2026-09-01T00:00:00.000Z",
        enabled: false,
        timeZone: "Asia/Shanghai",
        times: ["09:30"],
      },
      0,
    )
    activate(
      store,
      rule("a", {
        when: {
          anyOf: [
            {
              allOf: [{ field: "category_ref", operator: "eq", value: { view: 0, name: "科技" } }],
            },
          ],
        },
      }),
    )
    expect(store.schedule.snapshot().config).toMatchObject({
      scope: { mode: "rules" },
      enabled: false,
      historySince: "2026-09-01T00:00:00.000Z",
      times: ["09:30"],
      sourceKeys: ["feed/1"],
    })
    store.replaceSources(
      [
        source,
        { ...source, key: "feed/2", id: "2" },
        { ...source, key: "feed/3", id: "3", category: "音乐" },
      ],
      "2026-09-29T01:00:00.000Z",
    )
    expect(store.schedule.snapshot().config?.sourceKeys).toEqual(["feed/1", "feed/2"])
  })

  it("单条修改即时刷新动态调度范围，其他未发布草稿不改变范围", () => {
    const store = fixture()
    store.replaceSources(
      [source, { ...source, key: "feed/2", id: "2" }, { ...source, key: "feed/3", id: "3" }],
      "2026-09-29T00:00:00.000Z",
    )
    const sourceRule = (id: string, key: string) =>
      rule(id, {
        when: { anyOf: [{ allOf: [{ field: "source_id", operator: "in", value: [key] }] }] },
      })
    activate(store, sourceRule("a", "feed/1"))
    activate(store, sourceRule("b", "feed/2"))
    const before = store.schedule.snapshot()
    expect(before.config?.sourceKeys).toEqual(["feed/1", "feed/2"])
    const draft = store.automation.draft()
    store.automation.saveDraft(
      {
        ...draft.config,
        rules: draft.config.rules.map((item) =>
          item.id === "b" ? { ...item, enabled: false } : item,
        ),
      },
      draft.revision,
    )
    const response = activate(store, sourceRule("a", "feed/3"))
    expect(response).toMatchObject({
      schedule: {
        revision: before.revision,
        config: { scope: { mode: "rules" }, sourceKeys: ["feed/2", "feed/3"] },
      },
    })
    expect(store.schedule.snapshot().config?.sourceKeys).toEqual(["feed/2", "feed/3"])
    expect(effective(store).rules.find((item) => item.id === "b")?.enabled).toBe(true)
  })

  it("纯普通动作或停用规则不创建 AI 计划，最后一条 AI 停用后范围为空", () => {
    const store = fixture()
    activate(store, rule("ordinary", { actions: [{ type: "local_filter", mode: "silence" }] }))
    expect(store.schedule.snapshot().config).toBeNull()
    activate(store, rule("disabled", { enabled: false }))
    expect(store.schedule.snapshot().config).toBeNull()
    activate(store, rule("ai"))
    expect(store.schedule.snapshot().config?.sourceKeys).toEqual(["feed/1"])
    activate(store, rule("ai", { enabled: false }))
    expect(store.schedule.snapshot().config?.sourceKeys).toEqual([])
    expect(store.schedule.tick("2026-09-29T23:00:00.000Z")).toEqual([])
  })
})

describe("根据规则保守解析选源", () => {
  it("来源、分类和视图可预判，文章条件未知时仍保留来源", () => {
    const store = fixture()
    store.replaceSources(
      [source, { ...source, id: "2", key: "feed/2", category: "音乐", view: 1 }],
      "2026-09-29T00:00:00.000Z",
    )
    const config = {
      ...store.automation.draft().config,
      rules: [
        rule("a", {
          when: {
            anyOf: [
              {
                allOf: [
                  { field: "source_id", operator: "in", value: ["feed/1"] },
                  { field: "view", operator: "eq", value: 0 },
                  { field: "entry_title", operator: "contains", value: "尚未抓取" },
                ],
              },
            ],
          },
        }),
      ],
    }
    expect(resolveAIRuleSourceKeys(store, config)).toEqual(["feed/1"])
  })

  it.each<Condition>([
    { field: "visible_length", operator: "gt", value: 100 },
    { field: "entry_media_length", operator: "gt", value: 0 },
    { field: "entry_attachments_duration", operator: "gt", value: 0 },
    { field: "content_completeness", operator: "eq", value: "complete" },
    { field: "status", operator: "eq", value: "unread" },
    { field: "status", operator: "eq", value: "collected" },
    { field: "language", operator: "eq", value: "zh-CN" },
    { field: "updated_at", operator: "gt", value: "2026-09-01T00:00:00.000Z" },
  ])("文章条件 $field $operator 不得提前排除来源", (condition) => {
    const store = fixture()
    const config = {
      ...store.automation.draft().config,
      rules: [rule("a", { when: { anyOf: [{ allOf: [condition] }] } })],
    }
    expect(resolveAIRuleSourceKeys(store, config)).toEqual(["feed/1"])
  })

  it("未知普通动作不阻塞已命中的 AI 结果", () => {
    const store = fixture()
    const config = {
      ...store.automation.draft().config,
      rules: [
        rule("ai"),
        rule("local", {
          order: 1,
          when: { anyOf: [{ allOf: [{ field: "entry_author", operator: "eq", value: "作者" }] }] },
          actions: [{ type: "local_filter", mode: "block" }],
        }),
      ],
    }
    const instructions = compileInstructions(config, {
      contextId: "feed/1",
      source_id: "feed/1",
      entry_author: null,
    })
    expect(instructions.pendingRuleIds).toEqual(["local"])
    expect(instructions.blocksFinalPresentation).toBe(false)
    expect(instructions.transformations).toHaveLength(1)
  })

  it("历史指令只保留当前仍启用的 AI 动作，历史版本本身不变", () => {
    const store = fixture()
    const historical = {
      ...store.automation.draft().config,
      rules: [rule("a"), rule("b", { order: 1 })],
    }
    const current = {
      ...historical,
      rules: [
        rule("a", { actions: [{ type: "local_filter", mode: "silence" }] }),
        rule("b", { order: 1, enabled: false }),
      ],
    }
    expect(runnableReleasedConfig(historical, current).rules).toEqual([])
    expect(historical.rules).toHaveLength(2)
  })

  it("私人标签和已同步 List 成员参与选源，不完整 List 保持候选", () => {
    const store = fixture()
    store.replaceSources(
      [source, { ...source, id: "2", key: "feed/2" }],
      "2026-09-29T00:00:00.000Z",
    )
    const tag = store.subscriptionTags.create("媒体", 0).tags[0]!
    store.subscriptionTags.updateBindings({
      sourceKeys: ["feed/1"],
      tagIds: [tag.id],
      operation: "add",
      expectedRevision: 1,
    })
    const config = {
      ...store.automation.draft().config,
      rules: [
        rule("a", {
          when: {
            anyOf: [
              {
                allOf: [
                  { field: "subscription_tag", operator: "contains_any", value: [tag.id] },
                  { field: "list_id", operator: "in", value: ["list-a"] },
                ],
              },
            ],
          },
        }),
      ],
    }
    expect(resolveAIRuleSourceKeys(store, config)).toEqual(["feed/1"])
    store.sourceSync.saveListMembership(
      "list/list-a",
      { feedIds: ["2"], complete: true },
      "2026-09-29T00:00:00.000Z",
    )
    expect(resolveAIRuleSourceKeys(store, config)).toEqual([])
  })
})
