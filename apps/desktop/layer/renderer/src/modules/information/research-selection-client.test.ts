import { describe, expect, it, vi } from "vitest"

import { researchPackSchema } from "./research-client"
import { researchSelectionPreviewSchema } from "./research-selection-client"

vi.mock("~/lib/auth", () => ({ oneTimeToken: { generate: vi.fn() } }))

describe("一次性研究契约", () => {
  it("接收两次调用的完整性预览，拒绝未知字段和过大调用数", () => {
    const preview = {
      selectionCount: 1,
      totalCharacters: 123,
      missingContext: [],
      estimatedModelCalls: 2,
      canExecute: true,
      materials: [
        {
          sourceKey: "feed/1",
          entryId: "old",
          materialId: "material:original",
          inputSeq: 7,
          title: "历史",
          characters: 123,
        },
      ],
      selectionToken: "frozen",
    }
    expect(researchSelectionPreviewSchema.safeParse({ preview }).success).toBe(true)
    expect(
      researchSelectionPreviewSchema.safeParse({ preview: { ...preview, estimatedModelCalls: 3 } })
        .success,
    ).toBe(false)
    expect(
      researchSelectionPreviewSchema.safeParse({ preview: { ...preview, apiKey: "private" } })
        .success,
    ).toBe(false)
  })

  it("保存结果保持所选原文、句段引用和实际用量，旧材料契约仍可读取", () => {
    const original = {
      id: "11111111-1111-4111-8111-111111111111",
      revision: 1,
      status: "prepared",
      target: { kind: "entry", inputSeq: 7 },
      question: "问题",
      goal: "目标",
      knownQuestions: [],
      title: "研究",
      markdown: "正文",
      createdAt: "2026-10-03T00:00:00Z",
      updatedAt: "2026-10-03T00:00:00Z",
      submissionReference: null,
      resultReference: null,
    }
    expect(researchPackSchema.safeParse(original).success).toBe(true)
    const selected = {
      ...original,
      status: "completed",
      target: { kind: "selection", entries: [{ sourceKey: "feed/1", entryId: "old" }] },
      result: {
        title: "综述",
        sentences: [
          {
            id: "s1",
            text: "事实",
            citations: [{ materialId: "material:original", quote: "原文证据" }],
          },
        ],
        limitations: ["未外部核实"],
      },
      metrics: {
        modelCalls: 2,
        durationMs: 500,
        usage: { inputTokens: 200, outputTokens: 50, cachedInputTokens: 0 },
      },
      errorCode: null,
    }
    expect(researchPackSchema.safeParse(selected).success).toBe(true)
    expect(researchPackSchema.safeParse({ ...selected, secret: "private" }).success).toBe(false)
  })
})
