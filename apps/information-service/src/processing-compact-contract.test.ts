import { semanticTagDefinition, semanticTagIds } from "@follow/information-core"
import { describe, expect, it } from "vitest"
import { z } from "zod"

import {
  createEntryModelSelectionSchema,
  entryModelSelectionJSONSchema,
} from "./processing-decision"
import { createEvidenceCatalog } from "./processing-evidence"

const catalog = createEvidenceCatalog("公司发布了产品。", { prefix: "B1E" })
const schema = createEntryModelSelectionSchema("entry-1", catalog, ["topic:product"])
const assessment = { state: "absent", confidence: 0.98, reason: "未提供该类依据", evidenceIds: [] }
const selected = {
  entryId: "entry-1",
  title: "公司发布产品",
  summary: "公司发布产品",
  disposition: "keep",
  reason: "有原文依据",
  aggregation: false,
  rewrite: false,
  labels: [],
  event: null,
  facts: [],
  tagAssessments: { "topic:product": assessment },
  substantiveContribution: {
    state: "unknown",
    confidence: null,
    reason: "材料有限",
    evidenceIds: [],
  },
  materialCoverage: "complete",
  entities: [],
  eventMentions: [],
}

// 使用接近线上完整标签集合的契约复现单篇膨胀，不能只用无标签的短测试证明合批。
describe("紧凑标签模型协议", () => {
  it("程序补全标签身份和定义版本，持久化仍使用原有严格数组", () => {
    const parsed = schema.parse(selected)
    expect(parsed.tagAssessments).toEqual([
      {
        ...assessment,
        tagId: "topic:product",
        definitionVersion: semanticTagDefinition("topic:product")!.definitionVersion,
      },
    ])
    expect(schema.safeParse({ ...selected, tagAssessments: parsed.tagAssessments }).success).toBe(
      true,
    )
  })

  it("仍拒绝漏标签、未知标签、伪造元数据和跨篇证据", () => {
    for (const tagAssessments of [
      {},
      { "topic:other": assessment },
      { "topic:product": { ...assessment, definitionVersion: 999 } },
      { "topic:product": { ...assessment, state: "present", evidenceIds: ["B2E000001"] } },
      { "topic:product": { ...assessment, state: "present", evidenceIds: [] } },
    ])
      expect(schema.safeParse({ ...selected, tagAssessments }).success).toBe(false)
  })

  it("完整标签的4篇独立契约放入既有32K预算，保留每篇身份和证据枚举", () => {
    const schemas = Array.from({ length: 4 }, (_, index) =>
      createEntryModelSelectionSchema(
        `entry-${index + 1}`,
        createEvidenceCatalog(`第${index + 1}家公司发布产品。`, { prefix: `B${index + 1}E` }),
        semanticTagIds,
      ),
    )
    const batch = z.object({ items: z.array(z.union(schemas)).max(8) }).strict()
    const old = JSON.stringify(entryModelSelectionJSONSchema(batch))
    const wire = JSON.stringify(entryModelSelectionJSONSchema(batch, true))
    expect(old.length).toBeGreaterThan(50_000)
    expect(wire.length).toBeLessThan(32_000)
    for (let index = 1; index <= 4; index++) {
      expect(wire).toContain(`entry-${index}`)
      expect(wire).toContain(`B${index}E000001`)
    }
    for (const id of semanticTagIds) expect(wire).toContain(id)
  })
})
