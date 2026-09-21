import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { ProcessingConditionEditor } from "./processing-condition-editor"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { ownerId?: string }) =>
      values?.ownerId ? `${key}:${values.ownerId}` : key,
  }),
}))

const sources = [
  {
    key: "list/known",
    id: "known",
    kind: "list" as const,
    title: "Known",
    view: 0,
    category: null,
  },
  {
    key: "list/unknown",
    id: "unknown",
    kind: "list" as const,
    title: "Unknown",
    view: 0,
    category: null,
  },
]

describe("ProcessingConditionEditor List options", () => {
  it("保留已消失分类旧值并明确标记待修复，未知清单不伪造缺失", () => {
    const categorySources = [
      {
        key: "feed/current",
        id: "current",
        kind: "feed" as const,
        title: "Current",
        view: 0,
        category: "新分类",
      },
    ]
    const condition = {
      anyOf: [
        {
          allOf: [
            {
              field: "category_ref" as const,
              operator: "eq" as const,
              value: { view: 0, name: "旧分类" },
            },
          ],
        },
      ],
    }
    const missing = renderToStaticMarkup(
      <ProcessingConditionEditor
        value={condition}
        onChange={vi.fn()}
        sources={categorySources}
        sourceInventoryKnown
      />,
    )
    expect(missing).toContain("旧分类")
    expect(missing).toContain("新分类")
    expect(missing).toContain("processing.category_identity_missing")
    expect(missing).toContain("processing.category_identity_repair")

    const unknown = renderToStaticMarkup(
      <ProcessingConditionEditor
        value={condition}
        onChange={vi.fn()}
        sources={[]}
        sourceInventoryKnown={false}
      />,
    )
    expect(unknown).toContain("processing.category_identity_unknown")
    expect(unknown).toContain("processing.category_identity_unverified")
    expect(unknown).not.toContain("processing.category_identity_repair")
  })

  it("enables only complete persisted memberships and shows unknown explicitly", () => {
    const html = renderToStaticMarkup(
      <ProcessingConditionEditor
        value={{ anyOf: [{ allOf: [{ field: "list_id", operator: "in", value: [] }] }] }}
        onChange={vi.fn()}
        sources={sources}
        listMemberships={[
          {
            listKey: "list/known",
            ownerId: "owner-known",
            feedIds: ["f1"],
            complete: true,
            status: "complete",
            revision: 2,
            syncedAt: "2026-09-19T00:00:00.000Z",
          },
          {
            listKey: "list/unknown",
            ownerId: null,
            feedIds: ["f2"],
            complete: true,
            status: "unknown",
            revision: 3,
            syncedAt: "2026-09-18T00:00:00.000Z",
          },
        ]}
      />,
    )

    expect(html).toContain('value="known"')
    expect(html).toContain('value="unknown" disabled=""')
    expect(html).toContain("processing.list_membership_complete")
    expect(html).toContain("processing.list_membership_unknown")
    expect(html).toContain("owner-known")
    expect(html).toContain("processing.list_owner_unknown")
  })
})
