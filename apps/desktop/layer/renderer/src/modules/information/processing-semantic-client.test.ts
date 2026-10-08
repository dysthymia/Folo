import { semanticTagDefinitions } from "@follow/information-core"
import { describe, expect, it, vi } from "vitest"

import { readingRequest } from "./processing-reader-client"
import {
  entrySemanticProfileSchema,
  loadSemanticTagCatalog,
  semanticTagCatalogSchema,
} from "./processing-semantic-client"

vi.mock("./processing-reader-client", () => ({ readingRequest: vi.fn() }))

const profile = {
  schemaVersion: 2,
  contentVersion: "v2",
  materialDigest: "material",
  definitionDigest: "definitions",
  assessedTagIds: ["topic:ai"],
  assessments: [],
  evidence: { e1: "MagicBlock announced its Validator" },
  coverage: "partial",
}

// 目录读取使用现有本地只读传输，完整保留实际定义和版本。
it("读取服务端标签目录，不将定义降为界面文案", async () => {
  const signal = new AbortController().signal
  const catalog = semanticTagCatalogSchema.parse({ definitions: semanticTagDefinitions })
  vi.mocked(readingRequest).mockResolvedValueOnce(catalog)
  expect(await loadSemanticTagCatalog(signal)).toEqual(catalog)
  expect(readingRequest).toHaveBeenCalledWith(
    "processing/semantic-tags",
    semanticTagCatalogSchema,
    signal,
  )
  expect(catalog.definitions).toHaveLength(22)
  expect(catalog.definitions.find((item) => item.id === "topic:product")?.definitionVersion).toBe(2)
})

describe("entrySemanticProfileSchema", () => {
  it("读取旧画像时保留无实体状态，新画像完整保留实体证据", () => {
    expect(entrySemanticProfileSchema.parse(profile).entities).toBeUndefined()
    const entity = {
      kind: "product",
      name: "Validator",
      parentName: "MagicBlock",
      aliases: ["MagicBlock Validator"],
      confidence: 0.98,
      evidenceIds: ["e1"],
    }
    const result = entrySemanticProfileSchema.parse({
      ...profile,
      entityVersion: 1,
      entities: [entity],
    })
    expect(result.entityVersion).toBe(1)
    expect(result.entities).toEqual([entity])
    expect(
      entrySemanticProfileSchema.safeParse({
        ...profile,
        entities: [{ ...entity, confidence: 1.1 }],
      }).success,
    ).toBe(false)
  })
})
