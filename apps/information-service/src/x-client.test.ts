import { expect, it } from "vitest"

import { XRecentSearchClient } from "./x-client"

it("固定官方 origin 并传递 recent search、since_id 与 next_token", async () => {
  let requested: RequestInfo | URL | undefined
  const fetch: typeof globalThis.fetch = async (request) => {
    requested = request
    return new Response(
      JSON.stringify({
        data: [{ id: "9", text: "hello", created_at: "2026-09-12T00:00:00Z", author_id: "u" }],
        includes: { users: [{ id: "u", username: "alice" }] },
        meta: { newest_id: "9" },
      }),
    )
  }
  const client = new XRecentSearchClient("token", fetch)
  await expect(
    client.search({ query: "folo", sinceId: "8", nextToken: "next", maxResults: 100 }),
  ).resolves.toMatchObject({ posts: [{ id: "9", authorUsername: "alice" }] })
  const url = new URL(String(requested))
  expect(url.origin).toBe("https://api.x.com")
  expect(url.pathname).toBe("/2/tweets/search/recent")
  expect(url.searchParams.get("query")).toBe("folo")
  expect(url.searchParams.get("since_id")).toBe("8")
  expect(url.searchParams.get("next_token")).toBe("next")
})

it("空结果、429 reset 与授权错误保持明确状态", async () => {
  const empty = new XRecentSearchClient("t", async () => new Response(JSON.stringify({ meta: {} })))
  await expect(
    empty.search({ query: "x", sinceId: null, nextToken: null, maxResults: 100 }),
  ).resolves.toMatchObject({ posts: [], nextToken: null })
  const limited = new XRecentSearchClient(
    "t",
    async () => new Response("", { status: 429, headers: { "x-rate-limit-reset": "1780000000" } }),
  )
  await expect(
    limited.search({ query: "x", sinceId: null, nextToken: null, maxResults: 100 }),
  ).rejects.toMatchObject({
    status: "rate_limited",
    retryAt: "2026-05-28T20:26:40.000Z",
  })
  const denied = new XRecentSearchClient("t", async () => new Response("", { status: 401 }))
  await expect(
    denied.search({ query: "x", sinceId: null, nextToken: null, maxResults: 100 }),
  ).rejects.toMatchObject({ status: "forbidden" })
})
