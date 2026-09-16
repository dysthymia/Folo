import type { RuleSet } from "@follow/information-core"
import { describe, expect, it, vi } from "vitest"

import {
  createProcessingClient,
  processingEditorSchema,
  processingInputWireSchema,
  processingPreviewWireSchema,
  processingReleaseWireSchema,
  ProcessingRequestError,
  processingRunSchema,
} from "./processing-client"

const ruleSet: RuleSet = {
  formatVersion: 4,
  ownerId: "owner-1",
  global: { markdown: "global", version: 1 },
  rules: [
    {
      id: "rule-1",
      ownerId: "owner-1",
      name: "Rule 1",
      enabled: true,
      order: 0,
      version: 1,
      executionLocation: "processing_service",
      when: { all: true },
      actions: [{ type: "ai_transform", prompt: "summarize" }],
    },
  ],
}

const tagId = "11111111-1111-4111-8111-111111111111"
const runId = "22222222-2222-4222-8222-222222222222"
const releaseResponse = {
  version: 2,
  draftRevision: 6,
  activationSeq: 9,
  scope: { mode: "selected" as const, inputIds: [1, 2] },
  targetInputIds: [1, 2],
  createdAt: "2026-09-11T00:00:00.000Z",
}
const editorResponse = {
  revision: 7,
  config: ruleSet,
  sources: [
    {
      key: "feed:1",
      kind: "feed" as const,
      id: "1",
      title: "Feed",
      view: 0,
      category: null,
      siteUrl: "https://example.com",
      feedUrl: "https://example.com/feed.xml",
      platform: "example.com",
    },
  ],
  items: [
    {
      id: "entry-1",
      sourceKey: "feed:1",
      title: "Entry",
      url: "https://example.com/entry-1",
      publishedAt: "2026-09-12T00:00:00.000Z",
    },
  ],
  releases: [releaseResponse],
  capabilities: { automaticProcessing: false },
  subscriptionTags: {
    formatVersion: 1 as const,
    revision: 3,
    tags: [
      {
        id: tagId,
        name: "Important",
        createdAt: "2026-09-10T00:00:00.000Z",
        updatedAt: "2026-09-10T00:00:00.000Z",
      },
    ],
  },
  sourceTags: [{ sourceKey: "feed:1", tagIds: [tagId] }],
}

const processingRun = {
  id: runId,
  kind: "manual" as const,
  dedupeKey: "manual-request",
  configRevision: 4,
  sourceKeys: ["feed:1"],
  historySince: "2026-09-01T00:00:00.000Z",
  timeZone: "Asia/Shanghai",
  scheduledFor: null,
  cutoffAt: "2026-09-12T01:00:00.000Z",
  status: "pending" as const,
  leaseToken: null,
  leaseUntil: null,
  createdAt: "2026-09-12T01:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  error: null,
}

const processingInput = {
  seq: 1,
  sourceKey: "feed:1",
  itemId: "entry-1",
  contentVersion: "sha256-content",
  receivedAt: "2026-09-12T00:00:00.000Z",
  releaseVersion: 2,
  generation: 1,
  status: "pending" as const,
  current: true,
}

const previewResponse = {
  entryId: "entry-1",
  sourceKey: "feed:1",
  material: "source_text" as const,
  input: { source_id: "feed:1", contextId: "feed:1", entry_title: "Entry" },
  metadataVersion: 3,
  global: ruleSet.global,
  matched: ruleSet.rules,
  pendingRuleIds: [],
  matches: [{ ruleId: "rule-1", state: "match" as const, groups: [] }],
  policy: {},
  display: {},
  resolvedBy: {},
  shadowed: [],
  blocksFinalPresentation: false,
  transformations: [{ ruleId: "rule-1", version: 1, order: 0, prompt: "summarize" }],
  aggregates: [],
}

describe("createProcessingClient", () => {
  it("uses same-origin OTT on every request and never writes through official Actions", async () => {
    const generate = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("token-1")
      .mockResolvedValueOnce("token-2")
      .mockResolvedValueOnce("token-3")
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_input, init) =>
        Response.json(init?.method === "PUT" ? { revision: 8, config: ruleSet } : editorResponse),
      )
    const client = createProcessingClient(generate, fetcher)

    await client.load(new AbortController().signal)
    await client.load(new AbortController().signal)
    await client.save(ruleSet, 7, new AbortController().signal)

    expect(generate).toHaveBeenCalledTimes(3)
    expect(fetcher.mock.calls[0]?.[0]).toBe("/information/v1/configuration")
    expect(fetcher.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ method: "POST", credentials: "same-origin", cache: "no-store" }),
    )
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("X-Folo-One-Time-Token")).toBe(
      "token-1",
    )
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("X-Folo-Read")).toBe("1")
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("X-Folo-One-Time-Token")).toBe(
      "token-2",
    )
    const saveCall = fetcher.mock.calls[2]
    expect(saveCall?.[0]).toBe("/information/v1/configuration")
    expect(saveCall?.[1]).toEqual(
      expect.objectContaining({
        method: "PUT",
        headers: {
          "X-Folo-One-Time-Token": "token-3",
          "Content-Type": "application/json",
        },
      }),
    )
    // 按解析后的对象断言请求体，避免 schema 解析带来的字段顺序差异掩盖契约。
    expect(JSON.parse(String(saveCall?.[1]?.body))).toEqual({
      config: ruleSet,
      expectedRevision: 7,
    })
    expect(fetcher.mock.calls.every(([path]) => !String(path).includes("actions"))).toBe(true)
  })

  it("accepts the current editor response shape, including tag revisions and disabled automation", async () => {
    const client = createProcessingClient(
      async () => "token",
      vi.fn<typeof fetch>().mockResolvedValue(Response.json(editorResponse)),
    )

    const result = await client.load(new AbortController().signal)

    expect(result).toEqual(editorResponse)
    expect(result.subscriptionTags).toEqual({
      formatVersion: 1,
      revision: 3,
      tags: [
        {
          id: tagId,
          name: "Important",
          createdAt: "2026-09-10T00:00:00.000Z",
          updatedAt: "2026-09-10T00:00:00.000Z",
        },
      ],
    })
    expect(result.sourceTags).toEqual([{ sourceKey: "feed:1", tagIds: [tagId] }])
    expect(result.capabilities.automaticProcessing).toBe(false)
    expect(processingEditorSchema.safeParse(editorResponse).success).toBe(true)
    expect(processingReleaseWireSchema.safeParse(releaseResponse).success).toBe(true)
  })

  it("accepts the complete preview response while rejecting unknown wire fields", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(previewResponse))
    const client = createProcessingClient(async () => "token", fetcher)

    await expect(
      client.preview(ruleSet, "feed:1", "entry-1", new AbortController().signal),
    ).resolves.toEqual(previewResponse)
    expect(processingPreviewWireSchema.safeParse(previewResponse).success).toBe(true)
    expect(
      processingPreviewWireSchema.safeParse({ ...previewResponse, unexpected: true }).success,
    ).toBe(false)
  })

  it("maps a 409 response to a conflict error", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: "revision_conflict" }), { status: 409 }),
      )
    const client = createProcessingClient(async () => "token", fetcher)

    await expect(client.save(ruleSet, 7, new AbortController().signal)).rejects.toEqual(
      new ProcessingRequestError("conflict"),
    )
  })

  it("stops after cancellation and does not return a write result", async () => {
    const controller = new AbortController()
    let resolveResponse: ((response: Response) => void) | undefined
    const fetcher = vi.fn<typeof fetch>(
      () => new Promise<Response>((resolve) => (resolveResponse = resolve)),
    )
    const client = createProcessingClient(async () => "token", fetcher)
    const pending = client.save(ruleSet, 7, controller.signal)
    await Promise.resolve()

    controller.abort()
    resolveResponse?.(Response.json({ revision: 8, config: ruleSet }))

    await expect(pending).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalledWith(expect.stringContaining("/actions"), expect.anything())
  })

  it("validates schedule, frozen release, run and input response contracts", async () => {
    const schedule = {
      revision: 4,
      config: {
        sourceKeys: ["feed:1"],
        historySince: "2026-09-01T00:00:00.000Z",
        timeZone: "Asia/Shanghai",
        enabled: true,
        times: ["09:00", "12:00", "15:00", "18:00", "21:00"],
        pollIntervalMinutes: 15,
        readyBy: { leadMinutes: 30 },
      },
    }
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(schedule))
      .mockResolvedValueOnce(
        Response.json({
          inputs: [processingInput],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          runs: [processingRun],
          reports: [{ triggerId: runId, report: { sources: 1 } }],
        }),
      )
      .mockResolvedValueOnce(Response.json({ ...releaseResponse, version: 3 }))
      .mockResolvedValueOnce(Response.json(processingRun))
    const client = createProcessingClient(async () => "token", fetcher)

    await expect(client.loadSchedule(new AbortController().signal)).resolves.toEqual(schedule)
    await expect(client.loadInputs(new AbortController().signal)).resolves.toEqual({
      inputs: [{ seq: 1, sourceKey: "feed:1", itemId: "entry-1", status: "pending" }],
    })
    await expect(client.loadRuns(new AbortController().signal)).resolves.toEqual({
      runs: [processingRun],
      reports: [{ triggerId: runId, report: { sources: 1 } }],
    })
    await expect(
      client.releaseRuleSet(
        4,
        { mode: "selected", inputIds: [1, 2] },
        "11111111-1111-4111-8111-111111111111",
        new AbortController().signal,
      ),
    ).resolves.toEqual({ version: 3, targetInputIds: [1, 2] })
    await expect(
      client.startRun("22222222-2222-4222-8222-222222222222", new AbortController().signal),
    ).resolves.toEqual(processingRun)
    expect(fetcher.mock.calls[3]?.[0]).toBe("/information/v1/rule-set-releases")
    expect(JSON.parse(String(fetcher.mock.calls[3]?.[1]?.body))).toEqual({
      expectedRevision: 4,
      scope: { mode: "selected", inputIds: [1, 2] },
      requestId: "11111111-1111-4111-8111-111111111111",
    })
    expect(processingRunSchema.safeParse(processingRun).success).toBe(true)
    expect(processingRunSchema.safeParse({ ...processingRun, unknown: true }).success).toBe(false)
    expect(processingInputWireSchema.safeParse(processingInput).success).toBe(true)
  })
})
