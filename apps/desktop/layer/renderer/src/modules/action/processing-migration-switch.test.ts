import { beforeEach, describe, expect, it } from "vitest"

import {
  loadPendingLocalMigrationSwitches,
  savePendingLocalMigrationSwitches,
} from "./processing-migration-switch"

const pending = {
  migratedRuleId: "new-rule-id",
  index: 0,
  name: "旧规则",
  condition: [],
  result: { actions: [{ type: "ai_transform", prompt: "x" }] },
}

describe("pending local migration switches", () => {
  beforeEach(() => window.localStorage.clear())

  it("按 owner 持久恢复精确旧规则身份，并在清空时删除", () => {
    savePendingLocalMigrationSwitches("owner-a", [pending])
    expect(loadPendingLocalMigrationSwitches("owner-a")).toEqual([pending])
    expect(loadPendingLocalMigrationSwitches("owner-b")).toEqual([])

    savePendingLocalMigrationSwitches("owner-a", [])
    expect(loadPendingLocalMigrationSwitches("owner-a")).toEqual([])
  })

  it("损坏的本地记录不会触发停用", () => {
    window.localStorage.setItem(
      "follow:processing-migration-switch:v1:owner-a",
      JSON.stringify([{ ...pending, index: -1 }]),
    )
    expect(loadPendingLocalMigrationSwitches("owner-a")).toEqual([])
  })
})
