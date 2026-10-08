import type { RuleSet, TagAssessment } from "@follow/information-core"
import {
  compileInstructions,
  matchConditions,
  semanticTagDefinitions,
} from "@follow/information-core"
import { z } from "zod"

import { AutomationError } from "./automation-store"
import type { PublishedDecision } from "./processing-decision"
import { applyOverride } from "./processing-engine"
import { projectSemanticDecision } from "./processing-semantic-decision"
import { semanticOverrideSchema, semanticQuerySchema } from "./processing-semantic-store"
import type { Store } from "./store"

const positiveInteger = z.number().int().positive()
export const semanticRecomputeSchema = z
  .object({
    ruleReleaseVersion: positiveInteger,
    targets: z
      .array(
        z
          .object({
            inputSeq: positiveInteger,
            expectedContentVersion: z.string().min(1),
            expectedDecisionId: z.string().min(1),
            expectedGeneration: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .refine(
    (request) =>
      new Set(request.targets.map((target) => target.inputSeq)).size === request.targets.length,
    "duplicate_recompute_target",
  )

function requireInput(store: Store, inputSeq: number) {
  const input = store.automation.inputs([inputSeq]).find((item) => item.current)
  if (
    !input ||
    !store
      .sources()
      .some((source) => source.key === input.sourceKey && source.origin !== "generated") ||
    input.sourceKey.startsWith("generated:") ||
    store.stories.isMaterialWithdrawn(inputSeq)
  )
    throw new AutomationError("invalid_target")
  return input
}

function requirePublished(store: Store, inputSeq: number) {
  const input = requireInput(store, inputSeq)
  const published = store.processingState.published([inputSeq])[0]
  if (
    !published ||
    !published.decision.semantic ||
    !published.decision.semanticProfile ||
    published.decision.semanticProfile.contentVersion !== input.contentVersion ||
    input.releaseVersion === null
  )
    throw new AutomationError("invalid_target")
  return published
}

function projectWithoutModel(
  store: Store,
  published: PublishedDecision,
  config: RuleSet,
  assessments: TagAssessment[],
  correction: boolean,
) {
  const original = published.decision
  const oldConfig = store.automation.release(published.input.releaseVersion!)
  if (!oldConfig) throw new AutomationError("invalid_target")
  const context = { ...original.context, entry_tag: assessments }
  const previous = compileInstructions(oldConfig, original.context)
  const next = compileInstructions(config, context)
  const baseInstructions = compileInstructions(oldConfig, {
    ...original.context,
    entry_tag: undefined,
  })
  const prompts = (instructions: ReturnType<typeof compileInstructions>) =>
    JSON.stringify(instructions.transformations.map((item) => item.prompt))
  const baseMatches = prompts(next) === prompts(baseInstructions)
  const analysisFingerprint = original.analysisFingerprint
  const canKeepGenerated =
    prompts(previous) === prompts(next) &&
    (!analysisFingerprint || original.fingerprint !== analysisFingerprint || baseMatches)
  if (
    !correction &&
    ((!canKeepGenerated && !baseMatches) ||
      previous.global.markdown !== next.global.markdown ||
      previous.display.language !== next.display.language)
  )
    throw new AutomationError("invalid_target")
  let decision = original
  let restored = false
  if (!canKeepGenerated && analysisFingerprint) {
    const cached =
      store.processingState.cache(analysisFingerprint) ??
      (original.fingerprint === analysisFingerprint ? original : null)
    if (cached?.semantic) {
      // 基础缓存可能来自同正文的其他条目；版本、身份和不可变画像绑定回当前目标。
      decision = {
        ...cached,
        analysisFingerprint,
        schemaVersion: 2,
        context: original.context,
        sourceRole: original.sourceRole,
        semanticProfile: original.semanticProfile,
        semantic: {
          ...cached.semantic,
          entryId: published.input.itemId,
          tagAssessments: original.semanticProfile?.assessments,
        },
        reused: true,
      }
      restored = true
    }
  }
  const needsTransform =
    !canKeepGenerated && (!baseMatches || (analysisFingerprint !== undefined && !restored))
  if (!correction && needsTransform) throw new AutomationError("invalid_target")
  const projected = projectSemanticDecision(decision, config, original.context, assessments)
  if (!needsTransform) return projected
  // 纠错成功但新增变换尚未执行：保留基础摘要和有效标签，独立可见且暂不参与综述。
  return {
    ...projected,
    analysisFingerprint: analysisFingerprint ?? decision.fingerprint,
    status: "needs_context" as const,
    title: restored || !analysisFingerprint ? projected.title : published.input.body.title,
    summary: restored || !analysisFingerprint ? projected.summary : "",
    reason: "语义标签已纠正；新的内容变换尚未执行，请明确重新处理此文章。",
    policy: {
      standalone: "always" as const,
      aggregation: "deny" as const,
      rewrite: "deny" as const,
    },
  }
}

export function processingSemanticApi(
  store: Store,
  method: string,
  path: string,
  body: unknown,
): object | undefined {
  const entryPath = /^\/processing\/entries\/(\d+)\/(semantics|semantic-overrides)$/.exec(path)
  const definitionsRoute = path === "/processing/semantic-tags" && method === "GET"
  const queryRoute = path === "/processing/semantics/query" && method === "POST"
  const recomputeRoute = path === "/processing/recompute-decisions" && method === "POST"
  const entryRoute =
    entryPath &&
    ((entryPath[2] === "semantics" && method === "GET") ||
      (entryPath[2] === "semantic-overrides" && method === "POST"))
  if (!definitionsRoute && !queryRoute && !recomputeRoute && !entryRoute) return undefined
  if (!store.ownerId) throw new AutomationError("owner_required")

  if (definitionsRoute) return { definitions: semanticTagDefinitions }
  if (queryRoute) {
    const request = semanticQuerySchema.parse(body)
    const availableSources = new Set(
      store
        .sources()
        .filter((source) => source.origin !== "generated" && !source.key.startsWith("generated:"))
        .map((source) => source.key),
    )
    // 撤回材料在冻结查询、计数和分页之前排除，快照不得保留已失效的证据入口。
    const excludedInputSeqs = new Set(
      store.automation
        .inputs()
        .filter((input) => store.stories.isMaterialWithdrawn(input.seq))
        .map((input) => input.seq),
    )
    return store.semantics.query(request, availableSources, excludedInputSeqs)
  }
  if (entryRoute && entryPath) {
    const inputSeq = positiveInteger.parse(Number(entryPath[1]))
    const input = requireInput(store, inputSeq)
    if (entryPath[2] === "semantics") return store.semantics.view(input)
    const request = semanticOverrideSchema.parse(body)
    requirePublished(store, inputSeq)
    return store.semantics.correct(input, request, () => {
      // 使用文章执行时的发布版，不把后续草稿或新发布规则混入单字段纠错。
      const published = requirePublished(store, inputSeq)
      const config = store.automation.release(published.input.releaseVersion!)
      if (!config) throw new AutomationError("invalid_target")
      const projected = projectWithoutModel(
        store,
        published,
        config,
        store.semantics.assessments(published.input, published.decision.semanticProfile),
        true,
      )
      const mode =
        store.processingState.overrides().find((item) => item.inputSeq === inputSeq)?.mode ??
        "automatic"
      const decision = applyOverride(projected, mode)
      const result = store.automation.recalculate(published.input, decision)
      if (!result.published) throw new AutomationError("revision_conflict")
      store.semantics.index(result.input, decision, result.id)
      store.stories.invalidateInputs([inputSeq])
    })
  }
  if (recomputeRoute) {
    const request = semanticRecomputeSchema.parse(body)
    const effective = store.automation.effective()
    if (effective.releaseVersion !== request.ruleReleaseVersion || !effective.config)
      throw new AutomationError("revision_conflict")
    const config = effective.config
    let response: object | undefined
    store.transaction(() => {
      const targets = request.targets.map((target) => {
        const published = requirePublished(store, target.inputSeq)
        if (
          published.input.contentVersion !== target.expectedContentVersion ||
          published.decisionId !== target.expectedDecisionId ||
          published.input.generation !== target.expectedGeneration
        )
          throw new AutomationError("revision_conflict")
        // 明确选中的既有画像仍须在新发布规则范围内；未知标签不提前视为不匹配。
        const inScope = config.rules.some(
          (rule) =>
            rule.enabled &&
            rule.executionLocation === "processing_service" &&
            matchConditions(rule.when, { ...published.decision.context, entry_tag: null }).state !==
              "no_match",
        )
        if (!inScope) throw new AutomationError("invalid_target")
        // 先验证全部目标的实际 Prompt，整批不允许混入需要新模型调用的变更。
        projectWithoutModel(
          store,
          published,
          config,
          store.semantics.assessments(published.input, published.decision.semanticProfile),
          false,
        )
        return published
      })
      const decisions = targets.map((published) => {
        const projected = projectWithoutModel(
          store,
          published,
          config,
          store.semantics.assessments(published.input, published.decision.semanticProfile),
          false,
        )
        const mode =
          store.processingState.overrides().find((item) => item.inputSeq === published.input.seq)
            ?.mode ?? "automatic"
        const decision = applyOverride(projected, mode)
        const result = store.automation.recalculate(
          published.input,
          decision,
          request.ruleReleaseVersion,
        )
        if (!result.published) throw new AutomationError("revision_conflict")
        store.semantics.index(result.input, decision, result.id)
        return {
          inputSeq: result.input.seq,
          decisionId: result.id,
          generation: result.input.generation,
          releaseVersion: result.input.releaseVersion,
        }
      })
      store.stories.invalidateInputs(targets.map((target) => target.input.seq))
      response = { decisions, modelCalls: 0 }
    })
    return response
  }
  return undefined
}
