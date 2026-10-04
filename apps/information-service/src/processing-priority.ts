import type { SourceEntry } from "./folo"
import { sourceText } from "./service"

export const PROCESSING_BATCH_ITEMS = 8

// 优先级只改变等待顺序，不代表内容有价值，也不豁免材料、规则、预算或人工覆盖检查。
export function timeSensitivePriority(body: Pick<SourceEntry, "title" | "content">): 0 | 1 {
  const title = body.title ?? ""
  const text = `${title}\n${sourceText(body.content?.slice(0, 8_000) ?? "")}`
  if (
    /领取|资格|截止|快照|claim|deadline|eligib|snapshot/iu.test(text) &&
    /今天|今晚|明天|本周|截止|deadline|\d{1,2}[:月/-]\d{1,2}/iu.test(text)
  )
    return 1

  // 安全教程、历史复盘和假设不因包含事故词就抢占队列；须存在同一句现实事故或紧急动作。
  if (
    /教程|教学|指南|如何|教你|复盘|回顾|假设|tutorial|guide|how\s+to|postmortem|retrospective/iu.test(
      title,
    )
  )
    return 0
  const securityIncident = text.split(/[。！？.!?\n]/u).some((sentence) => {
    if (
      /教程|教学|如何|教你|示例|假设|如果|演练|曾经|去年|历史上|未发现|未遭|未被|并未|没有|tutorial|how\s+to|hypothetical|\bif\b|\bno\b|\bnot\b/iu.test(
        sentence,
      )
    )
      return false
    const actualIncident =
      /遭(?:到|受)?攻击|正在被攻击|已被攻击|被盗|资金.{0,12}(?:被窃|被盗|流失)|(?:发现|披露|确认).{0,16}(?:严重|高危|重大|零日|可被利用).{0,8}漏洞|(?:严重|高危|重大|零日)漏洞.{0,16}(?:已披露|已确认|正在被利用)|\b(?:hacked|exploited|under attack)\b/iu.test(
        sentence,
      )
    const serviceSuspension =
      /(?:已|正在|紧急|暂时).{0,8}(?:暂停|停止|关闭).{0,12}(?:提款|提现|提币|协议|桥|服务)|(?:协议|桥|提款|提现|提币).{0,8}(?:已暂停|紧急暂停)|(?:暂停提款|暂停提现|暂停提币).{0,8}(?:公告|通知)|\b(?:withdrawals?|protocol|bridge)\b.{1,20}\b(?:suspended|paused|halted)\b/iu.test(
        sentence,
      )
    const emergencyAction =
      /(?:紧急|立即|尽快).{0,12}(?:撤销|取消).{0,8}授权|\b(?:urgent|immediately)\b.{1,30}\brevoke\b.{1,20}\b(?:approval|permission)/iu.test(
        sentence,
      )
    return actualIncident || serviceSuspension || emergencyAction
  })
  return securityIncident ? 1 : 0
}

// 两类按入队序号FIFO；每个混合批最多7条紧迫材料，最早普通材料固定第2位。
// 这是取批与尝试顺序保证，不承诺取消、缺材料、失败或额度耗尽时必定发布，也不抢占长文分块。
export function fairProcessingBatches<
  T extends { seq: number; body: Pick<SourceEntry, "title" | "content"> },
>(inputs: readonly T[]): T[][] {
  const fifo = [...inputs].sort((left, right) => left.seq - right.seq)
  const urgent: T[] = []
  const ordinary: T[] = []
  for (const input of fifo) (timeSensitivePriority(input.body) ? urgent : ordinary).push(input)
  const batches: T[][] = []
  let urgentIndex = 0
  let ordinaryIndex = 0
  while (urgentIndex < urgent.length || ordinaryIndex < ordinary.length) {
    const batch: T[] = []
    if (urgentIndex < urgent.length) batch.push(urgent[urgentIndex++]!)
    if (ordinaryIndex < ordinary.length) batch.push(ordinary[ordinaryIndex++]!)
    while (batch.length < PROCESSING_BATCH_ITEMS && urgentIndex < urgent.length)
      batch.push(urgent[urgentIndex++]!)
    while (batch.length < PROCESSING_BATCH_ITEMS && ordinaryIndex < ordinary.length)
      batch.push(ordinary[ordinaryIndex++]!)
    batches.push(batch)
  }
  return batches
}
