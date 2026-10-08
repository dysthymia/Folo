import { randomUUID } from "node:crypto"

import {
  compileInstructions,
  createRuleSchema,
  ruleSchema,
  ruleSetSchema,
} from "@follow/information-core"
import { z } from "zod"

import { AutomationError, promoteSemanticRuleSet } from "./automation-store"
import { processingApi } from "./processing-api"
import { processingRuleInput } from "./processing-engine"
import { nextProcessingRunAt } from "./processing-next-run"
import { activateRuleSchedule, resolveAIRuleSourceKeys } from "./processing-rule-scope"
import { legacyRuleUpgradePreview, prepareLegacyRuleUpgrade } from "./processing-rule-upgrade"
import { sourceText } from "./service"
import type { Store } from "./store"

const revision = z.number().int().nonnegative()
const configUpdate = z.object({ expectedRevision: revision, config: ruleSetSchema }).strict()

export function automationApi(store: Store, method: string, path: string, body: unknown) {
  const processing = processingApi(store, method, path, body)
  if (processing !== undefined) return processing
  const repository = store.automation
  const draft = repository.draft()
  const save = (config: typeof draft.config, expectedRevision: number) =>
    repository.saveDraft(promoteSemanticRuleSet(config), expectedRevision)
  // 首屏和独立接口共用来源快照结构，避免汇总接口与旧接口的字段逐渐漂移。
  const readSourceMetadata = () => ({
    sources: store.sources(),
    sourceInventoryKnown: store.sourceInventoryKnown(),
    subscriptionTags: store.subscriptionTags.snapshot(),
    sourceTags: store.subscriptionTags.sourceTagBindings().bindings,
    // List 成员只读取已持久化的事实，首屏不触发官方来源刷新。
    listMemberships: store.sourceSync.listMemberships(),
  })
  const readEditor = (metadata = readSourceMetadata()) => ({
    ...draft,
    releases: repository.releases(),
    ...metadata,
    // 编辑器只返回样本标题等元数据，正文不能进入配置响应。
    items: store.snapshot().items,
    capabilities: { automaticProcessing: true },
  })
  const readEffective = (metadata = readSourceMetadata()) => ({
    revision: draft.revision,
    ...repository.effective(),
    ...metadata,
  })
  if (path === "/automation/editor" && method === "GET") {
    // 一次鉴权后同步构建首屏的三个只读结果，不再串行等待多次官方凭据交换。
    const metadata = readSourceMetadata()
    return {
      editor: readEditor(metadata),
      effective: readEffective(metadata),
      upgrade: legacyRuleUpgradePreview(store),
    }
  }
  if (path === "/automation/status" && method === "GET") {
    const effective = repository.effective().config
    const scheduleConfig = store.schedule.snapshot().config
    // 尚未迁移的旧固定计划仍按明确名单展示覆盖，不能把 ALL 草稿暗示为全订阅已启用。
    const actualRange = (keys: string[]) =>
      scheduleConfig && scheduleConfig.scope.mode !== "rules"
        ? keys.filter((key) => scheduleConfig.sourceKeys.includes(key))
        : keys
    const sourceKeys = actualRange(resolveAIRuleSourceKeys(store, effective))
    const covered = new Set(sourceKeys)
    const inputs = repository.inputs().filter((input) => input.current)
    const published = store.processingState.published().filter((item) => item.input.current)
    const processed = new Set(published.map((item) => item.input.seq))
    const schedule = store.schedule.readingStatus()
    const now = Date.now()
    const inScheduledRange = (input: (typeof inputs)[number]) =>
      covered.has(input.sourceKey) &&
      (!scheduleConfig ||
        Date.parse(input.body.publishedAt) >= Date.parse(scheduleConfig.historySince)) &&
      Date.parse(input.body.publishedAt) <= now
    // 最近处理按当时发布版本和已冻结上下文归属，不能用当前草稿重新匹配历史来虚增计数。
    const appliedRules = new Map(
      published.map((item) => {
        const release =
          item.input.releaseVersion === null ? null : repository.release(item.input.releaseVersion)
        return [
          item.input.seq,
          new Set(
            release
              ? compileInstructions(release, item.decision.context ?? {}).matched.map(
                  (rule) => rule.id,
                )
              : [],
          ),
        ] as const
      }),
    )
    const rules = (effective?.rules ?? []).map((rule) => {
      const keys = actualRange(resolveAIRuleSourceKeys(store, { ...effective!, rules: [rule] }))
      const matching = published.filter((item) => appliedRules.get(item.input.seq)?.has(rule.id))
      return {
        ruleId: rule.id,
        sourceKeys: keys,
        unknownSourceKeys: keys.filter(
          (key) =>
            store.sourceSync.contextFor(key, {
              id: "status",
              sourceKey: key,
              title: "",
              url: null,
              publishedAt: "1970-01-01T00:00:00Z",
              read: null,
              content: null,
              description: null,
            }).metadata.sourceSyncedAt === null,
        ),
        processed: matching.length,
        lastProcessedAt:
          matching
            .map((item) => item.decision.generatedAt)
            .sort()
            .at(-1) ?? null,
      }
    })
    return {
      sourceInventory: {
        available: store.sources().length,
        covered: sourceKeys.length,
        unknown: new Set(rules.flatMap((rule) => rule.unknownSourceKeys)).size,
      },
      counts: {
        processed: published.filter((item) => covered.has(item.input.sourceKey)).length,
        pending: inputs.filter(
          (input) =>
            inScheduledRange(input) &&
            !processed.has(input.seq) &&
            ["pending", "running"].includes(input.status),
        ).length,
        needsContext: published.filter(
          (item) => inScheduledRange(item.input) && item.decision.status === "needs_context",
        ).length,
        uncovered: inputs.filter((input) => !covered.has(input.sourceKey)).length,
      },
      nextRunAt: nextProcessingRunAt(schedule),
      scheduleEnabled: schedule.enabled,
      timeZone: schedule.timeZone,
      nextScheduledStartLocal: schedule.nextScheduledStartLocal,
      nextPollAt: schedule.nextPollAt,
      rules,
    }
  }
  if ((path === "/rules/activate-batch" || path === "/rules/reorder-active") && method === "POST") {
    if (legacyRuleUpgradePreview(store).required)
      throw new AutomationError("legacy_scope_migration_required")
    const input = (
      path === "/rules/activate-batch"
        ? z
            .object({
              expectedRevision: revision,
              requestId: z.uuid(),
              rules: z.array(ruleSchema).min(1).max(200),
            })
            .strict()
        : z
            .object({
              expectedRevision: revision,
              requestId: z.uuid(),
              ruleIds: z.array(z.string()).max(200),
            })
            .strict()
    ).parse(body)
    const callback = () => {
      activateRuleSchedule(store)
    }
    const result =
      "rules" in input
        ? repository.activateRules(input.rules, input.expectedRevision, input.requestId, callback)
        : repository.reorderRules(input.ruleIds, input.expectedRevision, input.requestId, callback)
    return { ...result, schedule: store.schedule.snapshot() }
  }
  if (path === "/configuration/effective" && method === "GET") {
    // 浏览器普通动作镜像只读取已发布配置，草稿不会在刷新后提前生效。
    return readEffective()
  }
  if (path === "/rules/upgrade-preview" && method === "GET") return legacyRuleUpgradePreview(store)
  if (path === "/rules/upgrade" && method === "POST") {
    const input = z
      .object({
        expectedRevision: revision,
        expectedScheduleRevision: revision,
        requestId: z.uuid(),
      })
      .strict()
      .parse(body)
    const result = repository.upgradeRules(
      input.expectedRevision,
      input.expectedScheduleRevision,
      input.requestId,
      () => prepareLegacyRuleUpgrade(store, input.expectedScheduleRevision),
      () => {
        activateRuleSchedule(store)
      },
    )
    return { ...result, schedule: store.schedule.snapshot() }
  }
  const activationId = /^\/rules\/([^/]+)\/activate$/.exec(path)?.[1]
  if (activationId && (method === "PUT" || method === "DELETE")) {
    // 先显式继承旧范围，避免保存任意新规则时把旧 ALL 规则静默扩大到全部订阅。
    if (legacyRuleUpgradePreview(store).required)
      throw new AutomationError("legacy_scope_migration_required")
    const input = (
      method === "PUT"
        ? z.object({ expectedRevision: revision, requestId: z.uuid(), rule: ruleSchema }).strict()
        : z.object({ expectedRevision: revision, requestId: z.uuid() }).strict()
    ).parse(body)
    const result = repository.activateRule(
      activationId,
      "rule" in input ? ruleSchema.parse(input.rule) : null,
      input.expectedRevision,
      input.requestId,
      () => {
        activateRuleSchedule(store)
      },
    )
    return { ...result, schedule: store.schedule.snapshot() }
  }
  if (path === "/global-instructions/activate" && method === "PUT") {
    const input = z
      .object({ expectedRevision: revision, markdown: z.string().max(60000), requestId: z.uuid() })
      .strict()
      .parse(body)
    const result = repository.activateGlobal(
      input.markdown,
      input.expectedRevision,
      input.requestId,
    )
    return { ...result, schedule: store.schedule.snapshot() }
  }
  if (path === "/configuration") {
    if (method === "GET") return readEditor()
    if (method === "PUT") {
      const input = configUpdate.parse(body)
      return save(input.config, input.expectedRevision)
    }
  }
  if (path === "/subscription-tags") {
    if (method === "GET") return store.subscriptionTags.snapshot()
    if (method === "POST") {
      const input = z
        .object({ name: z.string().min(1).max(100), expectedRevision: revision })
        .strict()
        .parse(body)
      return store.subscriptionTags.create(input.name, input.expectedRevision)
    }
  }
  const tagId = /^\/subscription-tags\/([^/]+)$/.exec(path)?.[1]
  if (tagId && method === "PUT") {
    const input = z
      .object({ name: z.string().min(1).max(100), expectedRevision: revision })
      .strict()
      .parse(body)
    return store.subscriptionTags.rename(tagId, input.name, input.expectedRevision)
  }
  if (tagId && method === "DELETE") {
    const input = z.object({ expectedRevision: revision }).strict().parse(body)
    return store.subscriptionTags.delete(tagId, input.expectedRevision)
  }
  if (path === "/source-tags") {
    if (method === "GET") return store.subscriptionTags.sourceTagBindings()
    if (method === "PUT") {
      const input = z
        .object({
          expectedRevision: revision,
          sourceKeys: z.array(z.string()).min(1).max(10000),
          tagIds: z.array(z.string()).min(1).max(1000),
          operation: z.enum(["add", "remove"]),
        })
        .strict()
        .parse(body)
      const sources = new Set(
        store
          .sources()
          .filter((source) => source.kind !== "list")
          .map((source) => source.key),
      )
      for (const membership of store.sourceSync.listMemberships()) {
        if (membership.status !== "complete" || !membership.complete) continue
        for (const feedId of membership.feedIds) sources.add(`feed/${feedId}`)
      }
      if (input.sourceKeys.some((key) => !sources.has(key)))
        throw new AutomationError("invalid_target")
      const changed = store.subscriptionTags.updateBindings(input)
      if (changed.changedBindings > 0) {
        const targets = repository.invalidateSources(input.sourceKeys)
        store.stories.invalidateInputs(targets)
      }
      return changed
    }
  }
  if (path === "/global-instructions") {
    if (method === "GET") return { ...draft.config.global, revision: draft.revision }
    if (method === "PUT") {
      const input = z
        .object({ markdown: z.string().max(60000), expectedRevision: revision })
        .strict()
        .parse(body)
      return save(
        { ...draft.config, global: { ...draft.config.global, markdown: input.markdown } },
        input.expectedRevision,
      )
    }
  }
  if (path === "/rules") {
    if (method === "GET") return { revision: draft.revision, rules: draft.config.rules }
    if (method === "POST") {
      const input = z
        .object({
          expectedRevision: revision,
          rule: createRuleSchema,
        })
        .strict()
        .parse(body)
      // 身份、版本和位置由服务生成，客户端不得伪装其他账号或跳过并发检查。
      const rule = {
        ...input.rule,
        id: randomUUID(),
        ownerId: draft.config.ownerId,
        version: 1,
        order: Math.max(-1, ...draft.config.rules.map((item) => item.order)) + 1,
      }
      return save({ ...draft.config, rules: [...draft.config.rules, rule] }, input.expectedRevision)
    }
  }
  if (path === "/rules/reorder" && method === "POST") {
    const input = z
      .object({ expectedRevision: revision, ids: z.array(z.string()).max(200) })
      .strict()
      .parse(body)
    if (
      new Set(input.ids).size !== input.ids.length ||
      input.ids.length !== draft.config.rules.length ||
      input.ids.some((id) => !draft.config.rules.some((rule) => rule.id === id))
    )
      throw new AutomationError("invalid_rule_set")
    return save(
      {
        ...draft.config,
        rules: input.ids.map((id, order) => ({
          ...draft.config.rules.find((rule) => rule.id === id)!,
          order,
        })),
      },
      input.expectedRevision,
    )
  }
  if (path === "/rules/preview" && method === "POST") {
    const request = z
      .object({
        sourceKey: z.string().min(1),
        entryId: z.string().min(1),
        config: ruleSetSchema.optional(),
      })
      .strict()
      .parse(body)
    const config = request.config ?? draft.config
    if (config.ownerId !== store.ownerId) throw new AutomationError("invalid_rule_set")
    const source = store.sources().find((item) => item.key === request.sourceKey)
    const entry = source && store.entry(source.key, request.entryId)
    if (!entry || !source) throw new AutomationError("invalid_target")
    const content = entry.content ? sourceText(entry.content) : null
    // 预览与执行共用同一上下文构造，防止 List 身份、标签和长度口径分叉。
    const current = repository.current(source.key, entry.id)
    const complete = current !== null && store.processingState.material(current) === "complete"
    const input = processingRuleInput(store, source.key, entry, content, complete)
    // 仅复用当前材料的已发布语义；未分析样本保持 unknown，不伪造零命中。
    const decision = current
      ? store.processingState.published([current.seq])[0]?.decision
      : undefined
    const profile =
      decision?.semanticProfile ?? (current ? store.semantics.view(current).profile : null)
    input.entry_tag =
      current && profile
        ? store.semantics.assessments(current, profile)
        : (decision?.semantic?.tagAssessments ?? null)
    const compiled = compileInstructions(config, input)
    return {
      entryId: entry.id,
      sourceKey: source.key,
      material: content ? "source_text" : "missing",
      input,
      metadataVersion: store.subscriptionTags.snapshot().revision,
      ...compiled,
      counts: {
        matched: compiled.matches.filter((match) => match.state === "match").length,
        unknown: compiled.matches.filter((match) => match.state === "unknown").length,
        noMatch: compiled.matches.filter((match) => match.state === "no_match").length,
      },
    }
  }
  if (path === "/rule-set-releases/preview" && method === "POST") {
    const input = z.object({ scope: z.unknown() }).strict().parse(body)
    // 预览与发布共用 Store 的目标选择器，只读返回当前时点的影响口径。
    return repository.previewPublication(input.scope)
  }
  if (path === "/rule-set-releases") {
    if (method === "GET") return { releases: repository.releases() }
    if (method === "POST") {
      const input = z
        .object({ expectedRevision: revision, scope: z.unknown(), requestId: z.uuid() })
        .strict()
        .parse(body)
      const release = repository.publish(input.expectedRevision, input.scope, input.requestId)
      store.stories.invalidateInputs(release.targetInputIds)
      return release
    }
  }
  const releaseVersion = /^\/rule-set-releases\/(\d+)$/.exec(path)?.[1]
  if (releaseVersion && method === "GET") {
    const snapshot = repository.releaseSnapshot(
      z.number().int().positive().parse(Number(releaseVersion)),
    )
    if (!snapshot) throw new AutomationError("invalid_target")
    return snapshot
  }
  const ruleId = /^\/rules\/([^/]+)$/.exec(path)?.[1]
  if (ruleId) {
    const existing = draft.config.rules.find((rule) => rule.id === ruleId)
    if (!existing) throw new AutomationError("invalid_target")
    if (method === "GET") return { revision: draft.revision, rule: existing }
    if (method === "PUT") {
      const input = z.object({ expectedRevision: revision, rule: ruleSchema }).strict().parse(body)
      if (input.rule.id !== ruleId) throw new AutomationError("invalid_target")
      return save(
        {
          ...draft.config,
          rules: draft.config.rules.map((rule) => (rule.id === ruleId ? input.rule : rule)),
        },
        input.expectedRevision,
      )
    }
    if (method === "DELETE") {
      const input = z.object({ expectedRevision: revision }).strict().parse(body)
      return save(
        { ...draft.config, rules: draft.config.rules.filter((rule) => rule.id !== ruleId) },
        input.expectedRevision,
      )
    }
  }
  if (path === "/inputs" && method === "GET")
    return { inputs: repository.inputs().map(({ body: _body, ...input }) => input) }
  throw new AutomationError("invalid_target")
}
