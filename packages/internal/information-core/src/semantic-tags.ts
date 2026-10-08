import { z } from "zod"

// 稳定 ID 与展示名称分离，偏好和规则只决定动作，不改变标签的客观定义。
export const semanticTagIds = [
  "form:pure_entertainment",
  "signal:social_chatter",
  "signal:empty_opinion",
  "signal:pure_promotion",
  "signal:original_data",
  "signal:reasoned_analysis",
  "form:tutorial",
  "form:review",
  "topic:ai",
  "topic:blockchain",
  "topic:product",
  "topic:music",
  "topic:fintech",
  "topic:defi",
  "topic:blockchain_infrastructure",
  "event:product_launch",
  "event:feature_update",
  "event:funding",
  "event:institutional_accumulation",
  "event:fund_flow",
  "event:business_expansion",
  "event:institutional_investment",
  "event:security_incident",
  "event:incentive_airdrop",
  "event:tokenomics_change",
  "event:listing_trading_support",
  "event:regulation",
  "event:macro_change",
  "topic:personal_growth",
  "signal:concrete_experience",
] as const
export const semanticTagIdSchema = z.enum(semanticTagIds)
export type SemanticTagId = z.infer<typeof semanticTagIdSchema>

export const semanticTagDefinitionSchema = z
  .object({
    id: semanticTagIdSchema,
    kind: z.enum(["topic", "event", "form", "signal", "workflow"]),
    name: z.string().min(1),
    description: z.string().min(1),
    positiveExamples: z.array(z.string().min(1)).min(1),
    negativeExamples: z.array(z.string().min(1)).min(1),
    aliases: z.array(z.string().min(1)),
    parentId: semanticTagIdSchema.nullable(),
    definitionVersion: z.number().int().positive(),
    enabled: z.boolean(),
    origin: z.enum(["builtin", "user"]),
  })
  .strict()
export type TagDefinition = z.infer<typeof semanticTagDefinitionSchema>

export const tagAssessmentSchema = z
  .object({
    tagId: semanticTagIdSchema,
    definitionVersion: z.number().int().positive(),
    state: z.enum(["present", "absent", "unknown"]),
    // 置信度是模型自评；缺失判断和旧版本不能被升级成确定的否定判断。
    confidence: z.number().finite().min(0).max(1).nullable(),
    reason: z.string().trim().min(1).max(4000),
    evidenceIds: z.array(z.string().trim().min(1).max(200)).max(100),
  })
  .strict()
export type TagAssessment = z.infer<typeof tagAssessmentSchema>

const definition = (
  id: SemanticTagId,
  kind: TagDefinition["kind"],
  name: string,
  description: string,
  positiveExamples: string[],
  negativeExamples: string[],
  aliases: string[],
  options: Partial<Pick<TagDefinition, "parentId" | "definitionVersion">> = {},
): TagDefinition => ({
  id,
  kind,
  name,
  description,
  positiveExamples,
  negativeExamples,
  aliases,
  parentId: options.parentId ?? null,
  definitionVersion: options.definitionVersion ?? 1,
  enabled: true,
  origin: "builtin",
})

export const semanticTagDefinitions: readonly TagDefinition[] = [
  definition(
    "form:pure_entertainment",
    "form",
    "纯娱乐",
    "主要用于八卦、玩梗或消遣，缺少可识别的事实、经验、方法或论据；判断不取决于用户是否喜欢娱乐。",
    ["无背景信息的调侃段子"],
    ["娱乐行业经营分析", "音乐教程", "有数据的游戏评测"],
    ["pure entertainment"],
  ),
  definition(
    "signal:social_chatter",
    "signal",
    "纯闲聊",
    "主要是问候、无实质内容的状态更新或闲聊，没有可识别的新事实或可用方法。",
    ["GM，大家早上好"],
    ["领取窗口明天上午十点开放"],
    ["social chatter"],
  ),
  definition(
    "signal:empty_opinion",
    "signal",
    "空泛观点",
    "主要表达情绪、口号或泛泛判断，缺少可识别的新事实、具体经验、方法或论据。",
    ["抓住趋势，你就赢了"],
    ["我测试了三种工具，以下是失败案例、配置和推理"],
    ["empty opinion"],
  ),
  definition(
    "signal:pure_promotion",
    "signal",
    "纯推广",
    "内容主要是拉群、返佣或招揽，去掉推广后没有可用信息；附带推广不等于纯推广。",
    ["只有邀请码和加入群聊的号召"],
    ["正式产品公告", "提供完整有用方法且附带推广的文章"],
    ["pure promotion"],
  ),
  definition(
    "signal:original_data",
    "signal",
    "原始数据",
    "明确给出作者自行收集或测试的数据，或直接提供原始披露，并能识别数据来源或方法。",
    ["给出测试方法、条件和结果的实测"],
    ["听说性能很好"],
    ["original data"],
  ),
  definition(
    "signal:reasoned_analysis",
    "signal",
    "有据分析",
    "提供明确依据及推理过程的分析，不要求结论正确或符合个人偏好。",
    ["解释数据并讨论推理的局限"],
    ["没有依据的涨跌口号"],
    ["reasoned analysis"],
  ),
  definition(
    "form:tutorial",
    "form",
    "教程",
    "提供可学习的方法、步骤或操作说明；未取得链接正文时不能根据链接标题推断完整教程。",
    ["完整的工具配置步骤"],
    ["仅写教程在这里，链接正文未获取"],
    ["tutorial"],
  ),
  definition(
    "form:review",
    "form",
    "评测",
    "对产品或方法进行比较、体验或测试评价，有可识别的评价对象和使用依据。",
    ["说明测试条件及优缺点的使用评测"],
    ["没有使用证据的推广赞美"],
    ["review"],
  ),
  definition(
    "topic:ai",
    "topic",
    "人工智能",
    "实质讨论人工智能模型、训练、推理、应用或相关影响；偶然出现 AI 字样不构成主题。",
    ["介绍模型推理方法及评测结果"],
    ["只在签名中出现 AI 的日常问候"],
    ["AI", "artificial intelligence"],
  ),
  definition(
    "topic:blockchain",
    "topic",
    "区块链",
    "实质讨论区块链协议、链上活动、数字资产机制或生态；普通数据库和金融话题不自动归入。",
    ["分析以太坊协议升级和链上数据"],
    ["普通数据库索引教程"],
    ["blockchain", "加密资产"],
  ),
  definition(
    "topic:product",
    "topic",
    "产品",
    "实质讨论产品功能、设计、开发、发布、使用或评测；融资、机构设立子公司、交易和持仓不因提到品牌名而成为产品主题。",
    ["说明某应用新版功能、使用方式及限制", "比较产品设计和实测表现"],
    ["只带品牌标签的问候", "某公司完成融资", "某机构设立子公司", "机构买入或持有数字资产"],
    ["product"],
    { definitionVersion: 2 },
  ),
  definition(
    "topic:music",
    "topic",
    "音乐",
    "实质讨论音乐创作、演奏、理论、作品、乐器或音乐行业；音乐表情或背景配乐不构成主题。",
    ["吉他和弦教学和演奏技巧"],
    ["仅使用音乐表情的闲聊"],
    ["music"],
  ),
  definition(
    "topic:fintech",
    "topic",
    "金融科技",
    "实质讨论运用技术提供支付、银行、借贷、保险、投资或金融服务；普通金融新闻及只出现金融品牌名不自动归入。",
    ["数字银行支付服务的技术与业务扩展", "金融科技机构推出自动化投资服务"],
    ["普通制造企业融资", "只提银行品牌的问候"],
    ["fintech", "financial technology"],
  ),
  definition(
    "topic:defi",
    "topic",
    "去中心化金融",
    "实质讨论基于区块链的去中心化交易、借贷、收益、流动性或金融协议；中心化机构买币或一般链上活动不自动成为 DeFi。",
    ["去中心化借贷协议更新利率机制", "分析 DEX 流动性和收益机制"],
    ["上市公司增持比特币", "中心化交易所开设办公室"],
    ["DeFi", "decentralized finance"],
    { parentId: "topic:blockchain" },
  ),
  definition(
    "topic:blockchain_infrastructure",
    "topic",
    "区块链基础设施",
    "实质讨论区块链网络、扩容、节点、验证、跨链、数据可用性、RPC、索引或开发基础设施；应用经营和数字资产持仓不自动归入。",
    ["介绍 Layer 2 扩容架构", "节点服务发布新的 RPC 接口"],
    ["公司增持比特币", "DeFi 应用调整借贷利率"],
    ["blockchain infrastructure", "区块链基建"],
    { parentId: "topic:blockchain" },
  ),
  definition(
    "event:product_launch",
    "event",
    "产品发布",
    "明确发布、上线或开放可识别的新产品、服务或首次可用版本；融资和业务扩展本身不构成产品发布。",
    ["新应用正式上线并开放使用"],
    ["融资后计划未来开发产品", "为现有应用增加一个功能"],
    ["product launch"],
  ),
  definition(
    "event:feature_update",
    "event",
    "功能更新",
    "明确说明现有产品、服务或协议新增、修改、移除功能或更新版本；纯价格、持仓及融资变化不构成功能更新。",
    ["现有应用新增离线同步功能", "协议新版调整清算机制"],
    ["公司股价上涨", "机构增加资产持仓"],
    ["feature update"],
  ),
  definition(
    "event:funding",
    "event",
    "融资",
    "明确说明公司、项目或组织募集资金、完成融资轮次或获得融资承诺；普通资产买卖和基金资金流不构成融资。",
    ["项目完成由机构领投的 A 轮融资"],
    ["基金出现净流入", "公司买入比特币"],
    ["funding", "fundraising"],
  ),
  definition(
    "event:institutional_accumulation",
    "event",
    "机构增持",
    "明确说明企业、基金或其他机构买入、增持或增加可识别资产的持仓；个人买入、仅披露存量持仓或未发生增持的计划不构成。",
    ["上市公司新增买入比特币并披露数量"],
    ["个人买入比特币", "公司只披露现有持仓，没有增加"],
    ["institutional accumulation"],
  ),
  definition(
    "event:fund_flow",
    "event",
    "资金流",
    "明确披露资金流入、流出或净流动及其对象、时间或统计口径；价格涨跌、资产转账和单一机构增持不自动成为资金流。",
    ["比特币 ETF 当日净流入一亿美元"],
    ["比特币价格上涨", "没有资金流统计的机构买入公告"],
    ["fund flow", "资金流入", "资金流出"],
  ),
  definition(
    "event:business_expansion",
    "event",
    "业务扩展",
    "明确说明机构设立子公司、进入新地区、开设分支或拓展业务范围；不因出现品牌名而成为产品内容。",
    ["金融科技公司设立海外子公司并拓展支付业务"],
    ["应用修复一个功能", "未落实的泛泛增长口号"],
    ["business expansion"],
  ),
  definition(
    "event:institutional_investment",
    "event",
    "机构投资",
    "明确说明机构对公司、项目、股权或业务进行投资、参股或收购；常规数字资产买入与持仓增加使用机构增持，不能仅凭机构名称判断。",
    ["投资机构参股金融科技公司", "企业投资区块链基础设施项目"],
    ["企业买入比特币作为储备", "没有投资事实的机构品牌介绍"],
    ["institutional investment"],
  ),
  definition(
    "event:security_incident",
    "event",
    "安全事件",
    "有证据确认的攻击、漏洞利用、资产被盗、泄漏或安全事故；营销警告、未证实传闻和安全教育不成立。",
    ["协议确认漏洞已被利用并说明影响"],
    ["赶快领取否则资产危险的广告"],
    ["security incident"],
  ),
  definition(
    "event:incentive_airdrop",
    "event",
    "激励与空投",
    "明确给出奖励、空投资格、领取窗口或激励机制的实际安排；邀请码和泛泛收益承诺不成立。",
    ["官方公布奖励资格与领取窗口"],
    ["快来赚钱的返佣广告"],
    ["incentive airdrop"],
  ),
  definition(
    "event:tokenomics_change",
    "event",
    "代币经济变化",
    "具体的供给、解锁、销毁、奖励分配或经济机制变化；价格波动和主观预测不成立。",
    ["公告调整解锁日期及释放数量"],
    ["币价大涨和看多口号"],
    ["tokenomics change"],
  ),
  definition(
    "event:listing_trading_support",
    "event",
    "上市与交易支持",
    "明确的上币、下币、交易对、发行上市或暂停交易安排；品牌露出和传闻不成立。",
    ["交易所宣布交易对开放时间"],
    ["传闻可能上线平台"],
    ["listing trading support"],
  ),
  definition(
    "event:regulation",
    "event",
    "监管变化",
    "明确的法规、监管决定、执法或适用规则变化，能指出对象及安排；政策猜测不成立。",
    ["监管机构发布适用规则及生效日期"],
    ["没有出处的政策猜测"],
    ["regulation"],
  ),
  definition(
    "event:macro_change",
    "event",
    "宏观变化",
    "有来源的利率、通胀、就业、货币或财政数据和政策安排变化；市场情绪不成立。",
    ["央行公告调整政策利率"],
    ["形势一片大好的感叹"],
    ["macro change"],
  ),
  definition(
    "topic:personal_growth",
    "topic",
    "个人成长",
    "实质讨论学习、能力、习惯或长期发展，提供可用方法、经历或依据；励志口号不成立。",
    ["分享学习方法和失败经验"],
    ["努力就一定成功"],
    ["personal growth"],
  ),
  definition(
    "signal:concrete_experience",
    "signal",
    "具体经验",
    "提供可核对的实践条件、步骤、结果或失败经历；泛泛态度和无依据推荐不成立。",
    ["列明实际配置与失败结果"],
    ["用了感觉很好"],
    ["concrete experience"],
  ),
]

export const semanticTagDefinition = (id: string): TagDefinition | undefined =>
  semanticTagDefinitions.find((item) => item.id === id)

const blockchainSubtopics: readonly SemanticTagId[] = [
  "topic:defi",
  "topic:blockchain_infrastructure",
]

// 平面标签只确认共同出现，不表示多领域与多事件之间存在逐一对应关系。
export const buildSemanticTagGroups = (tags: readonly SemanticTagId[]): SemanticTagId[][] => {
  const uniqueTags = [...new Set(tags)]
  const domains = uniqueTags.filter((id) => id.startsWith("topic:") && id !== "topic:product")
  const events = uniqueTags.filter((id) => id.startsWith("event:"))
  const hasProduct = uniqueTags.includes("topic:product")
  const hasBlockchainSubtopic = domains.some((id) => blockchainSubtopics.includes(id))
  const domainFamilies = new Set(
    domains.map((id) => (blockchainSubtopics.includes(id) ? "topic:blockchain" : id)),
  )
  const domain =
    domainFamilies.size === 1 ? domains.find((id) => !blockchainSubtopics.includes(id)) : undefined
  // 细分领域独立展示；显式父领域可和产品组合，但不能凭子标签补造父领域判断。
  const combination: SemanticTagId[] | undefined =
    domain && hasProduct
      ? [domain, "topic:product"]
      : domain && !hasBlockchainSubtopic && events.length === 1
        ? [domain, events[0]!]
        : undefined
  const groups: SemanticTagId[][] = []
  for (const id of uniqueTags) {
    if (combination?.includes(id)) {
      if (id === domain) groups.push(combination)
      continue
    }
    if (id === "topic:blockchain" && hasBlockchainSubtopic) continue
    groups.push([id])
  }
  // 领域先于事件，形式与信号随后，同类保留输入顺序以避免无依据的优先级推断。
  const rank = (group: SemanticTagId[]) =>
    group[0]?.startsWith("topic:") ? 0 : group[0]?.startsWith("event:") ? 1 : 2
  return groups.sort((left, right) => rank(left) - rank(right))
}
