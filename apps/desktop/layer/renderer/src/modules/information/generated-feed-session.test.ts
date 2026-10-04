import { describe, expect, it } from "vitest"

import type { ReaderSession } from "./generated-feed-session"
import { readerSession, saveReaderSession, updateReaderSessions } from "./generated-feed-session"

const session: ReaderSession = {
  page: {
    feed: { id: "generated:events", origin: "generated", title: "事件综述", private: true },
    snapshotId: "snapshot",
    latestAvailable: false,
    total: 0,
    nextCursor: null,
    items: [],
  },
  items: [],
  cursors: [undefined],
  scrollTop: 12,
}
describe("阅读会话账号与副本保护", () => {
  it("切账号后旧cleanup不能重置activeOwner或保存旧页", () => {
    readerSession("owner-a", "scope")
    saveReaderSession("owner-a", "scope", session)
    readerSession("owner-b", "scope")
    saveReaderSession("owner-b", "scope", { ...session, scrollTop: 34 })
    saveReaderSession("owner-a", "scope", session)
    expect(readerSession("owner-b", "scope")?.scrollTop).toBe(34)
  })
  it("保存与读取均隔离可变游标，分页不会污染缓存", () => {
    readerSession("owner-a", "scope")
    saveReaderSession("owner-a", "scope", session)
    const saved = readerSession("owner-a", "scope")!
    saved.cursors.push("later")
    expect(readerSession("owner-a", "scope")?.cursors).toEqual([undefined])
  })
  it("同账号跨筛选保存完成的操作，旧账号结果不得进入新账号缓存", () => {
    readerSession("owner-a", "scope-a")
    saveReaderSession("owner-a", "scope-a", session)
    saveReaderSession("owner-a", "scope-b", session)
    updateReaderSessions("owner-a", "story:one", { collected: true })
    expect(readerSession("owner-a", "scope-a")?.readChanges).toEqual([
      ["story:one", { collected: true }],
    ])
    expect(readerSession("owner-a", "scope-b")?.readChanges).toEqual([
      ["story:one", { collected: true }],
    ])
    readerSession("owner-b", "scope-a")
    saveReaderSession("owner-b", "scope-a", session)
    updateReaderSessions("owner-a", "story:one", { collected: true })
    expect(readerSession("owner-b", "scope-a")?.readChanges).toBeUndefined()
  })
})
