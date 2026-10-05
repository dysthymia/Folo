import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"

import { join } from "pathe"
import { afterEach, describe, expect, it } from "vitest"

import { readModelCatalog } from "./model-catalog"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
const visible = {
  id: "test-codex",
  model: "test-codex",
  displayName: "测试模型",
  description: "目录测试",
  hidden: false,
  defaultReasoningEffort: "low",
  supportedReasoningEfforts: [{ reasoningEffort: "low", description: "快" }],
  inputModalities: ["text"],
  privateExtra: "never-return",
}
const cached = {
  slug: "cached-codex",
  display_name: "缓存模型",
  visibility: "list",
  description: "本机缓存",
  supported_in_api: true,
  default_reasoning_level: "medium",
  supported_reasoning_levels: [{ effort: "medium" }],
  input_modalities: ["text"],
  privateExtra: "never-return",
}
async function fixture(script: string) {
  const directory = await mkdtemp(join(tmpdir(), "folo-catalog-test-"))
  directories.push(directory)
  const command = join(directory, "fake-codex")
  const calls = join(directory, "calls.jsonl")
  const cachePath = join(directory, "models_cache.json")
  // 假CLI只接受初始化和列模型，任何thread/turn方法都立即失败，不读取登录或真实模型。
  await writeFile(
    command,
    `#!${process.execPath}\nconst fs = require('node:fs');\nconst emit = (value) => process.stdout.write(JSON.stringify(value) + '\\n');\nconst lines = require('node:readline').createInterface({ input: process.stdin });\nlines.on('line', (line) => {\n const request = JSON.parse(line);\n fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ method: request.method, home: process.env.CODEX_HOME, args: process.argv.slice(2), hasKey: Boolean(process.env.OPENAI_API_KEY) }) + '\\n');\n if (request.method === 'initialize') emit({ id: 1, result: { userAgent: 'fake' } });\n else if (request.method === 'initialized') {}\n else if (request.method === 'model/list') { ${script} }\n else process.exit(9);\n});\n`,
  )
  await chmod(command, 0o700)
  await writeFile(
    cachePath,
    JSON.stringify({
      fetched_at: "2026-10-01T00:00:00Z",
      models: [
        cached,
        { ...cached, slug: "hidden", visibility: "hide" },
        { ...cached, slug: "not-api", supported_in_api: false },
      ],
      identity: "must-not-return",
    }),
  )
  return { directory, command, calls, cachePath }
}

describe("Codex动态模型目录", () => {
  it("优先正式RPC、过滤隐藏模型、白名单输出且不启动推理或加载全局配置", async () => {
    const f = await fixture(
      `emit({ id: 2, result: { data: ${JSON.stringify([visible, { ...visible, id: "hidden", model: "hidden", hidden: true }])}, nextCursor: null } });`,
    )
    const result = await readModelCatalog({ command: f.command, cachePath: f.cachePath })
    expect(result).toMatchObject({
      source: "rpc",
      stale: false,
      available: true,
      models: [
        {
          id: "test-codex",
          displayName: "测试模型",
          description: "目录测试",
          reasoningEfforts: ["low"],
          defaultReasoningEffort: "low",
        },
      ],
    })
    expect(result.fetchedAt).toMatch(/^\d{4}-/u)
    expect(JSON.stringify(result)).not.toContain("never-return")
    const calls = (await readFile(f.calls, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as { method: string; home: string; hasKey: boolean; args: string[] },
      )
    expect(calls.map((call) => call.method)).toEqual(["initialize", "initialized", "model/list"])
    expect(calls[0]?.args).toEqual(["app-server", "--listen", "stdio://"])
    expect(calls[0]?.home).toContain("folo-model-catalog-")
    expect(calls[0]?.hasKey).toBe(false)
  })

  it("RPC不可用时明确返回stale缓存，不曝光身份元数据或隐藏模型", async () => {
    const f = await fixture("process.exit(2);")
    const result = await readModelCatalog({ command: f.command, cachePath: f.cachePath })
    expect(result).toMatchObject({
      source: "cache",
      fetchedAt: "2026-10-01T00:00:00Z",
      stale: true,
      available: true,
      error: "model_catalog_unavailable",
      models: [{ id: "cached-codex" }],
    })
    expect(result.models).toHaveLength(1)
    expect(JSON.stringify(result)).not.toMatch(/must-not-return|never-return/u)
  })

  it("超时中止进程，无缓存时给固定code和空目录而非硬编码模型", async () => {
    const f = await fixture("")
    const result = await readModelCatalog({
      command: f.command,
      cachePath: join(f.directory, "missing"),
      timeoutMs: 100,
    })
    expect(result).toEqual({
      models: [],
      source: "cache",
      fetchedAt: null,
      stale: true,
      available: false,
      error: "model_catalog_timeout",
    })
  })

  it("无效或过大响应不能回显原始错误及敏感字段", async () => {
    for (const script of [
      "emit({id:2,error:{code:500,message:'secret-upstream-key'}});",
      "process.stdout.write('x'.repeat(1024*1024+1));",
    ]) {
      const f = await fixture(script)
      const result = await readModelCatalog({ command: f.command, cachePath: f.cachePath })
      expect(result.source).toBe("cache")
      expect(result.error).toMatch(/^model_catalog_/u)
      expect(JSON.stringify(result)).not.toContain("secret-upstream-key")
    }
  })
})
