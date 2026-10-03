import { randomUUID } from "node:crypto"

import type { AutomationRule, RuleSet, ScheduleScope } from "@follow/information-core"
import { matchConditions } from "@follow/information-core"
import { afterEach, describe, expect, it } from "vitest"

import { automationApi } from "./automation-api"
import type { Source } from "./folo"
import { processingApi } from "./processing-api"
import { legacyRuleUpgradePreview } from "./processing-rule-upgrade"
import { Store } from "./store"

const stores: Store[] = []
afterEach(() => stores.splice(0).forEach((store) => store.close()))
const source: Source = {
  key: "feed/1",
  kind: "feed",
  id: "1",
  title: "旧来源",
  view: 0,
  category: "科技",
}
const aiRule: AutomationRule = {
  id: "legacy",
  name: "旧规则",
  ownerId: "owner",
  enabled: true,
  order: 0,
  version: 1,
  executionLocation: "processing_service",
  when: { all: true },
  actions: [{ type: "ai_transform", prompt: "摘要" }],
}
function fixture(scope: ScheduleScope = { mode: "fixed", sourceKeys: [source.key] }) {
  const store = new Store(":memory:")
  stores.push(store)
  store.bindOwner("owner")
  store.replaceSources(
    [
      source,
      { ...source, id: "2", key: "feed/2", category: "音乐" },
      { ...source, id: "3", key: "list/3", kind: "list" },
    ],
    "2026-09-29T00:00:00.000Z",
  )
  const config: RuleSet = {
    ...store.automation.draft().config,
    rules: [
      aiRule,
      {
        ...aiRule,
        id: "ordinary",
        name: "普通",
        order: 1,
        actions: [{ type: "local_filter", mode: "silence" }],
      },
    ],
  }
  store.automation.saveDraft(config, 0)
  store.automation.publish(1, { mode: "future" }, randomUUID())
  store.schedule.save(
    {
      scope,
      sourceKeys: scope.mode === "fixed" ? scope.sourceKeys : [source.key],
      historySince: "2026-09-01T00:00:00.000Z",
      enabled: false,
      timeZone: "Asia/Shanghai",
      times: ["09:30"],
    },
    0,
  )
  return store
}
function upgrade(
  store: Store,
  requestId = randomUUID(),
  expectedRevision = store.automation.draft().revision,
  expectedScheduleRevision = store.schedule.snapshot().revision,
) {
  return automationApi(store, "POST", "/rules/upgrade", {
    expectedRevision,
    expectedScheduleRevision,
    requestId,
  })
}

describe("旧运行范围显式升级", () => {
  it("旧ALL规则不会因保存新规则或运行时间而扩大到所有来源", () => {
    const store = fixture()
    expect(automationApi(store, "GET", "/rules/upgrade-preview", null)).toMatchObject({
      required: true,
      supported: true,
      expectedRevision: 1,
      expectedScheduleRevision: 1,
      sourceCount: 1,
      affectedRules: [{ id: "legacy", name: "旧规则" }],
    })
    expect(() =>
      automationApi(store, "PUT", "/rules/new/activate", {
        expectedRevision: 1,
        requestId: randomUUID(),
        rule: { ...aiRule, id: "new" },
      }),
    ).toThrow("legacy_scope_migration_required")
    expect(() =>
      processingApi(store, "PUT", "/schedule", {
        expectedRevision: 1,
        config: { ...store.schedule.snapshot().config!, scope: { mode: "rules" } },
      }),
    ).toThrow("legacy_scope_migration_required")
    expect(store.automation.draft().revision).toBe(1)
    expect(store.automation.releases()).toHaveLength(1)
    expect(store.schedule.snapshot().revision).toBe(1)
  })

  it("固定范围继承为来源条件，迁移后新增规则可独立选源且不修改旧范围", () => {
    const store = fixture()
    const response = upgrade(store)
    expect(response).toMatchObject({
      effectiveConfig: {
        rules: [
          {
            when: {
              anyOf: [{ allOf: [{ field: "source_id", operator: "in", value: [source.key] }] }],
            },
          },
          { id: "ordinary" },
        ],
      },
      release: { targetInputIds: [] },
      schedule: {
        config: {
          scope: { mode: "rules" },
          sourceKeys: expect.arrayContaining([source.key]),
          enabled: false,
          times: ["09:30"],
          historySince: "2026-09-01T00:00:00.000Z",
        },
      },
    })
    expect(store.schedule.snapshot().config?.sourceKeys).not.toContain("feed/2")
    expect(legacyRuleUpgradePreview(store).required).toBe(false)
    const saved = store.automation.draft()
    automationApi(store, "PUT", "/rules/new/activate", {
      expectedRevision: saved.revision,
      requestId: randomUUID(),
      rule: {
        ...aiRule,
        id: "new",
        when: { anyOf: [{ allOf: [{ field: "source_id", operator: "in", value: ["feed/2"] }] }] },
      },
    })
    expect(store.schedule.snapshot().config?.sourceKeys).toContain("feed/2")
    const legacy = store.automation.effective().config!.rules.find((rule) => rule.id === "legacy")!
    expect(matchConditions(legacy.when, { source_id: "feed/2", contextId: "feed/2" }).state).toBe(
      "no_match",
    )
  })

  it("升级保持全局和普通规则的未发布草稿，不把其body或version发布", () => {
    const store = fixture()
    const active = store.automation.effective().config!
    const draft = store.automation.draft()
    store.automation.saveDraft(
      {
        ...draft.config,
        global: { ...draft.config.global, markdown: "未发布全局" },
        rules: draft.config.rules.map((rule) =>
          rule.id === "ordinary" ? { ...rule, name: "未发布普通规则" } : rule,
        ),
      },
      draft.revision,
    )
    upgrade(store)
    expect(store.automation.effective().config!.global).toEqual(active.global)
    expect(
      store.automation.effective().config!.rules.find((rule) => rule.id === "ordinary"),
    ).toEqual(active.rules.find((rule) => rule.id === "ordinary"))
    expect(store.automation.draft().config.global.markdown).toBe("未发布全局")
    expect(store.automation.draft().config.rules.find((rule) => rule.id === "ordinary")?.name).toBe(
      "未发布普通规则",
    )
  })

  it("旧AI规则存在不一致草稿时拒绝升级，避免之后保存把继承范围覆盖掉", () => {
    const store = fixture()
    const draft = store.automation.draft()
    store.automation.saveDraft(
      {
        ...draft.config,
        rules: draft.config.rules.map((rule) =>
          rule.id === "legacy" ? { ...rule, name: "未发布旧规则" } : rule,
        ),
      },
      draft.revision,
    )
    expect(legacyRuleUpgradePreview(store)).toMatchObject({
      required: true,
      supported: false,
      reason: "draft_conflict",
    })
    expect(() => upgrade(store)).toThrow("legacy_scope_upgrade_blocked")
    expect(store.automation.draft().revision).toBe(2)
    expect(store.schedule.snapshot().config?.scope.mode).toBe("fixed")
  })

  it("List固定容器不能假装feed名单升级", () => {
    const store = fixture({ mode: "fixed", sourceKeys: ["list/3"] })
    expect(legacyRuleUpgradePreview(store)).toMatchObject({
      supported: false,
      reason: "unsupported_legacy_sources",
    })
    expect(() => upgrade(store)).toThrow("legacy_scope_upgrade_blocked")
    expect(store.automation.releases()).toHaveLength(1)
  })

  it.each<ScheduleScope>([{ mode: "all" }, { mode: "category", view: 0, category: "科技" }])(
    "支持 $mode 描述符并保留旧条件逻辑",
    (scope) => {
      const store = fixture(scope)
      upgrade(store)
      const when = store.automation.effective().config!.rules[0]!.when
      expect(when).toEqual(
        scope.mode === "all"
          ? { all: true }
          : {
              anyOf: [
                {
                  allOf: [
                    { field: "category_ref", operator: "eq", value: { view: 0, name: "科技" } },
                  ],
                },
              ],
            },
      )
    },
  )

  it("并发检查与幂等跨计划生效，旧请求不能重复创建发布", () => {
    const store = fixture()
    expect(() => upgrade(store, randomUUID(), 0, 1)).toThrow("revision_conflict")
    expect(() => upgrade(store, randomUUID(), 1, 0)).toThrow("revision_conflict")
    const requestId = randomUUID()
    const first = upgrade(store, requestId, 1, 1)
    expect(upgrade(store, requestId, 1, 1)).toEqual(first)
    expect(store.automation.releases()).toHaveLength(2)
    expect(() => upgrade(store, requestId, 2, 1)).toThrow("revision_conflict")
  })
})
