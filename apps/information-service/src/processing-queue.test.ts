import { describe, expect, it } from "vitest"

import { Store } from "./store"

// 活动队列必须排除历史版本、其它来源和窗口外文章；时区等价时间不能被字符串排序漏掉。
describe("处理范围查询", () => {
  it("按当前输入、状态、来源和真实时间筛选，并单独读取上下文元数据", () => {
    const store = new Store(":memory:")
    try {
      store.bindOwner("owner")
      const save = (id: string, sourceKey: string, publishedAt: string, content = id) =>
        store.saveEntry({
          id,
          sourceKey,
          publishedAt,
          content,
          title: id,
          url: null,
          read: false,
          description: null,
          feedId: "original",
          feedKind: "feed",
        })
      save("target", "list/a", "2026-04-01T08:00:00+08:00")
      save("target", "list/a", "2026-04-01T08:00:00+08:00", "changed")
      save("other", "feed/b", "2026-04-01T00:00:00Z")
      save("before", "list/a", "2026-03-30T00:00:00Z")
      save("after", "list/a", "2026-04-02T00:00:00Z")
      const scope = {
        sourceKeys: ["list/a"],
        historySince: "2026-04-01T00:00:00Z",
        cutoffAt: "2026-04-01T00:00:00Z",
      }
      const queue = store.automation.processingInputs(scope)
      expect(queue.map((item) => item.itemId)).toEqual(["target"])
      expect(queue[0]!.body.content).toBe("changed")
      expect(
        store.automation.contextInputs().filter((item) => item.sourceKey === "list/a"),
      ).toHaveLength(3)
      expect(
        store.automation.contextInputs().find((item) => item.seq === queue[0]!.seq)?.body,
      ).toEqual({ feedId: "original", feedKind: "feed" })
    } finally {
      store.close()
    }
  })
})
