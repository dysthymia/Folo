// 通用单篇、批量和长文共享基础缓存版本；语义实体协议另以独立版本隔离。
export const ENTRY_PROMPT_VERSION = 14

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

// 独立入口与证据资格逐条判断：有效重复可折叠，纯噪声和待补上下文不能进入综述。
export const ENTRY_PRESENTATION_REQUIREMENTS = `逐条展示与综合要求：
- disposition 是可追溯的语义建议，不能授予隐藏权限；是否隐藏由显式阅读规则最终决定。aggregation 单独决定是否具备事件综述的证据价值。
- 纯噪声：disposition=hide 且 aggregation=false；有证据价值的重复材料可 disposition=hide 且 aggregation=true。
- 缺正文、图片未读或引用原帖缺失时 disposition=needs_context 且 aggregation=false，不能把缺材料当成无价值。
- 重要短公告、有效链接、图表、反证可保留；涉及资格、领取、快照、截止的重要公告优先独立阅读，不等事件综述。
- 教程、深度论证、个人经验和原始披露默认保留独立阅读；不以篇幅、点赞或粉丝数替代信息价值判断。`

// 身份必须绑定原文证据，不允许用主题标签、生成标题或报道发布时间制造事件关系。
export const EVENT_IDENTITY_REQUIREMENTS = `事件身份要求：
- 必须返回 event:null 或结构化身份。主体subject、动作action、对象object、版本version、活动轮次round、发生锚点anchor中的每个已知字段都附本条输入目录的evidenceId；无法核实填null，不猜造。
- kind=event用于具体真实事件；独立观点/预测/研究为analysis，教程为tutorial。不同作者观点、同工具教程不能因为主题相近变成一个真实事件。
- subject/object.value优先采用原文明示的稳定URL/ID；没有ID时使用原文明示实体的官方规范名，保留拉丁技术名/缩写，不使用“加密监管”“AI新闻”等泛主题。不凭记忆编造URL或实体别名。跨语言引用同一官方原帖时使用同一原帖URL作anchor。
- action.value只选schema中的动作类型。object须是具体公告对象/产品/法律案件/活动的稳定实体名，不用来源标签或整句事件描述充当对象。例如某人评价某团队时，subject 为发言者，action=public_statement，object 为原文明示的团队名；评价内容、效率和速度等细节保留在 facts，不能使不同报道的 object 漂移。
- anchor.kind=event_time仅使用原文明示发生时刻，value为带明确UTC offset的ISO8601（如2026-09-25T00:31:00+08:00）。event_date仅使用原文明示发生日（YYYY-MM-DD），timeZone只填原文明示时区对应的IANA名（如Asia/Shanghai）或UTC offset（如+08:00），未知填null。不能拿报道/发布时间替代、猜算相对日期，不能仅凭“美国”猜时区；event_time/时区必须与同一anchor.evidenceId原文相符。
- official_reference仅用原文实际提供的官方公告或原帖URL，timeZone填null。没有发生日期但有明确模型版本/空投轮次或官方原帖，仍可识别事件。明确时区下的跨日发生时间由服务器归一，不按日期字符串机械拆事件。
- 版本、活动轮次不同是不同事件。领取截止、资格和条件改变是同事件的新事实，不写进subject/object/anchor。不把截止日期冒充事件发生日期。
- 主体、动作和对象明确的具体主报道，即使发生锚点/版本/轮次均未知，也返回该主事件身份并将未知字段填null；这是候选身份，不代表已确认同一事件。服务端仍要求可核实发生身份才能自动归并。无法明确主体、动作或对象时返回event:null，不盲目整合。`

// 事件提及与整篇内容类型分开，分析/教程的关联身份不会变成 Story 的事实报道资格。
export const EVENT_MENTION_REQUIREMENTS = `事件提及要求：
- 必须返回 eventMentions 数组，最多 4 项；没有原文可追溯的具体事件时返回 []。每项为 {identity,role,isPrimary}，identity 的每个已知字段选择本条证据目录的 evidenceId。
- role 只取 reports（直接报道）、analysis_of（分析具体事件）、tutorial_for（与具体事件相关的教程）、mentions（附带提及）。独立分析和教程保留 identity.kind=analysis/tutorial，不伪装成 event 报道。
- 最多一个 isPrimary=true，主提及 identity 必须逐字段等于 legacy event；event=null 时全部 isPrimary=false。标题与正文重点直接报道的具体事件设为主提及，不能因缺发生锚点或附带历史背景而丢掉主次关系。周报或并列多事件可以没有主事件，不能拿周报主题、领域标签或模糊主体制造主事件。
- 只提取材料明确讨论的少量具体事件；没有可核实的发生锚点、版本或轮次时，可作为次要候选保留并令 anchor/version/round=null，不编造日期或官方URL。未知来源链接只能候选，不能冒充已确认事件。
- subject/object/version/round 的值必须受各自选定的连续片段明确支持，官方URL必须来自该片段。不按相似拼写、简称或记忆中的别名合并实体。未读取链接、图片或引用内容不能被补成已确认身份。
- 单篇及整篇最终 facts 可逐条返回 eventMentionIndex，使用本次输出 eventMentions 数组的 0..3 序号。数值只在该事实证据完整属于对应身份证据片段且不涉及其他事件时使用；无法明确归属返回 null。省略仅兼容旧结果的主事件保护，不会自动分给周报中其他事件。分块事实不返回该序号，整篇综合时重新绑定最终提及顺序。
- 多事件身份只建立提及关系，不宣称整篇 facts 都属于主事件；不能将另一事件的事实注入主事件。主事件与背景事件选择各自独立的证据片段，facts 同样逐条选本事件片段；无法分开的混合片段不具备主事件综述资格。`
