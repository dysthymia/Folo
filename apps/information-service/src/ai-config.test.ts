import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"

import { join } from "pathe"
import { afterEach, expect, it } from "vitest"

import { AIConfigStore } from "./ai-config"
import { aiReasoningEffort } from "./ai-reasoning"

const directories: string[] = []

// 测试目录由假数据提供，验证按每个模型的能力校验，而不依赖真实模型列表。
const modelCatalog = async () => ({
  source: "rpc" as const,
  fetchedAt: null,
  stale: false,
  available: true,
  models: [
    {
      id: "test-rich",
      displayName: "测试",
      description: "",
      reasoningEfforts: ["none", "low", "high", "ultra"],
      defaultReasoningEffort: "high",
    },
    {
      id: "test-small",
      displayName: "测试",
      description: "",
      reasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "high",
    },
  ],
})

it("推理强度按动态目录持久化，旧字段不采用目录default，错误不修改私有文件", async () => {
  const directory = await mkdtemp(join(tmpdir(), "folo-reasoning-config-"))
  directories.push(directory)
  const path = join(directory, "ai.json")
  const config = new AIConfigStore(path, modelCatalog)
  await config.save({ provider: "codex", model: "test-rich" })
  expect(await config.publicSettings()).not.toHaveProperty("reasoningEffort")
  expect(aiReasoningEffort(await config.read())).toBe("low")
  await config.save({ provider: "codex", model: "test-rich", reasoningEffort: "ultra" })
  expect(await config.publicSettings()).toMatchObject({ reasoningEffort: "ultra" })
  const snapshot = await config.read()
  expect(snapshot.reasoningEffort).toBe("ultra")
  const before = await readFile(path, "utf8")
  for (const input of [
    { provider: "codex", model: "test-small", reasoningEffort: "ultra" },
    { provider: "codex", model: "unknown-model", reasoningEffort: "high" },
    { provider: "qianwen", model: "qwen-test", reasoningEffort: "low", apiKey: "fake" },
    {
      provider: "openai-compatible",
      model: "test",
      baseUrl: "https://fake.test/v1",
      reasoningEffort: "ultra",
      apiKey: "fake",
    },
  ]) {
    await expect(config.save(input)).rejects.toThrow("unsupported_reasoning_effort")
    expect(await readFile(path, "utf8")).toBe(before)
  }
  await config.save({ provider: "codex", model: "test-rich", reasoningEffort: "none" })
  expect(aiReasoningEffort(await config.read())).toBe("none")
  expect(aiReasoningEffort(snapshot)).toBe("ultra")
  const unavailable = new AIConfigStore(path, async () => ({
    models: [],
    source: "cache",
    fetchedAt: null,
    stale: true,
    available: false,
  }))
  await expect(
    unavailable.save({ provider: "codex", model: "test-rich", reasoningEffort: "high" }),
  ).rejects.toThrow("model_catalog_unavailable")
})
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

it("自定义端点绑定密钥，地址改变不能继承旧密钥，公开响应不含凭据", async () => {
  const directory = await mkdtemp(join(tmpdir(), "folo-custom-config-"))
  directories.push(directory)
  const config = new AIConfigStore(join(directory, "ai.json"))
  await config.save({ provider: "qianwen", model: "qwen-test", apiKey: "old-qwen-key" })
  await expect(
    config.save({
      provider: "openai-compatible",
      model: "custom-model",
      baseUrl: "https://gateway.test/v1",
    }),
  ).rejects.toThrow("ai_key_required")
  const publicSettings = await config.save({
    provider: "openai-compatible",
    model: "custom-model",
    baseUrl: "https://gateway.test/v1/",
    apiKey: "new-private-key",
  })
  expect(publicSettings).toEqual({
    provider: "openai-compatible",
    model: "custom-model",
    baseUrl: "https://gateway.test/v1",
    hasApiKey: true,
  })
  expect(JSON.stringify(publicSettings)).not.toContain("new-private-key")
  await config.save({
    provider: "openai-compatible",
    model: "new-model",
    baseUrl: "https://gateway.test/v1",
    apiKey: "",
  })
  expect(await config.execution(await config.read())).toEqual({
    apiKey: "new-private-key",
    baseUrl: "https://gateway.test/v1",
    provider: "openai-compatible",
  })
  await expect(config.execution("qianwen")).rejects.toThrow("ai_config_changed")
  await expect(
    config.execution("openai-compatible", "https://another.test/v1", "new-model"),
  ).rejects.toThrow("ai_config_changed")
  await expect(
    config.execution("openai-compatible", "https://gateway.test/v1", "old-model"),
  ).rejects.toThrow("ai_config_changed")
  await expect(
    config.save({
      provider: "openai-compatible",
      model: "new-model",
      baseUrl: "https://another.test/v1",
      apiKey: "",
    }),
  ).rejects.toThrow("ai_key_required")
  await expect(
    config.save({ provider: "qianwen", model: "qwen-test", apiKey: "" }),
  ).rejects.toThrow("ai_key_required")
  expect((await config.read()).baseUrl).toBe("https://gateway.test/v1")
})

it("执行直接使用同次读取的私有配置快照，后续同provider换域名不会拼接新密钥", async () => {
  const directory = await mkdtemp(join(tmpdir(), "folo-config-snapshot-"))
  directories.push(directory)
  const config = new AIConfigStore(join(directory, "ai.json"))
  await config.save({
    provider: "openai-compatible",
    model: "old-model",
    baseUrl: "https://old.test/v1",
    apiKey: "old-key",
  })
  const snapshot = await config.read()
  await config.save({
    provider: "openai-compatible",
    model: "new-model",
    baseUrl: "https://new.test/v1",
    apiKey: "new-key",
  })
  expect(await config.execution(snapshot)).toEqual({
    apiKey: "old-key",
    baseUrl: "https://old.test/v1",
    provider: "openai-compatible",
  })
  await expect(
    config.execution("openai-compatible", snapshot.baseUrl, snapshot.model),
  ).rejects.toThrow("ai_config_changed")
})

it("自定义地址必须是无内嵌凭据、查询和片段的HTTP根地址", async () => {
  const directory = await mkdtemp(join(tmpdir(), "folo-config-url-"))
  directories.push(directory)
  const config = new AIConfigStore(join(directory, "ai.json"))
  for (const baseUrl of [
    "file:///tmp/data",
    "https://key:secret@gateway.test/v1",
    "https://gateway.test/v1?key=secret",
    "https://gateway.test/v1#secret",
    "not-a-url",
  ]) {
    await expect(
      config.save({ provider: "openai-compatible", model: "custom", baseUrl, apiKey: "private" }),
    ).rejects.toThrow("invalid_ai_config")
  }
  await expect(
    config.save({ provider: "openai-compatible", model: "custom", apiKey: "private" }),
  ).rejects.toThrow("invalid_ai_config")
})
