import { describe, expect, it } from "vitest"

import {
  SEMANTIC_ENTITY_VERSION,
  semanticEntitiesSchema,
  semanticEntityId,
  semanticEntitySchema,
} from "./semantic-entities"

// 使用明确的实体与正文证据验证协议，不依赖模型输出或联网内容。
const entity = {
  kind: "product" as const,
  name: "Lens",
  parentName: "Acme",
  aliases: ["Acme Lens"],
  confidence: 0.9,
  evidenceIds: ["body:1"],
}

describe("语义实体协议", () => {
  it("规范名称空白并允许独立实体，严格限制类别、证据和输出规模", () => {
    expect(SEMANTIC_ENTITY_VERSION).toBe(1)
    expect(
      semanticEntitySchema.parse({ ...entity, name: " Lens ", parentName: " Acme " }).name,
    ).toBe("Lens")
    expect(semanticEntitySchema.safeParse({ ...entity, parentName: null }).success).toBe(true)
    for (const update of [
      { kind: "person" },
      { name: " " },
      { name: "x".repeat(101) },
      { parentName: " " },
      { aliases: [" "] },
      { aliases: Array.from({ length: 6 }, () => "alias") },
      { confidence: -0.1 },
      { confidence: 1.1 },
      { evidenceIds: [] },
      { evidenceIds: [""] },
      { evidenceIds: ["x".repeat(201)] },
      { evidenceIds: Array.from({ length: 11 }, () => "body:1") },
      { unsupported: true },
    ])
      expect(semanticEntitySchema.safeParse({ ...entity, ...update }).success).toBe(false)
    expect(semanticEntitiesSchema.safeParse(Array.from({ length: 8 }, () => entity)).success).toBe(
      true,
    )
    expect(semanticEntitiesSchema.safeParse(Array.from({ length: 9 }, () => entity)).success).toBe(
      false,
    )
    expect(semanticEntitiesSchema.parse([])).toEqual([])
  })
  it("Unicode 与大小写规范化身份稳定，证据与别名变化不改变身份", () => {
    expect(semanticEntityId({ ...entity, name: " ＬＥＮＳ ", parentName: "ＡＣＭＥ" })).toBe(
      semanticEntityId(entity),
    )
    expect(semanticEntityId({ ...entity, name: "Café" })).toBe(
      semanticEntityId({ ...entity, name: "Cafe\u0301" }),
    )
    const changedEvidenceEntity = { ...entity, aliases: [], evidenceIds: ["body:2"] }
    expect(semanticEntityId(changedEvidenceEntity)).toBe(semanticEntityId(entity))
  })
  it("同名不同类别、不同父实体及近似拼写保持独立，别名不能自动合并", () => {
    for (const other of [
      { ...entity, kind: "organization" as const },
      { ...entity, parentName: "Another Company" },
      { ...entity, parentName: null },
      { ...entity, name: "Lenz" },
      { ...entity, name: "Acme Lens" },
    ])
      expect(semanticEntityId(other)).not.toBe(semanticEntityId(entity))
    // 使用结构化编码，名称中的分隔符不会造成不同父实体的身份碰撞。
    expect(semanticEntityId({ ...entity, name: "a:b", parentName: "c" })).not.toBe(
      semanticEntityId({ ...entity, name: "a", parentName: "b:c" }),
    )
  })
})
