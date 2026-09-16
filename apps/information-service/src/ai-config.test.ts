import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"

import { join } from "pathe"
import { afterEach, expect, it } from "vitest"

import { AIConfigStore } from "./ai-config"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
it("saves a private key atomically, retains blank keys and never exposes secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "folo-ai-config-"))
  directories.push(directory)
  const path = join(directory, "ai.json")
  const config = new AIConfigStore(path)
  await expect(config.execution()).rejects.toThrow("ai_key_required")
  expect(
    await config.save({ provider: "qianwen", model: "qwen3.8-flash", apiKey: "test-private-key" }),
  ).toEqual({ provider: "qianwen", model: "qwen3.8-flash", hasApiKey: true })
  await config.save({ provider: "qianwen", model: "qwen-test", apiKey: "" })
  expect(await config.execution()).toEqual({ apiKey: "test-private-key" })
  expect(await config.execution("codex")).toBeUndefined()
  expect((await stat(path)).mode & 0o777).toBe(0o600)
  expect(JSON.stringify(await config.publicSettings())).not.toContain("test-private-key")
  const before = await readFile(path, "utf8")
  await expect(config.save({ provider: "qianwen", model: "bad\nmodel" })).rejects.toThrow(
    "invalid_ai_config",
  )
  expect(await readFile(path, "utf8")).toBe(before)
})
