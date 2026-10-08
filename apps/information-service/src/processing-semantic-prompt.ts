import type { TagAssessment } from "@follow/information-core"
import { semanticTagDefinition, tagAssessmentSchema } from "@follow/information-core"
import { z } from "zod"

import type { EvidenceCatalog } from "./processing-evidence"
import { SEMANTIC_ENTITY_REQUIREMENTS } from "./processing-semantic-entities"

// 这些标签描述整篇缺乏实质信息，不能根据局部推广、闲聊或口号判定整篇。
const wholeContentNoiseIds = new Set([
  "form:pure_entertainment",
  "signal:social_chatter",
  "signal:empty_opinion",
  "signal:pure_promotion",
])
export function isWholeContentNoiseTag(tagId: string) {
  return wholeContentNoiseIds.has(tagId)
}

// 定义版本和示例同时进入提示及缓存身份，避免展示偏好改变客观标签含义。
export function semanticDefinitionsForIds(ids: readonly string[]) {
  return [...new Set(ids)].map((id) => {
    const definition = semanticTagDefinition(id)
    if (!definition || !definition.enabled) throw new Error("invalid_semantic_tag_definition")
    return definition
  })
}

export function renderSemanticTagRequirements(ids: readonly string[]) {
  const definitions = semanticDefinitionsForIds(ids)
  if (!definitions.length) return ""
  return `语义标签评估：逐个返回全部指定 tagId 的 tagAssessments，definitionVersion 必须与定义一致。标签含义不取决于用户偏好、隐藏动作或展示长度。
state=present 需要明确证据；不存在须以完整已读材料为依据，缺失正文、图片或引用内容必须保留 unknown，不能把未读当作 absent。confidence 是客观自评，不为迎合规则提高置信度。
必须返回 materialCoverage=complete 或 partial：该字段只说明可供判断的原文材料是否完整，不由标签 unknown 或低置信度决定；缺失图片/正文/影响判断的引用填 partial。
必须同时返回 substantiveContribution={state, confidence, reason, evidenceIds}，独立记录证据支持的实质贡献，present 必须引用当前证据且给出真实置信度；没有充分材料填 unknown。
教程、原始数据、实测、论据、具体经验和可用事实均属于实质贡献；文章含推广但仍有这些贡献时，纯推广、纯娱乐、纯闲聊、空泛观点等整篇无价值标签不能为 present。
只用当前证据目录里的 evidenceIds，不返回自由引文；标签证据独立于 facts 上限，不能因 facts 未保留某节而假定该节不存在。
标签定义：${JSON.stringify(definitions)}
${SEMANTIC_ENTITY_REQUIREMENTS}`
}

// 结构化输出绑定本次请求的标签、当前定义版本和证据目录；遗漏或重复标签都拒绝。
export function createTagAssessmentsSelectionSchema(
  catalog: EvidenceCatalog,
  ids: readonly string[],
) {
  const definitions = semanticDefinitionsForIds(ids)
  const evidenceIds = catalog.fragments.map((item) => item.evidenceId)
  const evidenceSchema = evidenceIds.length
    ? z.array(z.enum(evidenceIds as [string, ...string[]])).max(100)
    : z.array(z.string()).max(0)
  const schemas = definitions.map((definition) =>
    tagAssessmentSchema.extend({
      tagId: z.literal(definition.id),
      definitionVersion: z.literal(definition.definitionVersion),
      evidenceIds: evidenceSchema,
    }),
  )
  const itemSchema =
    schemas.length > 1
      ? z.union(
          schemas as [
            (typeof schemas)[number],
            (typeof schemas)[number],
            ...(typeof schemas)[number][],
          ],
        )
      : (schemas[0] ?? tagAssessmentSchema)
  return z
    .array(itemSchema)
    .length(definitions.length)
    .superRefine((assessments, context) => {
      const seen = new Set<string>()
      for (const [index, assessment] of assessments.entries()) {
        if (seen.has(assessment.tagId))
          context.addIssue({
            code: "custom",
            path: [index, "tagId"],
            message: "duplicate_tag_assessment",
          })
        seen.add(assessment.tagId)
        if (assessment.state === "present" && !assessment.evidenceIds.length)
          context.addIssue({
            code: "custom",
            path: [index, "evidenceIds"],
            message: "missing_tag_evidence",
          })
      }
    })
}

// 实质贡献独立于标签和摘要上限保存，普通单篇与长文共用相同证据约束。
export const substantiveContributionSchema = z
  .object({
    state: z.enum(["present", "absent", "unknown"]),
    confidence: z.number().finite().min(0).max(1).nullable(),
    reason: z.string().trim().min(1).max(4000),
    evidenceIds: z.array(z.string().trim().min(1).max(200)).max(100),
  })
  .strict()
export type SubstantiveContribution = z.infer<typeof substantiveContributionSchema>

export function substantiveContributionForCatalog(catalog: EvidenceCatalog) {
  const ids = catalog.fragments.map((item) => item.evidenceId)
  return substantiveContributionSchema
    .extend({
      evidenceIds: ids.length
        ? z.array(z.enum(ids as [string, ...string[]])).max(100)
        : z.array(z.string()).max(0),
    })
    .superRefine((value, context) => {
      if (value.state === "present" && !value.evidenceIds.length)
        context.addIssue({
          code: "custom",
          path: ["evidenceIds"],
          message: "missing_contribution_evidence",
        })
    })
}

export function hasReliableContribution(value: SubstantiveContribution | undefined) {
  return (
    value?.state === "present" && (value.confidence ?? 0) >= 0.8 && value.evidenceIds.length > 0
  )
}

// 单篇也必须保护已证实的贡献；冲突保留 unknown，而非改写模型的原始判断。
export function protectWholeContentAssessments(
  assessments: readonly TagAssessment[],
  contribution: SubstantiveContribution | undefined,
): TagAssessment[] {
  // 教程、实测、原始数据和有据分析的可靠正证本身也构成贡献反例。
  const positive = assessments.filter(
    (item) =>
      ["form:tutorial", "form:review", "signal:original_data", "signal:reasoned_analysis"].includes(
        item.tagId,
      ) &&
      item.state === "present" &&
      (item.confidence ?? 0) >= 0.8 &&
      item.evidenceIds.length > 0,
  )
  const protectedContribution = hasReliableContribution(contribution) || positive.length > 0
  const evidenceIds = [
    ...new Set([
      ...(hasReliableContribution(contribution) ? contribution!.evidenceIds : []),
      ...positive.flatMap((item) => item.evidenceIds),
    ]),
  ]
  return assessments.map((item) =>
    protectedContribution && isWholeContentNoiseTag(item.tagId) && item.state === "present"
      ? {
          ...item,
          state: "unknown",
          confidence: null,
          reason: `纯噪声判断与已证实的实质贡献冲突，保留原文待确认：${contribution?.reason ?? positive.map((item) => item.reason).join("；")}`,
          evidenceIds: [...new Set([...item.evidenceIds, ...evidenceIds])].slice(0, 100),
        }
      : item,
  )
}

export type ChunkSemanticObservation = {
  coverage: "complete" | "partial"
  tagAssessments: TagAssessment[]
  substantiveContribution: {
    state: TagAssessment["state"]
    confidence?: number | null
    reason?: string
    evidenceIds: string[]
  }
}

// 存在性标签只需一块可靠正证；整篇噪声须所有分块完整且一致，任何实质贡献都会否定。
export function combineChunkTagAssessments(
  chunks: readonly ChunkSemanticObservation[],
  ids: readonly string[],
): TagAssessment[] {
  return semanticDefinitionsForIds(ids).map((definition) => {
    const assessments = chunks.map((chunk) =>
      chunk.tagAssessments.find((item) => item.tagId === definition.id),
    )
    const complete = chunks.length > 0 && chunks.every((chunk) => chunk.coverage === "complete")
    const substantive = chunks.filter(
      (chunk) =>
        chunk.substantiveContribution.state === "present" &&
        (chunk.substantiveContribution.confidence ?? 0) >= 0.8 &&
        chunk.substantiveContribution.evidenceIds.length > 0,
    )
    const knownNoContribution = chunks.every(
      (chunk) => chunk.substantiveContribution.state === "absent",
    )
    const present = assessments.filter((item): item is TagAssessment => item?.state === "present")
    const absent = assessments.filter((item): item is TagAssessment => item?.state === "absent")
    const wholeContent = isWholeContentNoiseTag(definition.id)
    const coveredCounterexamples = chunks.flatMap((chunk) => {
      const item = chunk.tagAssessments.find((assessment) => assessment.tagId === definition.id)
      return chunk.coverage === "complete" && item?.state === "absent" ? [item] : []
    })
    let state: TagAssessment["state"] = "unknown"
    let support: TagAssessment[] = []
    let reason = "分块覆盖或判断不完整，不能把遗漏材料判为不存在或整篇无价值。"
    let contributionIds: string[] = []
    if (wholeContent && substantive.length) {
      state = "absent"
      reason = "至少一个分块提供实质贡献，整篇无价值标签不成立。"
      support = absent
      contributionIds = substantive.flatMap((chunk) => chunk.substantiveContribution.evidenceIds)
    } else if (wholeContent && coveredCounterexamples.length) {
      state = "absent"
      support = coveredCounterexamples
      reason = "至少一个分块不符合整篇无价值定义，不能用其他分块的局部噪声覆盖它。"
    } else if (!wholeContent && present.length) {
      state = "present"
      support = present
      reason = "至少一个已读分块提供该标签的明确证据。"
    } else if (complete && assessments.every((item) => item?.state === "absent")) {
      state = "absent"
      support = absent
      reason = "所有分块已完整评估且均未发现该标签。"
    } else if (
      wholeContent &&
      complete &&
      knownNoContribution &&
      present.length === chunks.length
    ) {
      state = "present"
      support = present
      reason = "全部分块完整且一致支持该标签，均无实质贡献。"
    }
    const confidences = support.map((item) => item.confidence)
    const numericConfidences = confidences.filter((value): value is number => value !== null)
    // 存在性正证和整篇噪声的反例只需一个可靠见证；全覆盖结论取最弱分块置信度。
    const singleWitness =
      (!wholeContent && state === "present") || (wholeContent && state === "absent")
    const confidence =
      state === "unknown" || !numericConfidences.length
        ? null
        : singleWitness
          ? Math.max(...numericConfidences)
          : confidences.includes(null)
            ? null
            : Math.min(...numericConfidences)
    return {
      tagId: definition.id,
      definitionVersion: definition.definitionVersion,
      state,
      confidence,
      reason,
      // 多块证据可能超过单次评估上限，只保留已验证的代表性引用。
      evidenceIds: [
        ...new Set([...contributionIds, ...support.flatMap((item) => item.evidenceIds)]),
      ].slice(0, 100),
    }
  })
}

// 任一证据充分的分块可证明贡献存在；否定必须覆盖整篇，缺失保持未知。
export function combineChunkContributions(
  chunks: readonly ChunkSemanticObservation[],
): SubstantiveContribution {
  const present = chunks.flatMap((chunk) => {
    const value = chunk.substantiveContribution
    return value.state === "present" && value.evidenceIds.length
      ? [
          {
            ...value,
            confidence: value.confidence ?? null,
            reason: value.reason ?? "已读分块提供可用事实、方法、论据或经验。",
          },
        ]
      : []
  })
  if (present.length)
    return {
      state: "present",
      confidence: present.some((item) => item.confidence !== null)
        ? Math.max(
            ...present.flatMap((item) => (item.confidence === null ? [] : [item.confidence])),
          )
        : null,
      reason: present
        .map((item) => item.reason)
        .join("；")
        .slice(0, 4000),
      evidenceIds: [...new Set(present.flatMap((item) => item.evidenceIds))].slice(0, 100),
    }
  const absent =
    chunks.length > 0 &&
    chunks.every(
      (chunk) => chunk.coverage === "complete" && chunk.substantiveContribution.state === "absent",
    )
  return {
    state: absent ? "absent" : "unknown",
    confidence:
      absent && chunks.every((chunk) => chunk.substantiveContribution.confidence != null)
        ? Math.min(...chunks.map((chunk) => chunk.substantiveContribution.confidence!))
        : null,
    reason: absent
      ? "全部分块完整评估后均未发现实质贡献。"
      : "材料覆盖或贡献判断不足，不能确认整篇没有实质贡献。",
    evidenceIds: [],
  }
}
