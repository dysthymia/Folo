import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"

import { join } from "pathe"
import { afterEach, expect, it, vi } from "vitest"

import { AIConfigStore } from "./ai-config"
import { FoloChat } from "./chat"
import type { CodexJsonOptions } from "./codex"
import { FoloReader } from "./folo"
import { Store } from "./store"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "folo-chat-"))
  const store = new Store(":memory:")
  const config = new AIConfigStore(join(directory, "ai.json"))
  await config.save({ provider: "qianwen", model: "qwen3.8-flash", apiKey: "test-only-key" })
  const reader = new FoloReader({ apiUrl: "https://api.folo.is", token: "unused" })
  const read = vi.fn(async () => reader)
  let observed: CodexJsonOptions<unknown> | undefined
  const execute = async <T>(options: CodexJsonOptions<T>) => {
    observed = options
    const result: unknown = { answer: "测试回复" }
    if (!options.validate(result)) throw new Error("invalid_test_result")
    return { result, model: options.model, durationMs: 1, usage: null, toolCalls: 0 }
  }
  const chat = new FoloChat({
    store,
    aiConfig: config,
    reader: read,
    runtimeDir: directory,
    execute,
  })
  cleanups.push(async () => {
    store.close()
    await rm(directory, { recursive: true, force: true })
  })
  return { store, chat, reader, read, observed: () => observed }
}

it("聊天沿用后台模型和 CLI，保留对话但剔除编辑器状态与历史工具负载", async () => {
  const f = await fixture()
  const result = await f.chat.run(
    {
      model: "ignored-client-model",
      messages: [
        { role: "user", parts: [{ type: "text", text: "之前的问题" }] },
        {
          role: "assistant",
          parts: [
            { type: "text", text: "之前的回答" },
            { type: "tool-private", output: "ignored-tool-payload" },
          ],
        },
        {
          role: "user",
          parts: [
            { type: "data-rich-text", data: { text: "继续回答", state: "ignored-editor-state" } },
            {
              type: "data-block",
              data: [
                { type: "mainEntry", value: "disabled-entry", disabled: true },
                {
                  type: "fileAttachment",
                  attachment: { serverUrl: "https://example.com/private" },
                },
              ],
            },
          ],
        },
      ],
    },
    new AbortController().signal,
  )
  expect(result.model).toBe("qwen3.8-flash")
  expect(f.observed()?.qianwen).toEqual({ apiKey: "test-only-key" })
  expect(f.observed()?.prompt).toContain("之前的回答")
  expect(f.observed()?.prompt).toContain("附件尚未解析")
  expect(f.observed()?.prompt).not.toMatch(
    /ignored-editor-state|ignored-tool-payload|test-only-key|https:\/\/example.com\/private/,
  )
  expect(f.read).not.toHaveBeenCalled()
})

it("当前文章通过主站验证归属后补全正文；缺失正文不伪装成全文", async () => {
  const f = await fixture()
  vi.spyOn(f.reader, "session").mockResolvedValue({ ownerId: "owner", expiresAt: null })
  vi.spyOn(f.reader, "sources").mockResolvedValue([
    { key: "feed/1", kind: "feed", id: "1", title: "Feed", view: 0, category: null },
  ])
  vi.spyOn(f.reader, "chatEntry").mockResolvedValue({
    id: "1",
    sourceKey: "feed/1",
    title: "文章",
    url: null,
    publishedAt: "2026-09-10",
    read: false,
    content: null,
    description: "仅描述",
  })
  vi.spyOn(f.reader, "readability").mockResolvedValue(null)
  await f.chat.run(
    {
      messages: [
        {
          role: "user",
          parts: [
            { type: "text", text: "总结" },
            { type: "data-block", data: [{ type: "mainEntry", value: "1" }] },
          ],
        },
      ],
    },
    new AbortController().signal,
  )
  expect(f.observed()?.prompt).toContain('"material":"description_only"')
  expect(f.observed()?.prompt).toContain("仅描述")
  expect(f.store.ownerId).toBe("owner")
})

it("无效与过大上下文在运行 CLI 前被拒绝", async () => {
  const f = await fixture()
  await expect(f.chat.run({ messages: [] }, new AbortController().signal)).rejects.toThrow(
    "invalid_chat",
  )
  await expect(
    f.chat.run(
      { messages: [{ role: "user", parts: [{ type: "text", text: "a".repeat(120001) }] }] },
      new AbortController().signal,
    ),
  ).rejects.toThrow("chat_context_too_large")
  expect(f.observed()).toBeUndefined()
})
