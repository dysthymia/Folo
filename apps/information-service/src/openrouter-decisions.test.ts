import { describe, expect, it, vi } from "vitest"

import { DECISIONS_CANONICAL_MODEL, DECISIONS_ENDPOINT } from "./decisions-config"
import type { DecisionQuestion } from "./openrouter-decisions"
import { parseDecisionsResponse, requestDecisions } from "./openrouter-decisions"

const questions: Record<string, DecisionQuestion> = {
  tag: { type: "noul", instructions: "Is AI discussed?" },
  evidence: {
    type: "choice",
    instructions: "Choose support.",
    criteria: { E1: "Fragment E1", none: "No support" },
  },
  importance: {
    type: "score",
    instructions: "Rank importance.",
    criteria: ["low", "medium", "high"],
  },
}
const fixture = () => ({
  id: "fixture-request",
  model: DECISIONS_CANONICAL_MODEL,
  provider: "OpenAI",
  answers: {
    tag: { type: "noul", noul: 0.98 },
    evidence: { type: "choice", choice: "E1" },
    importance: { type: "score", score: 1.99 },
  },
  usage: { input_tokens: 400, output_tokens: 20, cost: 0.00004 },
})
describe("OpenRouter dedicated Decisions protocol", () => {
  it("posts state/questions to the dedicated endpoint and accepts absent optional metrics", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(fixture())))
    const result = await requestDecisions({
      apiKey: "fixture-key",
      state: { article: "AI" },
      questions,
      signal: new AbortController().signal,
      fetcher,
    })
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(DECISIONS_ENDPOINT)
    expect(init.redirect).toBe("error")
    const body = JSON.parse(String(init.body))
    expect(body).toMatchObject({ state: { article: "AI" }, questions })
    expect(body).not.toHaveProperty("messages")
    expect(result.answers.importance).toMatchObject({ score: 1.99 })
    expect(result.usage.cost).toBe(0.00004)
  })
  it.each([
    (value: ReturnType<typeof fixture>) => {
      delete (value.answers as Partial<typeof value.answers>).tag
    },
    (value: ReturnType<typeof fixture>) => {
      value.answers.tag.noul = 2
    },
    (value: ReturnType<typeof fixture>) => {
      value.answers.tag.type = "predicate"
    },
    (value: ReturnType<typeof fixture>) => {
      value.answers.evidence.choice = "foreign"
    },
    (value: ReturnType<typeof fixture>) => {
      value.answers.importance.score = 2.1
    },
    (value: ReturnType<typeof fixture>) => {
      value.provider = "Other"
    },
    (value: ReturnType<typeof fixture>) => {
      value.model = "chat-model"
    },
  ])("rejects malformed identities, types and values while retaining usage", (mutate) => {
    const value = fixture()
    mutate(value)
    expect(() => parseDecisionsResponse(value, questions)).toThrow("invalid_response")
    try {
      parseDecisionsResponse(value, questions)
    } catch (error) {
      expect(error).toMatchObject({ usage: value.usage })
    }
  })
  it("rejects extra answer IDs and invalid optional probability keys / legends", () => {
    const value = fixture()
    expect(() =>
      parseDecisionsResponse(
        { ...value, answers: { ...value.answers, extra: value.answers.tag } },
        questions,
      ),
    ).toThrow()
    expect(() =>
      parseDecisionsResponse(
        {
          ...value,
          answers: {
            ...value.answers,
            evidence: { ...value.answers.evidence, probabilities: { wrong: 1 } },
          },
        },
        questions,
      ),
    ).toThrow()
    expect(() =>
      parseDecisionsResponse(
        {
          ...value,
          answers: {
            ...value.answers,
            importance: {
              ...value.answers.importance,
              legend: { "0": "bad", "1": "medium", "2": "high" },
            },
          },
        },
        questions,
      ),
    ).toThrow()
  })
  it("retains score units and checks probability-weighted positions only when supplied", () => {
    const value = fixture()
    const valid = {
      ...value,
      answers: {
        ...value.answers,
        importance: { type: "score", score: 1.99, probabilities: { "0": 0, "1": 0.01, "2": 0.99 } },
      },
    }
    expect(parseDecisionsResponse(valid, questions).answers.importance).toMatchObject({
      score: 1.99,
    })
    expect(() =>
      parseDecisionsResponse(
        {
          ...valid,
          answers: { ...valid.answers, importance: { ...valid.answers.importance, score: 0.2 } },
        },
        questions,
      ),
    ).toThrow("invalid_response")
    expect(() =>
      parseDecisionsResponse(
        {
          ...value,
          answers: {
            ...value.answers,
            tag: { ...value.answers.tag, probabilities: { true: 0.02, false: 0.98 } },
          },
        },
        questions,
      ),
    ).toThrow("invalid_response")
    expect(() =>
      parseDecisionsResponse(
        {
          ...value,
          answers: { ...value.answers, tag: { ...value.answers.tag, refusal: "declined" } },
        },
        questions,
      ),
    ).toThrow("invalid_response")
  })
  it.each([401, 402, 429, 503])("sanitizes HTTP %s without retries", async (status) => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "secret-key private-article" } }), {
          status,
        }),
    )
    await expect(
      requestDecisions({
        apiKey: "secret-key",
        state: {},
        questions,
        signal: new AbortController().signal,
        fetcher,
      }),
    ).rejects.toMatchObject({ code: "http_error", status, usage: null })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it("rejects oversize requests before transport and sanitizes network errors", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("private-key")
    })
    await expect(
      requestDecisions({
        apiKey: "key",
        state: { text: "x".repeat(140_000) },
        questions,
        signal: new AbortController().signal,
        fetcher,
      }),
    ).rejects.toThrow("request_limit")
    expect(fetcher).not.toHaveBeenCalled()
    await expect(
      requestDecisions({
        apiKey: "key",
        state: {},
        questions,
        signal: new AbortController().signal,
        fetcher,
      }),
    ).rejects.toThrow("network_error")
  })
  it("rejects refusal and too many questions; preserves missing cost as unknown", async () => {
    expect(() => parseDecisionsResponse({ refusal: "No decision" }, questions)).toThrow(
      "invalid_response",
    )
    const value = fixture()
    const result = parseDecisionsResponse(
      { ...value, usage: { input_tokens: 1, output_tokens: 0 } },
      questions,
    )
    expect(result.usage.cost).toBeUndefined()
    const fetcher = vi.fn(async () => new Response(JSON.stringify(value)))
    await expect(
      requestDecisions({
        apiKey: "key",
        state: {},
        questions: Object.fromEntries(
          Array.from({ length: 201 }, (_, index) => [String(index), questions.tag!]),
        ),
        signal: new AbortController().signal,
        fetcher,
      }),
    ).rejects.toThrow("request_limit")
    expect(fetcher).not.toHaveBeenCalled()
  })
  it("cancels at the timeout without a retry", async () => {
    const timeoutController = new AbortController()
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal)
    try {
      const fetcher = vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal!.addEventListener(
              "abort",
              () => reject(new Error("private timeout details")),
              { once: true },
            )
          }),
      )
      const promise = requestDecisions({
        apiKey: "key",
        state: {},
        questions,
        signal: new AbortController().signal,
        fetcher,
      })
      const rejected = expect(promise).rejects.toThrow("network_error")
      expect(timeout).toHaveBeenCalledWith(30_000)
      timeoutController.abort()
      await rejected
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally {
      timeout.mockRestore()
    }
  })
})
