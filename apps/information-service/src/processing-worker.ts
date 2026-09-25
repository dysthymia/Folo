import type { ConditionSet } from "@follow/information-core"

import type { AIConfigStore } from "./ai-config"
import { expandXContexts } from "./content-identity"
import type { FoloReader } from "./folo"
import { runSemanticDedupe } from "./processing-dedupe"
import { runEntryProcessing, settleReadStates } from "./processing-engine"
import type { ProcessingTriggerStatus } from "./processing-schedule"
import { acquireSources } from "./processing-source-sync"
import { errorCode, sourceText } from "./service"
import type { Store } from "./store"
import { runStoryAggregation } from "./story-engine"
import { runStoryRepair } from "./story-repair"

export type ProcessingWorkerOptions = {
  store: Store
  reader: () => Promise<FoloReader>
  aiConfig: AIConfigStore
  runtimeDir: string
  acquire?: typeof acquireSources
  processEntries?: typeof runEntryProcessing
  aggregate?: typeof runStoryAggregation
  repair?: typeof runStoryRepair
  dedupe?: typeof runSemanticDedupe
}

// 调度只领取明确保存的范围；尚未选择来源或发布规则时不会生成模型请求。
export async function runProcessingWorker(options: ProcessingWorkerOptions, signal: AbortSignal) {
  const { store } = options
  if (!store.ownerId || signal.aborted) return null
  store.schedule.tick(new Date())
  if (!store.automation.releases().length) return null
  const trigger = store.schedule.claim(new Date(), 30 * 60_000)
  if (!trigger?.leaseToken) return null
  const lease = trigger.leaseToken
  let status: Exclude<ProcessingTriggerStatus, "pending" | "running"> = "succeeded"
  try {
    expandXContexts(store)
    const previousContexts = new Map(
      store.automation
        .inputs()
        .map((input) => [input.seq, contextFingerprint(store, input.sourceKey, input.body)]),
    )
    const foloSourceKeys = trigger.sourceKeys.filter((key) => !key.startsWith("x/search/"))
    const sources = foloSourceKeys.length
      ? await (options.acquire ?? acquireSources)(
          {
            store,
            reader: options.reader,
            state: store.sourceSync,
            sourceKeys: foloSourceKeys,
            membershipListKeys: referencedListKeys(store),
            historySince: trigger.historySince,
          },
          signal,
        )
      : []
    // X 抓取由显式搜索操作负责；处理计划可读取已保存结果，但不能暗中产生外部搜索费用。
    for (const key of trigger.sourceKeys.filter((key) => key.startsWith("x/search/"))) {
      const query = store.xQueries.list().find((item) => item.sourceKey === key)
      const state = query ? store.xQueries.state(query.id) : null
      sources.push({
        sourceKey: key,
        pages: 0,
        entries: 0,
        coverage: state?.status === "complete" ? "end" : "pending",
        failure: state?.failure ?? null,
      })
    }
    const changedSources = store.automation
      .inputs()
      .filter((input) => {
        const previous = previousContexts.get(input.seq)
        return (
          previous !== undefined &&
          previous !== contextFingerprint(store, input.sourceKey, input.body)
        )
      })
      .map((input) => input.sourceKey)
    if (changedSources.length)
      store.stories.invalidateInputs(
        store.automation.invalidateSources([...new Set(changedSources)]),
      )
    // 已读条目在抓详情之前就退出队列：材料水合与可读性提取都不该为它们白跑一遍。
    settleReadStates(store)
    const material = await hydrateMaterials(
      options,
      trigger.sourceKeys,
      trigger.historySince,
      trigger.cutoffAt,
      signal,
    )
    const entries = await (options.processEntries ?? runEntryProcessing)({
      store,
      aiConfig: options.aiConfig,
      runtimeDir: options.runtimeDir,
      sourceKeys: trigger.sourceKeys,
      historySince: trigger.historySince,
      cutoffAt: trigger.cutoffAt,
      signal,
    })
    // 每个已发布版本按自己的综合指令执行，不能把新草稿混进旧版本决策。
    const decisions = store.processingState.published()
    const releasedRuleSets = store.automation.releases().map((release) => ({
      version: release.version,
      config: store.automation.release(release.version)!,
    }))
    // 先修复既有 Story，保留原身份，再允许新增事件聚合，避免修复对象被复制成新 Story。
    const repair = await (options.repair ?? runStoryRepair)({
      decisions,
      ruleSets: releasedRuleSets.map((release) => release.config),
      releasedRuleSets,
      stories: store.stories,
      aiConfig: options.aiConfig,
      runtimeDir: options.runtimeDir,
      signal,
    })
    const repairedMembers = repair.repaired.flatMap(
      (item) =>
        store.stories.currentSnapshot(item.storyId)?.members.map((member) => member.inputSeq) ?? [],
    )
    const versions = [...new Set(decisions.map((item) => item.input.releaseVersion))]
    const stories = []
    const overrides = new Map(
      store.processingState.overrides().map((item) => [item.inputSeq, item.mode]),
    )
    for (const version of versions) {
      if (signal.aborted) break
      const ruleSet = version === null ? null : store.automation.release(version)
      if (!ruleSet) continue
      stories.push(
        await (options.aggregate ?? runStoryAggregation)({
          decisions: decisions.filter(
            (item) =>
              item.input.releaseVersion === version && overrides.get(item.input.seq) !== "hide",
          ),
          ruleSet,
          alreadyClaimedInputSeqs: repairedMembers,
          stories: store.stories,
          aiConfig: options.aiConfig,
          runtimeDir: options.runtimeDir,
          signal,
        }),
      )
    }
    // 语义去重在单篇决定与综述都落定之后执行：它只处理仍然独立显示的条目，综述成员
    // 由角色层优先接管，不需要在这里重复排除。
    const dedupe = await (options.dedupe ?? runSemanticDedupe)({
      store,
      aiConfig: options.aiConfig,
      runtimeDir: options.runtimeDir,
      signal,
    })
    const failure =
      repair.failures.length > 0 ||
      sources.some((source) => source.failure) ||
      material.failed > 0 ||
      entries.failures.length > 0 ||
      stories.some((story) => story.failures.length > 0)
    const pending =
      repair.pending.length > 0 ||
      sources.some((source) =>
        ["pending", "budget", "timestamp_boundary"].includes(source.coverage),
      ) ||
      entries.pending > 0 ||
      dedupe.pending > 0 ||
      stories.some((story) =>
        story.pending.some((item) =>
          ["material_too_large", "scope_unknown", "invalid_model_group"].includes(item.reason),
        ),
      )
    status = signal.aborted
      ? "cancelled"
      : failure
        ? "retry_wait"
        : pending
          ? "deferred_budget"
          : "succeeded"
    store.processingState.report(trigger.id, {
      sources,
      material,
      entries,
      stories,
      repair,
      dedupe,
      finishedAt: new Date().toISOString(),
    })
    store.schedule.finish(
      trigger.id,
      lease,
      status,
      new Date(),
      failure ? "processing_incomplete" : null,
    )
  } catch (error) {
    status = signal.aborted ? "cancelled" : "failed"
    store.schedule.finish(trigger.id, lease, status, new Date(), errorCode(error))
  }
  return { id: trigger.id, status }
}

async function hydrateMaterials(
  options: ProcessingWorkerOptions,
  sourceKeys: string[],
  historySince: string,
  cutoffAt: string,
  signal: AbortSignal,
) {
  const { store } = options
  const sources = new Map(store.sources().map((source) => [source.key, source]))
  const selected = new Set(sourceKeys)
  const inputs = store.automation
    .inputs()
    .filter(
      (input) =>
        selected.has(input.sourceKey) &&
        input.status === "pending" &&
        Date.parse(input.body.publishedAt) >= Date.parse(historySince) &&
        Date.parse(input.body.publishedAt) <= Date.parse(cutoffAt),
    )
  let complete = 0
  let missing = 0
  let failed = 0
  let reader: FoloReader | undefined
  for (const input of inputs) {
    signal.throwIfAborted()
    if (["complete", "missing"].includes(store.processingState.material(input) ?? "")) continue
    const source = sources.get(input.sourceKey)
    if (!source) continue
    if (source.kind === "x_search") {
      const state = sourceText(input.body.content ?? "") ? "complete" : "missing"
      store.processingState.setMaterial(input, state)
      if (state === "complete") complete++
      else missing++
      continue
    }
    try {
      reader ??= await options.reader()
      const entry = await reader.detail(source, input.body)
      if (source.kind !== "inbox" && !sourceText(entry.content ?? ""))
        entry.content = await reader.readability(entry.id)
      // 详情与正文提取完成后才记录材料状态；简介不会被当作完整正文长度。
      store.saveEntry(entry)
      const current = store.automation.current(entry.sourceKey, entry.id)!
      const state = sourceText(entry.content ?? "") ? "complete" : "missing"
      store.processingState.setMaterial(current, state)
      if (current.seq !== input.seq) store.stories.invalidateInputs([input.seq])
      if (state === "complete") complete++
      else missing++
    } catch {
      store.processingState.setMaterial(input, "failed")
      failed++
    }
  }
  return { complete, missing, failed }
}

function contextFingerprint(store: Store, sourceKey: string, body: import("./folo").SourceEntry) {
  const { metadata: _metadata, ...context } = store.sourceSync.contextFor(sourceKey, body)
  // 同步时间自身不触发重算；来源身份、分类与实际 List 资格变化才使旧目标失效。
  return JSON.stringify(context)
}

function referencedListKeys(store: Store) {
  const currentVersions = new Set(
    store.automation
      .inputs()
      .map((input) => input.releaseVersion)
      .filter((version): version is number => version !== null),
  )
  const latestVersion = store.automation.releases()[0]?.version
  if (latestVersion !== undefined) currentVersions.add(latestVersion)
  const ids = new Set<string>()
  const collect = (conditions: ConditionSet) => {
    if ("all" in conditions) return
    for (const group of conditions.anyOf)
      for (const condition of group.allOf)
        if (condition.field === "list_id") for (const id of condition.value) ids.add(`list/${id}`)
  }
  for (const version of currentVersions) {
    const ruleSet = store.automation.release(version)
    for (const rule of ruleSet?.rules ?? []) {
      collect(rule.when)
      for (const action of rule.actions)
        if (action.type === "ai_aggregate" || action.type === "ai_dedupe") collect(action.scope)
    }
  }
  return [...ids].sort()
}
