import { mkdir, mkdtemp, rm } from "node:fs/promises"

import { compileInstructions, matchConditions, ruleSetSchema } from "@follow/information-core"
import { join } from "pathe"
import { z } from "zod"

import type { AIConfigStore } from "./ai-config"
import { runCodexJson } from "./codex"
import { processLongEntry } from "./processing-chunks"
import { processingRuleInput } from "./processing-context"
import type { ProcessingDecision } from "./processing-decision"
import {
  resolvedPolicy,
  resolvedStatus,
  runSingleEntryModel,
  sourceRole,
} from "./processing-engine"
import { sourceText } from "./service"
import type { Store } from "./store"

const requestSchema = z
  .object({
    sourceKey: z.string().min(1),
    entryId: z.string().min(1),
    config: ruleSetSchema,
  })
  .strict()

export class ProcessingTrialError extends Error {
  constructor(
    public readonly code:
      | "invalid_target"
      | "material_missing"
      | "stale_target"
      | "trial_busy"
      | "chunk_output_too_large",
  ) {
    super(code)
  }
}

function displayResult(
  decision: Pick<
    ProcessingDecision,
    "title" | "summary" | "status" | "reason" | "policy" | "facts"
  >,
) {
  const { title, summary, status, reason, policy, facts } = decision
  return { title, summary, status, reason, policy, facts }
}

// 试运行复用正式模型、分块、引用及策略解析；只写用量账本，不修改规则、队列或已发布结果。
export class ProcessingTrial {
  private running = false
  constructor(
    private readonly options: {
      store: Store
      aiConfig: AIConfigStore
      runtimeDir: string
      execute?: typeof runCodexJson
    },
  ) {}

  async run(body: unknown, signal: AbortSignal) {
    const request = requestSchema.parse(body)
    const { store } = this.options
    const ownerId = store.ownerId
    const input = store.automation.current(request.sourceKey, request.entryId)
    if (
      !ownerId ||
      request.config.ownerId !== ownerId ||
      !input ||
      !store.sources().some((source) => source.key === request.sourceKey)
    )
      throw new ProcessingTrialError("invalid_target")
    const text = sourceText(input.body.content ?? "")
    if (
      !text ||
      store.processingState.material(input) !== "complete" ||
      store.stories.isMaterialWithdrawn(input.seq)
    )
      throw new ProcessingTrialError("material_missing")
    if (this.running) throw new ProcessingTrialError("trial_busy")
    this.running = true
    let temporary: string | undefined
    try {
      const entry = store.entry(request.sourceKey, request.entryId) ?? input.body
      const context = processingRuleInput(store, request.sourceKey, entry, text, true)
      const metadataVersion = store.subscriptionTags.snapshot().revision
      const instructions = compileInstructions(request.config, context)
      const published = store.processingState.published()
      const before = published.find((item) => item.input.seq === input.seq)
      const ai = await this.options.aiConfig.read()
      const qianwen = await this.options.aiConfig.execution(ai.provider)
      const execute: typeof runCodexJson = (request) =>
        (this.options.execute ?? runCodexJson)({
          ...request,
          purpose: "preview",
          runtimeDir: this.options.runtimeDir,
        })
      const common = {
        entryId: input.itemId,
        text,
        instructions,
        sourceRole: sourceRole(store, context.source_id),
        historySince: store.schedule.snapshot().config?.historySince ?? input.body.publishedAt,
        model: ai.model,
        runtimeDir: this.options.runtimeDir,
        signal,
        qianwen,
        execute,
      }
      // 长文试运行的分块缓存单独存放，结束后删除，不覆盖正式执行的缓存。
      if (text.length > 60_000) {
        await mkdir(this.options.runtimeDir, { recursive: true, mode: 0o700 })
        temporary = await mkdtemp(join(this.options.runtimeDir, "trial-"))
      }
      const response = temporary
        ? await processLongEntry({ ...common, runtimeDir: temporary, provider: ai.provider })
        : await runSingleEntryModel(common)
      if ("status" in response && response.status === "pending")
        throw new ProcessingTrialError(response.reason)
      const current = store.automation.current(request.sourceKey, request.entryId)
      // 模型返回前账号、正文或标签已变化时丢弃结果，不能展示旧授权范围的试运行。
      if (
        signal.aborted ||
        store.ownerId !== ownerId ||
        current?.seq !== input.seq ||
        store.stories.isMaterialWithdrawn(input.seq) ||
        store.subscriptionTags.snapshot().revision !== metadataVersion
      )
        throw new ProcessingTrialError("stale_target")
      const output = response.output
      const after = displayResult({
        ...output,
        status: resolvedStatus(instructions, output),
        policy: resolvedPolicy(instructions, output, text.length > 60_000),
      })
      const aggregation = instructions.aggregates.map((rule) => {
        const candidates =
          after.policy.aggregation === "deny" ||
          matchConditions(rule.scope, context).state !== "match"
            ? []
            : published.filter(
                (item) =>
                  item.input.seq !== input.seq &&
                  item.decision.policy.aggregation !== "deny" &&
                  item.decision.status !== "needs_context" &&
                  !store.stories.isMaterialWithdrawn(item.input.seq) &&
                  matchConditions(rule.scope, item.decision.context).state === "match",
              )
        return {
          ruleId: rule.ruleId,
          mode: rule.mode,
          count: candidates.length,
          candidates: candidates.slice(0, 50).map((item) => ({
            inputSeq: item.input.seq,
            title: item.decision.title,
            sourceKey: item.input.sourceKey,
            entryId: item.input.itemId,
          })),
        }
      })
      return {
        entryId: input.itemId,
        sourceKey: input.sourceKey,
        original: { title: input.body.title ?? input.itemId, text },
        before: before ? displayResult(before.decision) : null,
        beforeReleaseVersion: before?.input.releaseVersion ?? null,
        after,
        model: ai.model,
        usage: response.usage,
        aggregation,
      }
    } finally {
      this.running = false
      if (temporary) await rm(temporary, { recursive: true, force: true })
    }
  }
}
