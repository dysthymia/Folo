import { afterEach, describe, expect, it, vi } from "vitest"

import {
  correctProcessingEvent,
  entryEventsSchema,
  eventCorrectionActionSchema,
  eventMembersSchema,
  loadEventDetail,
  loadEventMembers,
  searchProcessingEvents,
} from "./processing-event-client"
import { readingRequest } from "./processing-reader-client"

vi.mock("./processing-reader-client", () => ({ readingRequest: vi.fn() }))
afterEach(() => vi.clearAllMocks())
const event = {
  id: "evt_a",
  title: "Event",
  aliases: [],
  status: "candidate",
  revision: 1,
  mergedInto: null,
  splitInto: [],
  identity: { kind: "product_change" },
}
describe("processing event client", () => {
  it("要求文章版本/决定并保留额外registry身份字段", () => {
    expect(
      entryEventsSchema.parse({
        inputSeq: 1,
        contentVersion: "v1",
        decisionId: "d1",
        events: [
          {
            event,
            mentionId: "m1",
            role: "reports",
            isPrimary: true,
            state: "candidate",
            evidence: ["Quote"],
          },
        ],
      }).events[0]!.event.identity,
    ).toEqual({ kind: "product_change" })
    expect(entryEventsSchema.safeParse({ events: [] }).success).toBe(false)
    expect(
      eventMembersSchema.safeParse({ snapshotId: "invalid", rows: [], total: 0, nextOffset: null })
        .success,
    ).toBe(false)
  })
  it("路径编码并保留角色、成员快照和分页偏移", async () => {
    const signal = new AbortController().signal
    await loadEventDetail("event/a", signal)
    expect(readingRequest).toHaveBeenLastCalledWith(
      "processing/events/event%2Fa",
      expect.anything(),
      signal,
    )
    await searchProcessingEvents({ search: "Product", offset: 0, limit: 20 }, signal)
    expect(readingRequest).toHaveBeenLastCalledWith(
      "processing/events",
      expect.anything(),
      signal,
      { search: "Product", offset: 0, limit: 20 },
    )
    const query = {
      role: "tutorial_for" as const,
      state: "confirmed" as const,
      snapshotId: "11111111-1111-4111-8111-111111111111",
      offset: 20,
      limit: 20,
    }
    await loadEventMembers("evt_a", query, signal)
    expect(readingRequest).toHaveBeenLastCalledWith(
      "processing/events/evt_a/members",
      expect.anything(),
      signal,
      query,
    )
  })
  it("六种纠错保留revision及mention身份，拆分允许同文章不同mention", async () => {
    const signal = new AbortController().signal
    for (const raw of [
      { type: "rename", title: "Rename" },
      { type: "exclude", inputSeq: 1, mentionId: "m1" },
      { type: "move", inputSeq: 1, mentionId: "m1", targetEventId: "evt_b" },
      { type: "merge", targetEventId: "evt_b" },
      {
        type: "split",
        groups: [
          { title: "First", members: [{ inputSeq: 1, mentionId: "m1" }] },
          { title: "Second", members: [{ inputSeq: 1, mentionId: "m2" }] },
        ],
      },
      { type: "undo", correctionId: "22222222-2222-4222-8222-222222222222" },
    ]) {
      const action = eventCorrectionActionSchema.parse(raw)
      await correctProcessingEvent("evt_a", { evt_a: 2, evt_b: 1 }, action, signal)
      expect(readingRequest).toHaveBeenLastCalledWith(
        "processing/events/evt_a/corrections",
        expect.anything(),
        signal,
        { requestId: expect.any(String), expectedRevisions: { evt_a: 2, evt_b: 1 }, action },
      )
    }
    expect(eventCorrectionActionSchema.safeParse({ type: "exclude", inputSeq: 1 }).success).toBe(
      false,
    )
    expect(
      eventCorrectionActionSchema.safeParse({
        type: "split",
        groups: [
          { title: "First", inputSeqs: [1] },
          { title: "Second", inputSeqs: [2] },
        ],
      }).success,
    ).toBe(false)
  })
})
