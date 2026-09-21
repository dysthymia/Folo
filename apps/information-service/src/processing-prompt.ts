// 单篇、批量和长文共享缓存版本；任一 prompt 语义变化都必须同步递增。
export const ENTRY_PROMPT_VERSION = 10

// 展示动作也是实际执行指令，不能只进入指纹和设置页。
export function entryDisplayRequirements(display: {
  language?: string
  summaryMaxGraphemes?: number
}) {
  return [
    display.language ? `标题与摘要使用语言：${display.language}；原文引用保持原语言。` : "",
    display.summaryMaxGraphemes
      ? `最终摘要最多 ${display.summaryMaxGraphemes} 个可见字符，优先保留关键信息，不靠新增推断压缩。`
      : "",
  ]
    .filter(Boolean)
    .join("\n")
}

export const SOURCE_FIDELITY_REQUIREMENTS = `原文忠实要求：
- 标题、摘要和 facts 中的每项事实都必须受原文明确支持；不得只给 facts.quote 正确，却在标题或摘要加入无依据结论。
- 每条 fact.text 的全部信息必须由所选 evidenceId 对应的单个片段明确支持，不能借用相邻片段补足该事实；如果信息来自不同片段，缩小表述或拆成分别有直接证据的 facts。只返回 evidenceId，由服务端还原 quote。
- facts 只保留不重复的关键事实；schema 的数组上限不是数量目标，不得为了接近或填满上限而凑数。
- 转述消息、观点、估算或第三方数据时必须保留来源归属，不得改写成已独立证实的事实。
- 不得主动从市值、成交额、涨跌幅等原始数据派生换手率、流动性、操纵风险或其他新的市场判断。
- 相对日期若没有文中明确年份或日期锚点，保留“周四”“昨日”等原词；任何日期换算或其他推断不得混入事实标题或事实摘要。
- 报道日期、发布日期与事件发生日期必须区分；“某日消息／据某媒体报道”不能被改成事件或发言发生在该日，除非原文明说了事件时间。
- 用户明确要求单独分析时可以给出推断，但必须标记为推断，并放在与事实摘要分开的独立段落。`
