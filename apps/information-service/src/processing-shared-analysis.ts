import { createHash } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"

import type { RuleInput, RuleSet } from "@follow/information-core"
import { compileInstructions, matchConditions } from "@follow/information-core"
import { join } from "pathe"
import { z } from "zod"

import type { AIConfigStore, AIProvider } from "./ai-config"
import type { ProcessingInput } from "./automation-store"
import type { CodexJsonOptions, CodexUsage } from "./codex"
import { CodexRunError, runCodexJson } from "./codex"
import type { PreparedDedupeEvaluation } from "./processing-dedupe"
import { exactDuplicateDecisions, prepareSemanticDedupe } from "./processing-dedupe"
import type { EvidenceCatalog } from "./processing-evidence"
import { runnableReleasedConfig } from "./processing-rule-scope"
import type { SemanticDuplicateCandidate } from "./semantic-dedupe"
import {
  createSemanticDuplicatePrompt,
  normalizeSemanticDuplicateOutput,
  semanticDuplicateEvaluationStatus,
  semanticDuplicateEvaluationStatuses,
  semanticDuplicateOutputSchema,
} from "./semantic-dedupe"
import type { Store } from "./store"
import type { SharedStoryGroup } from "./story-engine"
import { sharedStoryRuleFingerprint, storyModelOutputSchema } from "./story-engine"

export type SharedEntryMaterial = {
  input: ProcessingInput
  text: string
  context: RuleInput
  evidence: EvidenceCatalog
  // 策略和模型来源随目标冻结，不能在模型运行中途混入刚编辑的新设置。
  policy?: ReturnType<typeof compileInstructions>["policy"]
  provider?: AIProvider
}
type InputIdentity = PreparedDedupeEvaluation["inputs"][number]
type SharedEnvelope<T> = {
  entry: T
  dedupe: unknown
  stories: unknown
}
const sharedStoriesSchema = z
  .array(z.object({ ruleId: z.string().min(1), output: storyModelOutputSchema }).strict())
  .max(20)
const identitySchema = z
  .object({
    seq: z.number().int().positive(),
    generation: z.number().int().nonnegative(),
    contentVersion: z.string().min(1),
    sourceKey: z.string().min(1),
    itemId: z.string().min(1),
  })
  .strict()
// 缓存也按完整契约读取，损坏文件只能失去复用资格，不能穿透到角色或引用投影。
const cachedDedupeSchema = z
  .object({
    configFingerprint: z.string().min(1),
    pairKey: z.string().min(1),
    model: z.string().min(1),
    provider: z.string().min(1),
    inputs: z.array(identitySchema).length(2),
    evaluation: z
      .object({
        pairKey: z.string().min(1),
        duplicate: z.boolean(),
        confidence: z.number().min(0).max(1),
        keepEntryId: z.string().nullable(),
        hideEntryId: z.string().nullable(),
        reason: z.string().nullable(),
        status: z.enum(semanticDuplicateEvaluationStatuses).optional(),
        verdict: z
          .enum([
            "equivalent",
            "first_contains_second",
            "second_contains_first",
            "different",
            "uncertain",
          ])
          .optional(),
      })
      .strict(),
  })
  .strict()
const cachedStorySchema = z
  .object({
    ruleId: z.string().min(1),
    ruleFingerprint: z.string().min(1),
    inputSeqs: z.array(z.number().int().positive()).min(1).max(20),
    inputs: z.array(identitySchema).min(1).max(20),
    evidenceCatalogs: z
      .array(
        z
          .object({
            inputSeq: z.number().int().positive(),
            fragments: z
              .array(z.object({ evidenceId: z.string().min(1), quote: z.string().min(1) }).strict())
              .max(1000),
          })
          .strict(),
      )
      .max(20),
    output: storyModelOutputSchema,
  })
  .strict()
// 高推理强度下，正文长度不足以衡量联合任务；同时限制目标、参考、比较和动态契约。
const MAX_SHARED_TARGETS = 4
const MAX_SHARED_DOCUMENTS = 6
const MAX_SHARED_PAIRS = 4
const MAX_SHARED_REFERENCE_CHARS = 12_000
const MAX_SHARED_PROMPT_CHARS = 40_000
const MAX_SHARED_SCHEMA_CHARS = 16_000
const identity = (input: ProcessingInput): InputIdentity => ({
  seq: input.seq,
  generation: input.generation,
  contentVersion: input.contentVersion,
  sourceKey: input.sourceKey,
  itemId: input.itemId,
})
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// 每个任务持有同一份分析计划；输入快照随派生结果保存，后续规则不能消费换代前的材料。
export class SharedAnalysisSession {
  readonly dedupeEvaluations: PreparedDedupeEvaluation[] = []
  readonly storyGroups: SharedStoryGroup[] = []
  // 共享调用计费归单篇；此处只报告参与去重的请求总用量，不能与单篇再次相加。
  readonly dedupeCosts = {
    requests: 0,
    pairs: 0,
    unknownUsageRequests: 0,
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
  }

  constructor(
    private readonly options: {
      store: Store
      aiConfig: AIConfigStore
      runtimeDir: string
      sourceKeys: string[]
      cutoffAt: string
      triggerId?: string
    },
  ) {}

  async execute<T>(
    request: CodexJsonOptions<T>,
    materials: SharedEntryMaterial[],
    execute: typeof runCodexJson = runCodexJson,
  ) {
    const { store } = this.options
    const materialIds = new Set(materials.map((item) => item.input.itemId))
    const executeEntry = () =>
      execute({
        ...request,
        telemetry: {
          ...request.telemetry,
          triggerId: this.options.triggerId,
          tasks: ["entry"],
          uniqueDocumentCount: materialIds.size,
          pairCount: 0,
        },
      })
    // 超预算的派生任务交给后续去重/综述阶段；原文和单篇事实保持完整，不截断材料。
    if (materialIds.size > MAX_SHARED_TARGETS) return executeEntry()
    const plans = prepareSemanticDedupe({
      store,
      sourceKeys: this.options.sourceKeys,
      cutoffAt: this.options.cutoffAt,
      targets: materials.map(({ input }) => input),
      pendingInputs: materials.map(({ input }) => input),
    })
    const references = new Map<string, SemanticDuplicateCandidate["entries"][number]>()
    const pairs: SemanticDuplicateCandidate[] = []
    // 候选正文只在共享目录出现一次；额外参考材料也有单独的字符与候选数预算。
    let referenceChars = 0
    for (const plan of plans) {
      // 严格同文直接交给本地关系层，统一模型也不为可确定的比较重复付费。
      const exactPairs = new Set(
        exactDuplicateDecisions(plan.participants).map((item) => item.candidate.pairKey),
      )
      for (const candidate of plan.candidates) {
        if (exactPairs.has(candidate.pairKey) || store.dedupe.relation(candidate)) continue
        if (pairs.some((item) => item.pairKey === candidate.pairKey)) continue
        if (pairs.length >= MAX_SHARED_PAIRS) break
        if (!candidate.entries.every((item) => item.contentComplete && item.content?.trim()))
          continue
        const additions = candidate.entries.filter(
          (item) => !materialIds.has(item.itemId) && !references.has(item.itemId),
        )
        if (materialIds.size + references.size + additions.length > MAX_SHARED_DOCUMENTS) continue
        const addedChars = additions.reduce((sum, item) => sum + (item.content?.length ?? 0), 0)
        if (referenceChars + addedChars > MAX_SHARED_REFERENCE_CHARS) continue
        referenceChars += addedChars
        for (const item of additions) references.set(item.itemId, item)
        pairs.push(candidate)
      }
    }
    // 综述输出也占执行时间；只在小批次共享一条规则，其余使用后续已提取的事实生成。
    const storyPlans =
      materials.length <= 3 && pairs.length <= 3 ? this.storyPlans(materials).slice(0, 1) : []
    if (!pairs.length && !storyPlans.length) return executeEntry()
    // 模型约束只使用根目录 $defs 引用；把单篇定义提升并加命名空间，避免嵌套引用被拒绝。
    const { $defs, ...entrySchema } = request.schema as Record<string, unknown>
    const entryDefinitions =
      typeof $defs === "object" && $defs !== null && !Array.isArray($defs)
        ? ($defs as Record<string, unknown>)
        : {}
    const qualifyEntryReferences = (schema: unknown): unknown =>
      JSON.parse(
        JSON.stringify(schema, (key, value: unknown) =>
          key === "$ref" && typeof value === "string" && value.startsWith("#/$defs/")
            ? `#/$defs/entry_${value.slice("#/$defs/".length)}`
            : value,
        ),
      )
    const envelopeSchema = {
      type: "object",
      properties: {
        entry: qualifyEntryReferences(entrySchema),
        // 输出容量也按本次实际任务收紧，避免模型生成未请求的比较或多余综述。
        dedupe: z.toJSONSchema(
          semanticDuplicateOutputSchema.extend({
            results: semanticDuplicateOutputSchema.shape.results.max(pairs.length),
          }),
        ),
        stories: z.toJSONSchema(sharedStoriesSchema.max(storyPlans.length)),
      },
      required: ["entry", "dedupe", "stories"],
      additionalProperties: false,
      ...(Object.keys(entryDefinitions).length
        ? {
            $defs: Object.fromEntries(
              Object.entries(entryDefinitions).map(([name, schema]) => [
                `entry_${name}`,
                qualifyEntryReferences(schema),
              ]),
            ),
          }
        : {}),
    }
    if (JSON.stringify(envelopeSchema).length > MAX_SHARED_SCHEMA_CHARS) return executeEntry()
    const comparisonRules = createSemanticDuplicatePrompt([]).split("\n候选（")[0]
    const prompt = `${request.prompt}

同时执行以下已命中的规则。标题、正文及证据目录已在上面的单篇材料中出现，不要重复提取。
必须返回 {entry: 原单篇响应, dedupe: {results: [...]}, stories: [{ruleId, output: {groups: [...]}}]}。
单篇 entry 仍遵守原 schema。去重、综述均不得改变原文；先确定事实覆盖关系，再用保留条目生成新综述。
${pairs.length ? comparisonRules : "没有去重候选，dedupe.results 返回空数组。"}
去重候选（entries 的完整正文通过 itemId 查上面的证据目录或下面的只读参考）：
${JSON.stringify(
  pairs.map((pair) => ({
    ...pair,
    entries: pair.entries.map(({ content: _content, ...metadata }) => metadata),
  })),
)}
只读参考（已有缓存，不是新的处理目标）：${JSON.stringify([...references.values()])}
当前条目身份：${JSON.stringify(
      materials.map(({ input, policy }) => ({
        inputSeq: input.seq,
        itemId: input.itemId,
        title: input.body.title,
        policy,
      })),
    )}
新综述规则：${JSON.stringify(
      storyPlans.map((plan) => ({
        ruleId: plan.rule.id,
        inputSeqs: plan.materials.map((item) => item.input.seq),
        actions: plan.rule.actions.filter((action) => action.type === "ai_aggregate"),
      })),
    )}
综述只引用本规则范围内、单篇 facts 已选择的证据编号，sources 返回 inputSeq 和原证据目录 evidenceId。
真实事件的主体、动作、版本、轮次或日期不能混淆，观点和教程保持独立。同一事实只写一次，互相补充的信息保留，冲突按来源分别陈述。
每个新 group 必须引用至少两个去重后仍保留的不同 inputSeq；不要仅为已读参考生成综述。
若单篇 entry 的 rewrite=false，且没有显式 rewrite=allow 策略，或其 disposition=hide，则引用它的每一句 sentence.text、对应 fact.text 都必须逐字等于该 evidenceId 的原文，不能增加空格、补充主语或改写措辞。一条句子引用多项禁止改写证据时必须逐字等于所有这些原文，否则拆成独立引用句。aggregation=false 且没有显式 aggregation=allow 的条目不进入综述。
禁止改写的材料只能逐字引用。existingStoryId=null，retainedSentenceIds=[]，retainedFactIds=[]。
sentences 必须拼成 body，facts.sentenceIndexes 从0开始，inference 必须有事实依赖。没有可创建的综述就返回该规则的 groups=[]。
已有同事件综述的更新由后续使用已提取事实推进；这里仅生成新事件草稿。
`
    // 长文及复杂上下文仍走已有分块/事实综合路径，不能截断正文后声称完成统一判重。
    if (prompt.length > MAX_SHARED_PROMPT_CHARS) return executeEntry()
    const recordUsage = (usage: CodexUsage | null) => {
      if (!pairs.length) return
      this.dedupeCosts.requests++
      this.dedupeCosts.pairs += pairs.length
      if (usage) {
        this.dedupeCosts.usage.inputTokens += usage.inputTokens
        this.dedupeCosts.usage.outputTokens += usage.outputTokens
        this.dedupeCosts.usage.cachedInputTokens += usage.cachedInputTokens
      } else this.dedupeCosts.unknownUsageRequests++
    }
    const response = await execute<SharedEnvelope<T>>({
      ...request,
      prompt,
      schema: envelopeSchema,
      telemetry: {
        triggerId: this.options.triggerId,
        tasks: [
          "entry",
          ...(pairs.length ? ["dedupe" as const] : []),
          ...(storyPlans.length ? ["story" as const] : []),
        ],
        uniqueDocumentCount: new Set([...materialIds, ...references.keys()]).size,
        pairCount: pairs.length,
      },
      // 逐项校验派生结果，损坏的去重或综述不能连带丢弃有效单篇结果。
      validate: (value): value is SharedEnvelope<T> =>
        record(value) && request.validate(value.entry) && "dedupe" in value && "stories" in value,
    }).catch((error: unknown) => {
      // 失败也可能消耗用量；没有计数时保持未知，不从单篇合计中伪造分摊。
      recordUsage(error instanceof CodexRunError ? error.usage : null)
      throw error
    })
    recordUsage(response.usage)
    const provider = materials[0]?.provider ?? (await this.options.aiConfig.read()).provider
    const dedupe = semanticDuplicateOutputSchema.safeParse(response.result.dedupe)
    const evaluations = dedupe.success
      ? normalizeSemanticDuplicateOutput(pairs, dedupe.data)
      : normalizeSemanticDuplicateOutput(pairs, { results: [] }).map((evaluation) => ({
          ...evaluation,
          status: "invalid_result" as const,
          reason: "共享去重输出无效，保留原文。",
        }))
    const savedDedupe: PreparedDedupeEvaluation[] = []
    for (const plan of plans) {
      for (const evaluation of evaluations) {
        const candidate = plan.candidates.find((item) => item.pairKey === evaluation.pairKey)
        if (!candidate) continue
        const inputs = candidate.entries.map(
          (entry) => plan.participants.find((item) => item.input.itemId === entry.itemId)?.input,
        )
        if (inputs.some((input) => !input)) continue
        savedDedupe.push({
          configFingerprint: plan.action.fingerprint,
          pairKey: candidate.pairKey,
          evaluation,
          model: request.model,
          provider,
          inputs: inputs.map((input) => identity(input!)),
        })
      }
    }
    const parsedStories = sharedStoriesSchema.safeParse(response.result.stories)
    const savedStories: SharedStoryGroup[] = []
    if (parsedStories.success) {
      for (const plan of storyPlans) {
        const outputs = parsedStories.data.filter((item) => item.ruleId === plan.rule.id)
        if (outputs.length !== 1) continue
        const output = outputs[0]!.output
        // 保存整次规则请求的覆盖范围；事件拆批或去重后仍能证明哪些材料已分析。
        savedStories.push({
          ruleId: plan.rule.id,
          ruleFingerprint: sharedStoryRuleFingerprint(plan.rule, plan.config.global),
          inputSeqs: plan.materials.map((item) => item.input.seq),
          inputs: plan.materials.map((item) => identity(item.input)),
          evidenceCatalogs: plan.materials.map((item) => ({
            inputSeq: item.input.seq,
            fragments: item.evidence.fragments,
          })),
          output,
        })
      }
    }
    this.dedupeEvaluations.push(...savedDedupe)
    this.storyGroups.push(...savedStories)
    await this.persist(
      materials.map((item) => item.input),
      // 本批异常写入关系库的冷却和次数限制，但不能跨任务复用成新的模型结果。
      savedDedupe.filter((item) =>
        ["decided", "uncertain"].includes(item.evaluation.status ?? "decided"),
      ),
      savedStories,
    )
    return { ...response, result: response.result.entry }
  }

  private storyPlans(materials: SharedEntryMaterial[]) {
    const grouped = new Map<
      string,
      { rule: RuleSet["rules"][number]; config: RuleSet; materials: SharedEntryMaterial[] }
    >()
    for (const material of materials) {
      const version = material.input.releaseVersion
      const release = version === null ? null : this.options.store.automation.release(version)
      if (!release) continue
      const config = runnableReleasedConfig(
        release,
        this.options.store.automation.effective().config,
        material.context,
      )
      const instructions = compileInstructions(config, material.context)
      if (instructions.blocksFinalPresentation || instructions.policy.aggregation === "deny")
        continue
      for (const rule of config.rules.filter((rule) => rule.enabled)) {
        if (matchConditions(rule.when, material.context).state !== "match") continue
        const actions = rule.actions.filter(
          (action) =>
            action.type === "ai_aggregate" &&
            matchConditions(action.scope, material.context).state === "match",
        )
        if (!actions.length) continue
        // 既有事件的更新保留身份与 CAS，由已经验证的事实驱动更新模型。
        if (
          actions.some(
            (action) =>
              action.type === "ai_aggregate" &&
              action.mode !== "same_event" &&
              this.options.store.stories.activeStories(
                rule.id,
                createHash("sha256")
                  .update(JSON.stringify({ mode: action.mode, scope: action.scope }))
                  .digest("hex"),
              ).length,
          )
        )
          continue
        // 不同发布版本分别拥有综述输入，不能把另一版本的决定当成本批已核验材料。
        const key = `${version}:${sharedStoryRuleFingerprint(rule, config.global)}`
        const plan = grouped.get(key) ?? { rule, config, materials: [] }
        plan.materials.push(material)
        grouped.set(key, plan)
      }
    }
    return [...grouped.values()].filter((plan) => plan.materials.length >= 2).slice(0, 20)
  }

  // 按当前输入身份索引已付费的联合产物；崩溃续跑与单篇缓存命中仍可复用派生结论。
  async restore(inputs: readonly ProcessingInput[]) {
    for (const input of inputs) {
      try {
        const cached: unknown = JSON.parse(await readFile(this.cachePath(input), "utf8"))
        if (!record(cached) || cached.version !== 1) continue
        if (Array.isArray(cached.dedupe)) {
          for (const item of cached.dedupe) {
            const parsed = cachedDedupeSchema.safeParse(item)
            if (!parsed.success || !this.currentIdentities(parsed.data.inputs)) continue
            if (
              this.dedupeEvaluations.some(
                (existing) =>
                  existing.configFingerprint === parsed.data.configFingerprint &&
                  existing.pairKey === parsed.data.pairKey,
              )
            )
              continue
            // 旧缓存的低把握否定也遵守当前结论资格，不把历史 decided 当成确定答案。
            this.dedupeEvaluations.push({
              ...parsed.data,
              evaluation: {
                ...parsed.data.evaluation,
                status: semanticDuplicateEvaluationStatus(parsed.data.evaluation),
              },
            })
          }
        }
        if (Array.isArray(cached.stories)) {
          for (const item of cached.stories) {
            const parsed = cachedStorySchema.safeParse(item)
            if (!parsed.success || !this.currentIdentities(parsed.data.inputs)) continue
            if (
              this.storyGroups.some(
                (existing) =>
                  existing.ruleFingerprint === parsed.data.ruleFingerprint &&
                  JSON.stringify(existing.inputSeqs) === JSON.stringify(parsed.data.inputSeqs),
              )
            )
              continue
            this.storyGroups.push(parsed.data)
          }
        }
      } catch {
        // 缺少或损坏缓存只失去复用资格，原始条目仍由各阶段独立校验。
      }
    }
  }

  private currentIdentities(inputs: unknown[]) {
    return (
      inputs.length > 0 &&
      inputs.every((input) => {
        if (
          !record(input) ||
          typeof input.sourceKey !== "string" ||
          typeof input.itemId !== "string"
        )
          return false
        const current = this.options.store.automation.current(input.sourceKey, input.itemId)
        return (
          current !== null &&
          current.seq === input.seq &&
          current.generation === input.generation &&
          current.contentVersion === input.contentVersion
        )
      })
    )
  }

  private cachePath(input: ProcessingInput) {
    const hash = createHash("sha256")
      .update(JSON.stringify(identity(input)))
      .digest("hex")
    return join(this.options.runtimeDir, "shared-analysis", `${hash}.json`)
  }

  private async persist(
    inputs: ProcessingInput[],
    dedupe: PreparedDedupeEvaluation[],
    stories: SharedStoryGroup[],
  ) {
    if (!dedupe.length && !stories.length) return
    const body = JSON.stringify({ version: 1, dedupe, stories })
    try {
      await mkdir(join(this.options.runtimeDir, "shared-analysis"), {
        recursive: true,
        mode: 0o700,
      })
      for (const input of inputs) {
        const path = this.cachePath(input)
        await writeFile(`${path}.tmp`, body, { mode: 0o600 })
        await rename(`${path}.tmp`, path)
      }
    } catch {
      // 已成功的模型结果应继续发布；磁盘写入失败不能触发同一单篇的再次付费。
    }
  }
}
