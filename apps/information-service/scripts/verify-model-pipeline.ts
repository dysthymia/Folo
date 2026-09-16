import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"

import { join, resolve } from "pathe"

import { AIConfigStore } from "../src/ai-config"
import { runEntryProcessing } from "../src/processing-engine"
import { errorCode } from "../src/service"
import { Store } from "../src/store"
import { runStoryAggregation } from "../src/story-engine"

// 显式运行的合成材料端到端验证，不接触用户订阅队列，也不伪装新闻质量验收。
const [configPath, outputPath] = process.argv.slice(2)
if (!configPath || !outputPath)
  throw new Error("usage: verify-model-pipeline <private-ai-config> <new-output-directory>")
const directory = resolve(outputPath)
await mkdir(directory, { mode: 0o700, recursive: false })
const store = new Store(join(directory, "verification.sqlite"))
const aiConfig = new AIConfigStore(resolve(configPath))
const signal = AbortSignal.timeout(180_000)
try {
  store.bindOwner("synthetic-verification")
  const sources = [1, 2].map((id) => ({
    key: `feed/fixture-${id}`,
    id: `fixture-${id}`,
    kind: "feed" as const,
    title: `合成测试来源 ${id}`,
    view: 0,
    category: "验证",
  }))
  store.replaceSources(sources)
  store.sourceSync.replaceSources(sources, new Date().toISOString())
  const content = [
    "合成测试材料：星桥实验室宣布，将于2026年10月1日在海城图书馆启动开放资料计划，首批开放120份历史档案。计划只提供免费阅读，不涉及投资产品。",
    "合成测试材料：海城图书馆确认，星桥实验室的开放资料计划将于2026年10月1日启动，首批资料为120份历史档案。图书馆补充，开放时间为每日上午9点至下午5点，读者无需预约。",
  ]
  for (let index = 0; index < sources.length; index++) {
    const source = sources[index]!
    store.saveEntry({
      sourceKey: source.key,
      id: `fixture-entry-${index}`,
      feedId: source.id,
      title: "合成验证：开放资料计划",
      url: null,
      publishedAt: "2026-09-12T00:00:00Z",
      read: true,
      content: content[index]!,
      description: null,
    })
    store.processingState.setMaterial(
      store.automation.current(source.key, `fixture-entry-${index}`)!,
      "complete",
    )
  }
  const draft = store.automation.draft()
  const saved = store.automation.saveDraft(
    {
      ...draft.config,
      global: {
        version: 1,
        markdown:
          "这些是合成测试材料，不是真实新闻。逐篇保留可核查事实，标记keep、允许综合和改写；不要输出外部知识。两篇描述同一事件，请保留第二篇独有的时间和预约信息。",
      },
      rules: [
        {
          id: randomUUID(),
          ownerId: draft.config.ownerId,
          name: "同事件合成验证",
          version: 1,
          order: 0,
          enabled: true,
          executionLocation: "processing_service",
          when: { all: true },
          actions: [
            {
              type: "ai_aggregate",
              mode: "same_event",
              scope: { all: true },
              createPrompt:
                "把同一开放资料计划的两篇合成材料合并为一个Story。每个事实要给出材料中的逐字引用，不遗漏图书馆补充的开放时间和无需预约。",
              updatePrompt: "保留已验证事实与引用，加入新增事实。",
            },
          ],
        },
      ],
    },
    draft.revision,
  )
  store.automation.publish(saved.revision, { mode: "future" }, randomUUID())
  const entries = await runEntryProcessing({
    store,
    aiConfig,
    runtimeDir: directory,
    sourceKeys: sources.map((source) => source.key),
    historySince: "2026-09-01T00:00:00Z",
    signal,
  })
  const ruleSet = store.automation.release(1)!
  const stories = await runStoryAggregation({
    decisions: store.processingState.published(),
    ruleSet,
    stories: store.stories,
    aiConfig,
    runtimeDir: directory,
    signal,
  })
  const settings = await aiConfig.publicSettings()
  const report = {
    synthetic: true,
    provider: settings.provider,
    model: settings.model,
    entries,
    stories,
    verified:
      entries.completed === 2 &&
      !entries.failures.length &&
      stories.created.length === 1 &&
      !stories.failures.length,
  }
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 })
  process.stdout.write(`${JSON.stringify(report)}\n`)
  if (!report.verified) process.exitCode = 1
} catch (error) {
  process.stdout.write(`${JSON.stringify({ verified: false, error: errorCode(error) })}\n`)
  process.exitCode = 1
} finally {
  store.close()
}
