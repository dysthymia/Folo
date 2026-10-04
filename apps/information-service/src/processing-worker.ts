import type { ConditionSet } from "@follow/information-core"

import type { AIConfigStore } from "./ai-config"
import { expandXContexts } from "./content-identity"
import type { FoloReader } from "./folo"
import { inspectMaterialContext, missingMaterialContext } from "./material-context"
import { runSemanticDedupe } from "./processing-dedupe"
import type { EntryProcessingResult } from "./processing-engine"
import { runEntryProcessing, settleReadStates } from "./processing-engine"
import { fairProcessingBatches } from "./processing-priority"
import { resolveAIRuleSourceKeys, runnableReleasedConfig } from "./processing-rule-scope"
import type { ProcessingTriggerStatus } from "./processing-schedule"
import { acquireSources, refreshSourceSnapshot } from "./processing-source-sync"
import { errorCode, sourceText } from "./service"
import type { Store } from "./store"
import { runStoryAggregation } from "./story-engine"
import { runStoryRepair } from "./story-repair"

// 空闲轮询每秒运行，但订阅发现按分钟刷新；待处理的显式批次仍立即刷新。
const inventoryRefreshTimes = new WeakMap<Store, number>()

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
  if (!store.schedule.snapshot().config || !store.automation.releases().length) return null
  // 零匹配也必须先发现新增订阅，不能被旧规则范围提前截断。
  const now = Date.now()
  const hasPendingTrigger = store.schedule
    .triggers()
    .some((trigger) => trigger.status === "pending")
  if (!hasPendingTrigger && now - (inventoryRefreshTimes.get(store) ?? 0) < 60_000) return null
  inventoryRefreshTimes.set(store, now)
  const inventory = await refreshSourceSnapshot(store, options.reader, signal)
  const ruleSources =
    store.schedule.snapshot().config?.scope.mode === "rules" ? resolveAIRuleSourceKeys(store) : null
  // 规则停用或暂时没有匹配来源时，旧队列也不能重新触发模型。
  if (ruleSources?.length === 0) return null
  store.schedule.tick(new Date())
  if (!store.automation.releases().length) return null
  const trigger = store.schedule.claim(new Date(), 30 * 60_000)
  if (!trigger?.leaseToken) return null
  if (ruleSources)
    trigger.sourceKeys = trigger.sourceKeys.filter((key) => ruleSources.includes(key))
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
            inventory,
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
    const pendingBeforeRead = new Set(
      store.automation
        .inputs()
        .filter(
          (input) =>
            input.status === "pending" &&
            trigger.sourceKeys.includes(input.sourceKey) &&
            Date.parse(input.body.publishedAt) >= Date.parse(trigger.historySince) &&
            Date.parse(input.body.publishedAt) <= Date.parse(trigger.cutoffAt),
        )
        .map((input) => input.seq),
    )
    const readSettlement = settleReadStates(store)
    const readSkipped = readSettlement.skip.filter((seq) => pendingBeforeRead.has(seq)).length
    const hydrationInputs = store.automation
      .inputs()
      .filter(
        (input) =>
          trigger.sourceKeys.includes(input.sourceKey) &&
          input.status === "pending" &&
          Date.parse(input.body.publishedAt) >= Date.parse(trigger.historySince) &&
          Date.parse(input.body.publishedAt) <= Date.parse(trigger.cutoffAt),
      )
    // 水合与模型共用公平批次，第2位保留最早普通材料，不按最新发布时间反复挤掉积压。
    const batches = fairProcessingBatches(hydrationInputs).map((batch) =>
      batch.map((input) => input.seq),
    )
    if (!batches.length) batches.push([])
    const material = { complete: 0, missing: 0, failed: 0 }
    let entries: EntryProcessingResult = {
      completed: 0,
      pending: 0,
      failures: [],
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    }
    // 紧迫条目优先按小批补读并正式发布，不等待所有普通材料串行水合完成。
    for (const batch of batches) {
      if (signal.aborted) break
      const hydrated = await hydrateMaterials(
        options,
        trigger.sourceKeys,
        trigger.historySince,
        trigger.cutoffAt,
        signal,
        batch,
      )
      material.complete += hydrated.complete
      material.missing += hydrated.missing
      material.failed += hydrated.failed
      const result = await (options.processEntries ?? runEntryProcessing)({
        store,
        aiConfig: options.aiConfig,
        runtimeDir: options.runtimeDir,
        sourceKeys: trigger.sourceKeys,
        inputSeqs: batch.length ? hydrated.inputSeqs : undefined,
        historySince: trigger.historySince,
        cutoffAt: trigger.cutoffAt,
        signal,
        onProgress: (progress) => {
          const combined = mergeEntryResults(entries, progress)
          if (combined.metrics) {
            combined.metrics.readSkipped += readSkipped
            combined.metrics.budgetDeferred += sources.filter(
              (source) => source.coverage === "budget",
            ).length
          }
          store.processingState.report(trigger.id, {
            inventory: {
              snapshot: inventory.snapshot,
              failure: inventory.failure,
              syncedAt: inventory.syncedAt,
            },
            sources,
            material: { ...material },
            entries: combined,
            phase: "entries",
            progressAt: new Date().toISOString(),
          })
        },
      })
      entries = mergeEntryResults(entries, result)
    }
    if (entries.metrics) {
      // 已读跳过与来源分页预算分别计数，不混入模型失败或噪声统计。
      entries.metrics.readSkipped += readSkipped
      entries.metrics.budgetDeferred += sources.filter(
        (source) => source.coverage === "budget",
      ).length
    }
    // 每个已发布版本按自己的综合指令执行，不能把新草稿混进旧版本决策。
    const decisions = store.processingState.published()
    const releasedRuleSets = store.automation.releases().map((release) => ({
      version: release.version,
      config: runnableReleasedConfig(
        store.automation.release(release.version)!,
        store.automation.effective().config,
      ),
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
      const publishedRuleSet = version === null ? null : store.automation.release(version)
      if (!publishedRuleSet) continue
      const ruleSet = runnableReleasedConfig(publishedRuleSet, store.automation.effective().config)
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
      inventory.failure !== null ||
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
        : material.missing > 0
          ? "needs_context"
          : pending
            ? "deferred_budget"
            : "succeeded"
    store.processingState.report(trigger.id, {
      inventory: {
        snapshot: inventory.snapshot,
        failure: inventory.failure,
        syncedAt: inventory.syncedAt,
      },
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
  inputSeqs?: readonly number[],
) {
  const { store } = options
  const sources = new Map(store.sources().map((source) => [source.key, source]))
  const selected = new Set(sourceKeys)
  const inputs = store.automation
    .inputs()
    .filter(
      (input) =>
        selected.has(input.sourceKey) &&
        (inputSeqs === undefined || inputSeqs.includes(input.seq)) &&
        input.status === "pending" &&
        Date.parse(input.body.publishedAt) >= Date.parse(historySince) &&
        Date.parse(input.body.publishedAt) <= Date.parse(cutoffAt),
    )
  // 显式批次保持上游顺序，不能在补正文后重新按紧迫程度覆盖普通项的保底位置。
  const orderedInputs = inputSeqs
    ? inputs.sort((left, right) => inputSeqs.indexOf(left.seq) - inputSeqs.indexOf(right.seq))
    : fairProcessingBatches(inputs).flat()
  const currentSeqs = new Set(orderedInputs.map((input) => input.seq))
  let complete = 0
  let missing = 0
  let failed = 0
  let reader: FoloReader | undefined
  for (const input of orderedInputs) {
    signal.throwIfAborted()
    // 待补材料允许下一轮有限重试；完整材料无需再次抓取。
    if (store.processingState.material(input) === "complete") continue
    const source = sources.get(input.sourceKey)
    if (!source) continue
    if (source.kind === "x_search") {
      const state = missingMaterialContext(input.body).length ? "missing" : "complete"
      store.processingState.setMaterial(input, state)
      if (state === "complete") complete++
      else missing++
      continue
    }
    try {
      reader ??= await options.reader()
      let entry = await reader.detail(source, input.body, { signal, includeLinkedMaterials: false })
      if (
        source.kind !== "inbox" &&
        (!sourceText(entry.content ?? "") || missingMaterialContext(entry).includes("text"))
      )
        entry.content = await reader.readability(entry.id)
      entry = await reader.hydrateLinkedMaterials(entry, signal)
      // 详情与正文提取完成后核验实际嵌入材料；只保存有正文依据的 complete。
      const inspection = inspectMaterialContext(entry)
      if (Object.keys(inspection.verified).length)
        entry.context = { ...entry.context, ...inspection.verified }
      store.saveEntry(entry)
      const current = store.automation.current(entry.sourceKey, entry.id)!
      currentSeqs.delete(input.seq)
      currentSeqs.add(current.seq)
      const state = missingMaterialContext(entry).length ? "missing" : "complete"
      store.processingState.setMaterial(current, state)
      if (current.seq !== input.seq) store.stories.invalidateInputs([input.seq])
      if (state === "complete") complete++
      else missing++
    } catch {
      store.processingState.setMaterial(input, "failed")
      failed++
    }
  }
  return { complete, missing, failed, inputSeqs: [...currentSeqs] }
}

// 各水合小批只处理自己的当前输入版本；累计调用/用量而不复算此前发布的条目。
function mergeEntryResults(
  left: EntryProcessingResult,
  right: EntryProcessingResult,
): EntryProcessingResult {
  const metrics = right.metrics
    ? { ...right.metrics }
    : left.metrics
      ? { ...left.metrics }
      : undefined
  if (metrics && left.metrics && right.metrics) {
    for (const key of Object.keys(metrics) as Array<keyof typeof metrics>)
      metrics[key] = left.metrics[key] + right.metrics[key]
  }
  return {
    completed: left.completed + right.completed,
    pending: left.pending + right.pending,
    failures: [...left.failures, ...right.failures],
    metrics,
    usage: {
      inputTokens: left.usage.inputTokens + right.usage.inputTokens,
      outputTokens: left.usage.outputTokens + right.usage.outputTokens,
      cachedInputTokens: left.usage.cachedInputTokens + right.usage.cachedInputTokens,
    },
  }
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
