import { describe, expect, it } from "vitest"

import {
  normalizeScheduleScope,
  resolveScheduleSourceKeys,
  scheduleScopeSchema,
} from "./schedule-scope"

const sources = [
  { key: "feed:a", view: 0, category: "tech" },
  { key: "feed:b", view: 0, category: "tech" },
  { key: "feed:c", view: 1, category: "news" },
  { key: "inbox:d", view: 0, category: null },
]

describe("schedule-scope", () => {
  it("旧扁平 sourceKeys 记录读为等价于 fixed", () => {
    expect(normalizeScheduleScope({ sourceKeys: ["feed:a", "feed:b"] })).toEqual({
      mode: "fixed",
      sourceKeys: ["feed:a", "feed:b"],
    })
    // 缺失 mode 且非扁平格式时抛错，而不是静默退化。
    expect(() => normalizeScheduleScope({ mode: "unknown" })).toThrow("invalid_schedule_scope")
  })

  it("all 解析为全部源", () => {
    expect(resolveScheduleSourceKeys({ mode: "all" }, sources)).toEqual([
      "feed:a",
      "feed:b",
      "feed:c",
      "inbox:d",
    ])
    expect(scheduleScopeSchema.safeParse({ mode: "all" }).success).toBe(true)
  })

  it("category 只展开落在指定 view/category 的源", () => {
    expect(
      resolveScheduleSourceKeys({ mode: "category", view: 0, category: "tech" }, sources),
    ).toEqual(["feed:a", "feed:b"])
    // 其他分类 / view 的源不纳入，证明不是简单全选。
    expect(
      resolveScheduleSourceKeys({ mode: "category", view: 1, category: "news" }, sources),
    ).toEqual(["feed:c"])
  })

  it("fixed 不自动纳入新来源", () => {
    const scope = { mode: "fixed" as const, sourceKeys: ["feed:a"] }
    // 即使 sources 里多出了 feed:b，fixed 仍只返回名单内的来源。
    expect(resolveScheduleSourceKeys(scope, sources)).toEqual(["feed:a"])
  })

  it("category 描述符校验空分类名", () => {
    expect(scheduleScopeSchema.safeParse({ mode: "category", view: 0, category: "" }).success).toBe(
      false,
    )
  })
})
