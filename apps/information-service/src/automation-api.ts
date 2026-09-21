import { randomUUID } from "node:crypto"

import {
  compileInstructions,
  createRuleSchema,
  ruleSchema,
  ruleSetSchema,
} from "@follow/information-core"
import { z } from "zod"

import { AutomationError } from "./automation-store"
import { processingApi } from "./processing-api"
import { processingRuleInput } from "./processing-engine"
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
    repository.saveDraft(config, expectedRevision)
  if (path === "/configuration") {
    if (method === "GET")
      return {
        ...draft,
        releases: repository.releases(),
        // 编辑器一次授权读取真实来源和样本标题，不把正文装入配置响应。
        sources: store.sources(),
        sourceInventoryKnown: store.sourceInventoryKnown(),
        items: store.snapshot().items,
        subscriptionTags: store.subscriptionTags.snapshot(),
        sourceTags: store.subscriptionTags.sourceTagBindings().bindings,
        // List 成员只能读取已持久化的同步事实；配置 GET 不触发新的官方 API 请求。
        listMemberships: store.sourceSync.listMemberships(),
        capabilities: { automaticProcessing: true },
      }
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
    return {
      entryId: entry.id,
      sourceKey: source.key,
      material: content ? "source_text" : "missing",
      input,
      metadataVersion: store.subscriptionTags.snapshot().revision,
      ...compileInstructions(config, input),
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
