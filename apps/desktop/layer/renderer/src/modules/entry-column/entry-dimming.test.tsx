import type { TagAssessment } from "@follow/information-core"
import { useIsEntryDimmedByLocalActions } from "@follow/store/action/local-hooks"
import { useLocalActionStore } from "@follow/store/action/local-store"
import {
  clearPublishedLocalFilters,
  setPublishedLocalFilters,
} from "@follow/store/action/published-local-filters"
import { useEntryStore } from "@follow/store/entry/store"
import type { EntryModel } from "@follow/store/entry/types"
import * as React from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeAll, describe, expect, it } from "vitest"

import { entryDimmedClassName } from "./styles"

const publish = (enabled: boolean) =>
  setPublishedLocalFilters({
    ownerId: "owner",
    ruleSet: {
      formatVersion: 4,
      ownerId: "owner",
      global: { markdown: "", version: 1 },
      rules: [
        {
          id: "dim",
          ownerId: "owner",
          name: "虚化",
          order: 0,
          version: 1,
          executionLocation: "processing_service",
          enabled,
          when: { anyOf: [{ allOf: [{ field: "status", operator: "eq", value: "unread" }] }] },
          actions: [{ type: "local_filter", mode: "dim" }],
        },
      ],
    },
  })

beforeAll(() => {
  ;(globalThis as typeof globalThis & { React: typeof React }).React = React
  ;(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
})
afterEach(() => clearPublishedLocalFilters())

describe("条目虚化的响应式显示", () => {
  it("标签异步到达后触发虚化，纠错或置信度不足时立即恢复显示", async () => {
    useLocalActionStore.setState({ ownerKey: "owner", isHydrated: true, rules: [] })
    useEntryStore.setState({
      data: { entry: { id: "entry", guid: "entry", feedId: "1", read: false } as EntryModel },
    })
    setPublishedLocalFilters({
      ownerId: "owner",
      ruleSet: {
        formatVersion: 5,
        ownerId: "owner",
        global: { markdown: "", version: 1 },
        rules: [
          {
            id: "dim",
            ownerId: "owner",
            name: "虚化",
            enabled: true,
            order: 0,
            version: 1,
            executionLocation: "processing_service",
            when: {
              anyOf: [
                {
                  allOf: [
                    {
                      field: "entry_tag",
                      operator: "contains_any",
                      value: ["form:pure_entertainment"],
                      minConfidence: 0.8,
                    },
                  ],
                },
              ],
            },
            actions: [{ type: "local_filter", mode: "dim" }],
          },
        ],
      },
    })
    const container = document.createElement("div")
    const root = createRoot(container)
    const Probe = ({ tags }: { tags?: TagAssessment[] }) => {
      const dimmed = useIsEntryDimmedByLocalActions("entry", tags)
      return <div className={dimmed ? entryDimmedClassName : undefined}>条目</div>
    }
    const assessment: TagAssessment = {
      tagId: "form:pure_entertainment",
      definitionVersion: 1,
      state: "present",
      confidence: 0.96,
      reason: "调侃",
      evidenceIds: ["body"],
    }
    try {
      await act(async () => root.render(<Probe />))
      expect(container.firstElementChild?.className).toBe("")
      await act(async () => root.render(<Probe tags={[assessment]} />))
      expect(container.firstElementChild?.className).toContain("grayscale")
      await act(async () => root.render(<Probe tags={[{ ...assessment, confidence: 0.78 }]} />))
      expect(container.firstElementChild?.className).toBe("")
      await act(async () => root.render(<Probe tags={[{ ...assessment, state: "absent" }]} />))
      expect(container.firstElementChild?.className).toBe("")
    } finally {
      await act(async () => root.unmount())
    }
  })

  it("发布和停用规则立即更新样式，阅读状态变化后按新条件恢复显示", async () => {
    useLocalActionStore.setState({ ownerKey: "owner", isHydrated: true, rules: [] })
    const entry = {
      id: "entry",
      guid: "entry",
      feedId: "1",
      title: "条目",
      read: false,
      insertedAt: new Date(),
      publishedAt: new Date(),
    } as EntryModel
    useEntryStore.setState({ data: { entry } })
    clearPublishedLocalFilters()
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    // 直接订阅真实规则和条目 Store，验证无需刷新页面即可改变虚化状态。
    const Probe = () => {
      const dimmed = useIsEntryDimmedByLocalActions("entry")
      return <div className={dimmed ? entryDimmedClassName : undefined}>条目</div>
    }
    try {
      await act(async () => root.render(<Probe />))
      expect(container.firstElementChild?.className).toBe("")
      await act(async () => publish(true))
      expect(container.firstElementChild?.className).toContain("grayscale")
      expect(container.firstElementChild?.className).toContain("opacity-50")
      await act(async () => useLocalActionStore.setState({ ownerKey: "other" }))
      expect(container.firstElementChild?.className).toBe("")
      await act(async () => useLocalActionStore.setState({ ownerKey: "owner" }))
      expect(container.firstElementChild?.className).toContain("grayscale")
      await act(async () => publish(false))
      expect(container.firstElementChild?.className).toBe("")
      await act(async () => publish(true))
      await act(async () => useEntryStore.setState({ data: { entry: { ...entry, read: true } } }))
      expect(container.firstElementChild?.className).toBe("")
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })
})
