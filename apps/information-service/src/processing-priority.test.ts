import { describe, expect, it } from "vitest"

import { fairProcessingBatches, timeSensitivePriority } from "./processing-priority"

describe("仅影响调度的紧迫线索", () => {
  it.each([
    "协议遭攻击，资金被盗，请立即撤销授权",
    "安全公告：已确认高危漏洞，请尽快更新",
    "已披露重大漏洞，请立即修复",
    "桥已暂停，紧急调查正在进行",
    "紧急暂停提款，恢复时间待确认",
    "暂停提现公告",
    "立即撤销授权，风险调查中",
    "Protocol exploited: revoke approvals immediately",
    "Bridge withdrawals have been paused",
    "领取开放，截止 10/04",
  ])("现实公告优先：%s", (title) => {
    expect(timeSensitivePriority({ title, content: "原始公告正文" })).toBe(1)
  })

  it.each([
    ["安全教程：协议遭攻击时如何撤销授权", "立即撤销授权的示例"],
    ["攻击事件复盘", "协议已被攻击，资金被盗"],
    ["假设协议遭攻击", "假设协议遭攻击，应立即撤销授权"],
    ["风险澄清", "没有发现资金被盗。协议未遭攻击。"],
    ["安全工具发布", "本工具有助于发现漏洞。"],
    ["如何紧急撤销授权", "协议遭攻击后的教学材料"],
    ["风险历史", "该协议去年遭攻击，资金被盗。"],
    ["日常安全学习", "教程示例：立即撤销授权。"],
    ["Security guide", "Protocol exploited: revoke approvals immediately"],
    ["Incident clarification", "Protocol not exploited. No withdrawals suspended."],
    ["普通项目更新", "Crypto-项目方 空投安全领域"],
  ])("教程、否认或来源标签不会单独抢占：%s", (title, content) => {
    expect(timeSensitivePriority({ title, content })).toBe(0)
  })
})

describe("紧迫与普通材料公平取批", () => {
  const item = (seq: number, urgent: boolean) => ({
    seq,
    body: { title: urgent ? "紧急暂停提款" : "普通研究", content: "真实原文" },
  })

  it("每个混合8项批次给最早普通项第2位，两类内部保持入队顺序", () => {
    const ordinary = [item(1, false), item(2, false), item(3, false)]
    const urgent = Array.from({ length: 20 }, (_, index) => item(10 + index, true))
    const input = [...urgent, ...ordinary].reverse()
    const before = [...input]
    const batches = fairProcessingBatches(input)
    expect(batches.map((batch) => batch[1]?.seq)).toEqual([1, 2, 3])
    expect(batches.map((batch) => batch.length)).toEqual([8, 8, 7])
    expect(batches.flat().filter((entry) => entry.seq >= 10)).toEqual(urgent)
    expect(new Set(batches.flat().map((entry) => entry.seq)).size).toBe(input.length)
    expect(input).toEqual(before)
  })

  it("持续加入新紧迫材料时，旧普通材料仍在下一批得到机会", () => {
    const pending = [item(1, false), item(2, false)]
    pending.push(...Array.from({ length: 8 }, (_, index) => item(10 + index, true)))
    const first = fairProcessingBatches(pending)[0]!
    expect(first[1]?.seq).toBe(1)
    const finished = new Set(first.map((entry) => entry.seq))
    const remainder = pending.filter((entry) => !finished.has(entry.seq))
    remainder.push(...Array.from({ length: 8 }, (_, index) => item(20 + index, true)))
    expect(fairProcessingBatches(remainder)[0]?.[1]?.seq).toBe(2)
  })

  it("单一队列按FIFO填满8项批次，空队列不产生工作", () => {
    expect(fairProcessingBatches([])).toEqual([])
    for (const urgent of [true, false]) {
      const inputs = Array.from({ length: 10 }, (_, index) => item(index + 1, urgent))
      const batches = fairProcessingBatches([...inputs].reverse())
      expect(batches.map((batch) => batch.length)).toEqual([8, 2])
      expect(batches.flat()).toEqual(inputs)
    }
  })
})
