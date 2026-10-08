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

export type ChunkSemanticObservation = {
  coverage: "complete" | "partial"
  tagAssessments: TagAssessment[]
  substantiveContribution: {
    state: TagAssessment["state"]
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
    const substantive = chunks.filter((chunk) => chunk.substantiveContribution.state === "present")
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
