import { describe, expect, it } from "vitest"

import {
  createEvidenceCatalog,
  createEvidenceCatalogFromQuotes,
  evidenceFactSelectionSchema,
  materializeEvidenceFacts,
  renderEvidenceCatalog,
} from "./processing-evidence"

describe("确定性证据目录", () => {
  it("按段落和句子稳定编号，且每段都是连续原文", () => {
    const text = "第一句。第二句包含 3.14 和 https://example.test/a。\n下一段🙂结束！"
    const first = createEvidenceCatalog(text, { prefix: "T", maxFragmentChars: 18 })
    const second = createEvidenceCatalog(text, { prefix: "T", maxFragmentChars: 18 })
    expect(first.fragments).toEqual(second.fragments)
    expect(first.fragments.every((fragment) => text.includes(fragment.quote))).toBe(true)
    expect(first.fragments.every((fragment) => fragment.quote.length <= 18)).toBe(true)
    expect(first.fragments.map((fragment) => fragment.evidenceId)).toEqual(
      first.fragments.map((_, index) => `T${String(index + 1).padStart(6, "0")}`),
    )
    expect(renderEvidenceCatalog(first)).not.toContain(text)
  })

  it("硬切分不拆开 emoji grapheme", () => {
    const family = "👨‍👩‍👧‍👦"
    const catalog = createEvidenceCatalog(`甲${family}乙`, {
      maxFragmentChars: family.length + 1,
    })
    expect(catalog.fragments.map((fragment) => fragment.quote)).toEqual([`甲${family}`, "乙"])
  })

  it("已验证 quote 去重编号并精确还原持久化 facts", () => {
    const catalog = createEvidenceCatalogFromQuotes(["连续原文", "另一证据", "连续原文"], {
      prefix: "F",
    })
    expect(catalog.fragments).toHaveLength(2)
    const evidenceId = catalog.identify("连续原文")!
    expect(materializeEvidenceFacts(catalog, [{ text: "事实", kind: "fact", evidenceId }])).toEqual(
      [{ text: "事实", kind: "fact", quote: "连续原文" }],
    )
  })

  it("拒绝未知编号和模型自由 quote 字段", () => {
    const catalog = createEvidenceCatalog("原文。")
    expect(() =>
      materializeEvidenceFacts(catalog, [{ text: "事实", kind: "fact", evidenceId: "E999999" }]),
    ).toThrow("invalid_model_reference")
    expect(
      evidenceFactSelectionSchema.safeParse({
        text: "事实",
        kind: "fact",
        evidenceId: "E000001",
        quote: "自由抄写",
      }).success,
    ).toBe(false)
  })
})
