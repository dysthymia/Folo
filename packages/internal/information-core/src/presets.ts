export const presetIds = [
  "P00",
  "P01",
  "P02",
  "P03",
  "P04",
  "P05",
  "P06",
  "P07",
  "P08",
  "P09",
  "P10",
  "P11",
  "P12",
  "P13",
  "P14",
  "P15",
] as const

export type PresetId = (typeof presetIds)[number]
export type PresetTarget =
  "global" | "ai_transform" | "ai_aggregate.createPrompt" | "ai_aggregate.updatePrompt" | "topic"
export type PromptPresetParameter =
  | {
      key: string
      label: string
      type: "integer"
      required: boolean
      defaultValue?: number
      minimum: number
      maximum: number
    }
  | {
      key: string
      label: string
      type: "string"
      required: boolean
      defaultValue?: string
      minimumLength: number
      maximumLength: number
    }
export type PromptPreset = {
  id: PresetId
  version: number
  name: string
  description: string
  suggestedConditions: string
  target: PresetTarget
  parameters: readonly PromptPresetParameter[]
  prompt: string
  presentation?: { standalone: "always" }
}
export type PresetRef = { id: string; version: number }
export type PresetApplicationMode = "append" | "replace"
export type PresetApplication = {
  target: PresetTarget
  presetRef: PresetRef
  prompt: string
  parameters: Record<string, string | number>
  patch:
    | { markdown: string }
    | { type: "ai_transform"; prompt: string; preset: PresetRef }
    | { createPrompt: string; presets: { create: PresetRef } }
    | { updatePrompt: string; presets: { update: PresetRef } }
    | {
        mode: "topic"
        createPrompt: string
        presets: { create: PresetRef }
      }
  presentation?: { type: "presentation"; policy: { standalone: "always" } }
  display?: { type: "display"; summaryMaxGraphemes: number }
}

export type PresetVersionComparison = "current" | "upgrade" | "newer" | "different"

export function comparePresetVersion(
  current: PresetRef | undefined,
  candidate: PresetRef,
): PresetVersionComparison {
  if (!Number.isInteger(candidate.version) || candidate.version < 1)
    throw new Error("invalid_preset_version")
  if (!current || current.id !== candidate.id) return "different"
  if (current.version < candidate.version) return "upgrade"
  if (current.version > candidate.version) return "newer"
  return "current"
}

export function mergePresetApplication(
  application: PresetApplication,
  currentPrompt: string,
  mode: PresetApplicationMode,
): PresetApplication {
  const prompt =
    mode === "append" && currentPrompt.trim()
      ? `${currentPrompt.trimEnd()}\n\n${application.prompt}`
      : application.prompt
  const patch = application.patch
  // 预览与最终写入共用同一个合并函数，避免界面展示追加、实际却覆盖私人 Prompt。
  const mergedPatch =
    "markdown" in patch
      ? { ...patch, markdown: prompt }
      : "type" in patch
        ? { ...patch, prompt }
        : "updatePrompt" in patch
          ? { ...patch, updatePrompt: prompt }
          : { ...patch, createPrompt: prompt }
  return { ...application, prompt, patch: mergedPatch } as PresetApplication
}

// 预设是只读目录；应用时总是复制 Prompt 和 presetRef，目录升级不会改写用户已经保存的规则。
export const promptPresets: readonly PromptPreset[] = [
  {
    id: "P00",
    version: 1,
    name: "全局阅读基础",
    description: "全局中文辅助阅读和可追溯性基础，不额外隐藏内容。",
    suggestedConditions: "账号全局",
    target: "global",
    parameters: [],
    prompt: `你帮助我把订阅内容变成更易阅读、可追溯的信息。
用中文提供辅助标题、要点或摘要，保留专有名称、关键数值、条件、单位、时间及原始来源。
原文事实、来源自述、作者判断与你的推断要分开，缺失信息保持缺失，不编造。
没有更具体的隐藏或整合要求时保留独立条目；不要自动只推荐少量Top-N。
按已解析的规则顺序处理冲突；无冲突要求继续适用。
仅调整个人阅读展示，不删除原文、不改订阅、不自动改已读或外发内容。`,
  },
  {
    id: "P01",
    version: 1,
    name: "X短帖和娱乐过滤",
    description: "以可见字符数过滤短帖与无实质娱乐内容，保留明确例外。",
    suggestedConditions: "视图=社交媒体 AND 平台=X",
    target: "ai_transform",
    parameters: [integerParameter("N", "最小可见字符数", 50, 1, 30000)],
    prompt: `对这些X条目，若原帖正文完整且按系统提供的可见字符数少于{N}，隐藏。
隐藏主要目的为娱乐、玩笑、无实质信息的闲聊或情绪宣泄的条目。
遵守更高优先级规则中明确的保留例外；没有例外时不要擅自放宽长度条件。
不要把缺正文、截断内容、图片尚未识别误当成0字；材料不足时标记待补充。
对隐藏给出简短原因；保留内容维持原始依据与链接，不自动标记为已读。`,
  },
  {
    id: "P02",
    version: 1,
    name: "宣传与重复口号去噪",
    description: "滤除无事实的宣传，保留带有具体变化的内容。",
    suggestedConditions: "按用户选择的社交或新闻范围",
    target: "ai_transform",
    parameters: [],
    prompt: `隐藏只有口号、重复宣传、抽奖互动、无依据喊单或没有新增事实的自我推广。
如果宣传文字中包含真实的新产品、具体上线时间、参数、费用、权益变化、限制或风险，提取这些实质信息，不因营销语气就整条删掉。
仅有“合作”“重磅”“即将改变行业”等表述而缺少具体内容时，不把它升级为确定利好。
对存在明确实质信息的条目保留要点与原文链接；事实与宣传说法分开。`,
  },
  {
    id: "P03",
    version: 1,
    name: "新闻媒体事实提取",
    description: "提取媒体报道中的新增事实及其来源性质。",
    suggestedConditions: "订阅标签包含 来源/媒体",
    target: "ai_transform",
    parameters: [],
    prompt: `提取这条报道到底新增了哪些事实：谁、何时、做了什么、关键数字和生效条件。
删去无信息量的铺垫和标题党表达，保留必要背景、争议及限制。
区分媒体自己的调查、对项目方的转述与引用研究者观点；原文未提供的信息不要补齐。
标出可能属于重复转述的部分和有实际增量的部分，供后续同事件整合使用。
保留原始来源链接，不把多家转载当成多份独立证据。`,
  },
  {
    id: "P04",
    version: 1,
    name: "项目方实质公告",
    description: "保留项目方实质更新，并作为短文过滤的明确例外。",
    suggestedConditions: "订阅标签包含 来源/项目方 或项目方 List；优先于短文过滤",
    target: "ai_transform",
    parameters: [],
    prompt: `重点保留产品功能、正式上线、治理提案、代币经济、费用、回购或分配机制、安全事件、迁移与重要进度等实质更新。
这些重要公告即使正文不足50字也保留，覆盖低优先级的长度过滤；此例外不适用于娱乐、纯口号或无新增信息的营销。
提取事件状态：只是提出、正在测试、已经上线，还是已经执行；记录时间、条件、受影响对象和用户需要注意的变化。
项目方的承诺与自报数据标明是其表述，不自动当成独立验证结果或买卖建议。
原材料没有的参数与执行证据保持未知；按其他相容规则参加综述或独立展示。`,
  },
  {
    id: "P05",
    version: 1,
    name: "研究者观点保真",
    description: "保留研究论证与限制，不把观点改写为事实新闻。",
    suggestedConditions: "订阅标签包含 来源/研究者",
    target: "ai_transform",
    parameters: [],
    prompt: `保留作者的核心论点、论证链、使用的数据或案例、关键假设、反证及失效条件。
区分作者提出的新解释与对已有消息的复述，不只抽一句结论或目标价。
没有论据的喊单可按其他规则隐藏；有独特推理的内容不要因为与主流观点不同而过滤。
把观点标为观点，把作者披露的利益关系如实保留；没有披露时不得猜测。
对值得深入阅读的部分说明原因并链接原文，不假装已验证作者预测。`,
  },
  {
    id: "P06",
    version: 1,
    name: "同事件多文综述",
    description: "为同一聚合动作填写创建 Story 的 Prompt。",
    suggestedConditions: "界面选择分类、标签或 List 聚合范围",
    target: "ai_aggregate.createPrompt",
    parameters: [],
    prompt: `把允许参与整合、且确实描述同一事件的条目综合为一篇可直接阅读的中文综述。
不是选择一篇代表文章：整合各来源独有信息，去掉重复表达，突出事实、关键数字、时间、条件及影响对象。
正文按“发生了什么—关键细节—新进展或分歧”组织，没有对应内容不强行凑栏目。
关键句段引用原始条目，末尾提供完整来源入口；转载数量不当成事实确定性的证明。
同一主题的不同事件不要强行合并；反驳与修正应作为新信息保留。
分别遵守来源条目的综合资格和改写资格；保持独立展示本身不禁止参与综述，aggregation=deny的材料不得使用。`,
  },
  {
    id: "P07",
    version: 1,
    name: "后续变化与修正",
    description: "为已有同事件聚合动作填写更新 Prompt，不创建第二条规则。",
    suggestedConditions: "同一聚合规则的已存在 Story",
    target: "ai_aggregate.updatePrompt",
    parameters: [],
    prompt: `在已有综述基础上处理新增原始材料，重点指出相较上个实质版本新增、修正、反驳了什么。
复用已有可靠引用，但对关键旧判断需要时回看原文，不只把旧AI摘要再次摘要。
修正数据要说明旧说法、修正值与依据；信息冲突未解决时并列呈现，不强行消除分歧。
纯转载或文风修改不生成“重大更新”；有实质变化才更新阅读提示。
所有新事实就近链接原始条目，遵守当前聚合范围及成员例外。`,
  },
  {
    id: "P08",
    version: 1,
    name: "原始披露独立保留",
    description: "保持原始披露独立展示，同时提供辅助导读。",
    suggestedConditions: "特定来源或原始披露标签",
    target: "ai_transform",
    parameters: [],
    presentation: { standalone: "always" },
    prompt: `本范围内的实质原始公告、正式报告或重要披露保持独立展示，不被同事件综述替代。
保留原题与原文入口，可附中文导读，但不能用摘要替代原文或改写为已验证结论。
提取关键数字、条件、生效时间和需要进一步核对的事项。
这项例外只改变独立展示要求；其他不冲突的内容处理规则继续有效。`,
  },
  {
    id: "P09",
    version: 1,
    name: "深度报告结构化阅读",
    description: "按论证结构阅读长报告；摘要长度可选，不设隐含默认值。",
    suggestedConditions: "长文来源或内容条件",
    target: "ai_transform",
    parameters: [optionalIntegerParameter("summaryMaxGraphemes", "目标摘要长度", 1, 30000)],
    prompt: `先判断是否取得足够正文。仅有标题、摘要或部分页时，明确材料范围，不把它称为全文研究。
按“核心问题—结论—论证与证据—关键假设—反证和限制—值得细读的部分”组织导读。
保留与结论有关的数值、口径、时间区间和可比对象；缺少时不要补造。
尽量减少复述背景，保留作者独特的推理和方法，并链接相应原文。
不要把报告质量与结论是否乐观混为一谈，不自动转换成买入建议。`,
  },
  {
    id: "P10",
    version: 1,
    name: "AI产品与开发实用性",
    description: "提取 AI 产品对使用、开发和选择的实际影响。",
    suggestedConditions: "AI 分类或开发工具标签",
    target: "ai_transform",
    parameters: [],
    prompt: `优先识别会实际改变使用、开发或产品选择的信息，而不是只保留发布热度。
提取新增能力、适用任务、已知限制、是否已可用、使用前提和原文明确的成本条件。
区分官方宣称、作者实测与推测；跑分缺少设置、样本或对照时不要泛化。
说明这条内容提供了什么新的可用方法；仅重复发布稿或无实质细节时按其他去噪规则处理。
原文没有的价格、版本兼容或可用地区保持未知，保留原始文档入口。`,
  },
  {
    id: "P11",
    version: 1,
    name: "上市公司披露速读",
    description: "按披露口径梳理公司公告，不给出买卖结论。",
    suggestedConditions: "公司披露或股票研究范围",
    target: "ai_transform",
    parameters: [],
    prompt: `基于当前材料提取报告期间、收入或利润等关键数字、管理层指引、股本或资本分配变化及重要风险。
分别保留同比、环比及实际对应期间；区分GAAP、非GAAP和作者自行调整的口径。
原文没有可比基期就不计算增长率，没有股本或估值输入就不编造每股价值。
将管理层表述和已披露结果分开，突出影响原判断的变化，保留正式来源。
不因公告正面措辞直接给出买卖结论。`,
  },
  {
    id: "P12",
    version: 1,
    name: "个人成长与实践",
    description: "提炼方法、边界和小行动，避免把经验泛化为规律。",
    suggestedConditions: "个人成长分类",
    target: "ai_transform",
    parameters: [],
    prompt: `优先保留能解释实际问题、有具体方法和适用条件的内容，过滤只有口号而没有论证的鸡汤。
提取核心问题、方法步骤、为什么可能有效、适用与不适用的情况，以及可尝试的小行动。
区分研究证据、作者经验和个人推断；不要把单个成功故事推广成人人适用的规律。
老文章只要有独特或当前相关价值也可保留，不为了追求新资讯而淘汰。
导读服务于理解与实践，不无限增加待办或知识卡片。`,
  },
  {
    id: "P13",
    version: 1,
    name: "外语辅助阅读",
    description: "提供目标语言辅助阅读，明确区分翻译和摘要。",
    suggestedConditions: "可靠语言条件或用户选择",
    target: "ai_transform",
    parameters: [stringParameter("targetLanguage", "目标语言", "简体中文", 1, 100)],
    prompt: `提供{targetLanguage}的忠实辅助阅读，保留专业名词的必要原文。
不改变数值、单位、日期、条件和语气强弱，不擅自换算价格或补充资料。
对有歧义的术语给出简短说明，不隐藏原文链接。
如果其他规则要求摘要，摘要与翻译明确区分，不把压缩后的导读标成全文翻译。`,
  },
  {
    id: "P14",
    version: 1,
    name: "播客与视频转写整理",
    description: "仅基于已有字幕或转写整理内容，不假装已观看。",
    suggestedConditions: "已有可用转写或字幕的音视频",
    target: "ai_transform",
    parameters: [],
    prompt: `基于现有字幕／转写整理主题、核心观点、重要解释和可追溯引用。
转写有时间戳时保留关键段落对应时间；没有时间戳就不要编造。
材料只有简介时只做简介导读并注明，不能假装听完／看完。
区分主持人、嘉宾和引用他人的说法；识别转写歧义，不凭不完整句子推导确定事实。`,
  },
  {
    id: "P15",
    version: 1,
    name: "定期主题综述",
    description: "按明确主题范围和截至时点生成额外的主题组织。",
    suggestedConditions: "明确主题范围和截至时点",
    target: "topic",
    parameters: [
      stringParameter("topicScope", "主题范围说明", "", 1, 2000, true),
      stringParameter("cutoff", "截至时点", "", 1, 100, true),
    ],
    prompt: `主题范围：{topicScope}
截至时点：{cutoff}
将指定范围和时间窗口内允许使用的内容整理为主题综述，而不是把它们误认为同一事件。
按不同事件或论点分组，突出相较上次新增的事实、分歧和值得深入阅读的材料。
每组保留关键来源引用；没有上次版本时只描述本次材料，不编造“变化”。
不为了凑数量保留无价值重复内容，也不因为栏目限额让其他应保留条目永久消失。
保留原始条目和各自阅读入口，主题综述是额外组织方式，不替代所有原始研究材料。`,
  },
] as const

const presetsById = new Map(promptPresets.map((preset) => [preset.id, preset]))

export function preset(id: PresetId): PromptPreset {
  const value = presetsById.get(id)
  if (!value) throw new Error("unknown_preset")
  return value
}

export function applyPreset(
  id: PresetId,
  values: Record<string, string | number | undefined> = {},
): PresetApplication {
  return applyPresetDefinition(preset(id), values)
}

export function applyPresetDefinition(
  definition: PromptPreset,
  values: Record<string, string | number | undefined> = {},
): PresetApplication {
  if (!Number.isInteger(definition.version) || definition.version < 1)
    throw new Error("invalid_preset_version")
  const parameters = resolveParameters(definition, values)
  const prompt = expandPrompt(definition.prompt, parameters)
  const presetRef = { id: definition.id, version: definition.version } as const
  if (definition.target === "global")
    return { target: definition.target, presetRef, prompt, parameters, patch: { markdown: prompt } }
  if (definition.target === "ai_transform")
    return {
      target: definition.target,
      presetRef,
      prompt,
      parameters,
      patch: { type: "ai_transform", prompt, preset: presetRef },
      presentation: definition.presentation
        ? { type: "presentation", policy: { ...definition.presentation } }
        : undefined,
      display:
        definition.id === "P09" && typeof parameters.summaryMaxGraphemes === "number"
          ? { type: "display", summaryMaxGraphemes: parameters.summaryMaxGraphemes }
          : undefined,
    }
  if (definition.target === "ai_aggregate.createPrompt")
    return {
      target: definition.target,
      presetRef,
      prompt,
      parameters,
      patch: { createPrompt: prompt, presets: { create: presetRef } },
    }
  if (definition.target === "ai_aggregate.updatePrompt")
    return {
      target: definition.target,
      presetRef,
      prompt,
      parameters,
      patch: { updatePrompt: prompt, presets: { update: presetRef } },
    }
  return {
    target: definition.target,
    presetRef,
    prompt,
    parameters,
    patch: { mode: "topic", createPrompt: prompt, presets: { create: presetRef } },
  }
}

function integerParameter(
  key: string,
  label: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
) {
  return { key, label, type: "integer" as const, required: false, defaultValue, minimum, maximum }
}
function optionalIntegerParameter(key: string, label: string, minimum: number, maximum: number) {
  return { key, label, type: "integer" as const, required: false, minimum, maximum }
}
function stringParameter(
  key: string,
  label: string,
  defaultValue: string,
  minimumLength: number,
  maximumLength: number,
  required = false,
) {
  return {
    key,
    label,
    type: "string" as const,
    required,
    ...(defaultValue ? { defaultValue } : {}),
    minimumLength,
    maximumLength,
  }
}
function resolveParameters(
  definition: PromptPreset,
  values: Record<string, string | number | undefined>,
) {
  const resolved: Record<string, string | number> = {}
  for (const parameter of definition.parameters) {
    const candidate = values[parameter.key] ?? parameter.defaultValue
    if (candidate === undefined || candidate === "") {
      if (parameter.required) throw new Error(`missing_preset_parameter:${parameter.key}`)
      continue
    }
    if (parameter.type === "integer") {
      if (
        typeof candidate !== "number" ||
        !Number.isInteger(candidate) ||
        candidate < parameter.minimum ||
        candidate > parameter.maximum
      )
        throw new Error(`invalid_preset_parameter:${parameter.key}`)
    } else if (
      typeof candidate !== "string" ||
      candidate.length < parameter.minimumLength ||
      candidate.length > parameter.maximumLength
    )
      throw new Error(`invalid_preset_parameter:${parameter.key}`)
    resolved[parameter.key] = candidate
  }
  if (
    Object.keys(values).some(
      (key) => !definition.parameters.some((parameter) => parameter.key === key),
    )
  )
    throw new Error("unknown_preset_parameter")
  return resolved
}
function expandPrompt(template: string, parameters: Record<string, string | number>) {
  const prompt = template.replace(/\{([^}]+)\}/g, (_placeholder, key: string) => {
    const value = parameters[key]
    if (value === undefined) throw new Error(`missing_preset_parameter:${key}`)
    return String(value)
  })
  if (/\{[^}]+\}/.test(prompt)) throw new Error("unresolved_preset_parameter")
  return prompt
}
