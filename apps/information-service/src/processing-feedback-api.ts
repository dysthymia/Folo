import { z } from "zod"

import type { ProcessingInput } from "./automation-store"
import type { ProcessingDecision } from "./processing-decision"
import type { FeedbackSuggestion } from "./processing-feedback"
import { feedbackKinds, ProcessingFeedbackError } from "./processing-feedback"
import type { Store } from "./store"

const explanation = z.string().trim().min(1).max(4_000)
const referenceId = z.string().trim().min(1).max(500)
const shared = {
  kind: z.enum(feedbackKinds),
  explanation: explanation.optional(),
  suggestion: explanation.optional(),
  referenceIds: z.array(referenceId).max(100).optional(),
}
const entryFeedback = z
  .object({
    ...shared,
    target: z
      .object({
        kind: z.literal("entry"),
        inputSeq: z.number().int().positive(),
        expectedDecisionId: z.string().trim().min(1).max(500).nullable(),
      })
      .strict(),
  })
  .strict()
const storyFeedback = z
  .object({
    ...shared,
    target: z
      .object({
        kind: z.literal("story"),
        storyId: z.uuid(),
        storyRevision: z.number().int().positive(),
      })
      .strict(),
  })
  .strict()
const feedbackInput = z.union([entryFeedback, storyFeedback])

export type ProcessingFeedbackResponse = {
  feedback: ReturnType<Store["feedback"]["list"]>
}

// 该 API 只创建审阅记录；基础恢复、合并和拆分仍由既有处理接口负责。
export function processingFeedbackApi(
  store: Store,
  method: string,
  path: string,
  body: unknown,
): ProcessingFeedbackResponse | { feedback: ReturnType<Store["feedback"]["record"]> } | undefined {
  if (path !== "/feedback") return undefined
  if (method === "GET") {
    z.object({}).strict().parse(body)
    return { feedback: store.feedback.list() }
  }
  if (method !== "POST") return undefined

  requireOwner(store)
  const input = feedbackInput.parse(body)
  const referenceIds = input.referenceIds ?? []
  if ("inputSeq" in input.target) {
    const inputSeq = input.target.inputSeq
    const target = store.automation.inputs().find((candidate) => candidate.seq === inputSeq)
    if (!target) throw new ProcessingFeedbackError("invalid_target")
    if (referenceIds.length) throw new ProcessingFeedbackError("invalid_reference")
    const published = publishedBySeq(store).get(target.seq)
    if (input.target.expectedDecisionId !== (published?.decisionId ?? null))
      throw new ProcessingFeedbackError("stale_target")
    return {
      feedback: store.feedback.record({
        kind: input.kind,
        target: {
          kind: "entry",
          inputSeq: target.seq,
          sourceKey: target.sourceKey,
          itemId: target.itemId,
          contentVersion: target.contentVersion,
          decisionId: published?.decisionId ?? null,
          releaseVersion: target.releaseVersion,
        },
        explanation: input.explanation ?? null,
        referenceIds,
        suggestion: suggestion(input.suggestion),
      }),
    }
  }

  const link = store.stories.resolveLink(input.target.storyId)
  if (link.kind !== "current" || link.revision.revision !== input.target.storyRevision)
    throw new ProcessingFeedbackError("stale_target")
  const allowedReferences = new Set(link.revision.citations.map((citation) => citation.id))
  if (referenceIds.some((id) => !allowedReferences.has(id)))
    throw new ProcessingFeedbackError("invalid_reference")
  const published = publishedBySeq(store)
  const related = link.revision.members
    .map((member) => published.get(member.inputSeq))
    .filter(
      (
        candidate,
      ): candidate is {
        decisionId: string
        input: ProcessingInput
        decision: ProcessingDecision
      } => Boolean(candidate),
    )
  return {
    feedback: store.feedback.record({
      kind: input.kind,
      target: {
        kind: "story",
        storyId: link.story.id,
        storyRevision: link.revision.revision,
        decisionIds: [...new Set(related.map((item) => item.decisionId))],
        releaseVersions: [
          ...new Set(related.map((item) => item.input.releaseVersion).filter(isNumber)),
        ],
      },
      explanation: input.explanation ?? null,
      referenceIds,
      suggestion: suggestion(input.suggestion),
    }),
  }
}

function requireOwner(store: Store): string {
  if (!store.ownerId) throw new ProcessingFeedbackError("owner_required")
  return store.ownerId
}

function publishedBySeq(store: Store) {
  return new Map(store.processingState.published().map((item) => [item.input.seq, item]))
}

function isNumber(value: number | null): value is number {
  return value !== null
}

function suggestion(userText: string | undefined): FeedbackSuggestion | null {
  if (!userText) return null
  return {
    status: "proposed",
    userText,
    prompt: `用户建议原文：${userText}\n\n建议：在对应规则范围中人工审阅这条说明；不要自动发布、修改标签或覆盖既有规则。`,
  }
}
