import { randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"

import { join, resolve } from "pathe"

import { AIConfigStore } from "../src/ai-config"
import type { CodexJsonOptions } from "../src/codex"
import { runCodexJson } from "../src/codex"
import { errorCode } from "../src/service"
import { Store } from "../src/store"
import { runStoryAggregation } from "../src/story-engine"

// 复用合成验证库中已完成的单篇结果，仅重试 Story，不重复支付单篇调用。
const [configPath, directoryPath] = process.argv.slice(2)
if (!configPath || !directoryPath)
  throw new Error("usage: verify-story-resume <private-ai-config> <verification-directory>")
const directory = resolve(directoryPath)
const store = new Store(join(directory, "verification.sqlite"))
const failures: string[] = []
async function execute<T>(options: CodexJsonOptions<T>) {
  try {
    return await runCodexJson(options)
  } catch (error) {
    failures.push(errorCode(error))
    throw error
  }
}
try {
  if (store.ownerId !== "synthetic-verification") throw new Error("synthetic_database_required")
  const release = store.automation.releases()[0]!
  const result = await runStoryAggregation({
    decisions: store.processingState.published(),
    ruleSet: store.automation.release(release.version)!,
    stories: store.stories,
    aiConfig: new AIConfigStore(resolve(configPath)),
    runtimeDir: directory,
    signal: AbortSignal.timeout(180000),
    execute,
  })
  const report = {
    synthetic: true,
    at: new Date().toISOString(),
    result,
    failures,
    verified: result.created.length + result.updated.length > 0 && result.failures.length === 0,
  }
  await writeFile(
    join(directory, `story-retry-${randomUUID()}.json`),
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  )
  process.stdout.write(`${JSON.stringify(report)}\n`)
  if (!report.verified) process.exitCode = 1
} finally {
  store.close()
}
