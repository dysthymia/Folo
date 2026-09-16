import { readFile } from "node:fs/promises"

import { evaluateDataset } from "../apps/information-service/src/evaluation"

async function main() {
  const [inputPath, ...extraArguments] = process.argv.slice(2)
  if (!inputPath || extraArguments.length > 0) {
    throw new Error("用法: pnpm tsx scripts/evaluate-samples.ts <samples.json>")
  }

  // CLI 只读取本地固定样本；必保留事实及出现状态均须由人工填写，不调用模型或网络判定。
  const input = JSON.parse(await readFile(inputPath, "utf8")) as unknown
  const report = evaluateDataset(input)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`评估失败: ${message}\n`)
  process.exitCode = 1
})
