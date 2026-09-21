import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { localActionSyncService, useLocalActionStore } from "./local-store"
import type { ActionItem } from "./store"

const rule: ActionItem = {
  index: 0,
  name: "Local rule",
  condition: [[{ field: "entry_title", operator: "contains", value: "AI" }]],
  result: { block: true },
}

const target = {
  index: 0,
  name: rule.name,
  condition: rule.condition,
  result: rule.result,
}

const storage = {
  getItem: vi.fn(),
  setItem: vi.fn(),
}

describe("disablePublishedMigrationTargets", () => {
  beforeEach(() => {
    storage.getItem.mockReset()
    storage.setItem.mockReset()
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { localStorage: storage },
    })
    useLocalActionStore.setState({
      isDirty: false,
      isHydrated: true,
      ownerKey: "owner",
      revision: 1,
      rules: [structuredClone(rule)],
    })
  })

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "window")
  })

  it("精确匹配后先持久化，再停用同一条本地旧规则", () => {
    expect(localActionSyncService.disablePublishedMigrationTargets("owner", [target])).toEqual({
      switched: true,
      count: 1,
    })
    expect(JSON.parse(String(storage.setItem.mock.calls[0]?.[1])).rules[0].result.disabled).toBe(
      true,
    )
    expect(useLocalActionStore.getState().rules[0]?.result.disabled).toBe(true)
  })

  it("旧规则已变化或持久化失败时保持启用", () => {
    expect(
      localActionSyncService.disablePublishedMigrationTargets("owner", [
        { ...target, condition: [[{ field: "entry_title", operator: "contains", value: "ML" }]] },
      ]),
    ).toEqual({ switched: false, reason: "changed" })
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(useLocalActionStore.getState().rules[0]?.result.disabled).toBeUndefined()

    storage.setItem.mockImplementationOnce(() => {
      throw new Error("quota")
    })
    expect(() =>
      localActionSyncService.disablePublishedMigrationTargets("owner", [target]),
    ).toThrow("quota")
    expect(useLocalActionStore.getState().rules[0]?.result.disabled).toBeUndefined()
  })

  it("未 hydration、anonymous 或 owner 不符时拒绝切换账号规则", () => {
    useLocalActionStore.setState({ isHydrated: false })
    expect(localActionSyncService.disablePublishedMigrationTargets("owner", [target])).toEqual({
      switched: false,
      reason: "owner",
    })
    useLocalActionStore.setState({ isHydrated: true, ownerKey: "other" })
    expect(localActionSyncService.disablePublishedMigrationTargets("owner", [target])).toEqual({
      switched: false,
      reason: "owner",
    })
    expect(storage.setItem).not.toHaveBeenCalled()
  })
})
