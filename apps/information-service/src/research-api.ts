import { z } from "zod"

import { AutomationError } from "./automation-store"
import type { PublishedDecision } from "./processing-decision"
import { researchRequestSchema } from "./research-store"
import type { Store } from "./store"

// 只摘录规则身份和已经解析的策略；不把私人 Prompt、模型配置或凭据写入研究文件。
function materialSection(store: Store, published: PublishedDecision) {
  const { input, decision } = published
  const release =
    input.releaseVersion === null ? null : store.automation.release(input.releaseVersion)
  return [
    `### 材料 ${input.seq}：${input.body.title}`,
    `- 原条目：${input.sourceKey} / ${input.itemId}`,
    `- 原始链接：${input.body.url ?? "无外部链接"}`,
    `- 发表时间：${input.body.publishedAt ?? "未知"}；采集时间：${input.receivedAt}`,
    `- 材料完整性：${store.processingState.material(input) ?? "未确认"}`,
    `- 内容版本：${input.contentVersion}；决定：${published.decisionId}`,
    `- 处理规则：发布版本 ${input.releaseVersion ?? "未知"}，规则数 ${release?.rules.length ?? "未知"}`,
    `- 展示／综合／改写：${decision.policy.standalone} / ${decision.policy.aggregation} / ${decision.policy.rewrite}`,
    "",
    decision.summary,
    "",
    ...decision.facts.map(
      (fact, index) =>
        `[${input.seq}.${index + 1}] ${fact.kind}：${fact.text}\n> ${fact.quote.replaceAll("\n", "\n> ")}`,
    ),
  ].join("\n")
}

export function researchApi(
  store: Store,
  method: string,
  path: string,
  body: unknown,
): object | undefined {
  if (path === "/research-packs") {
    if (method === "GET") return { packs: store.research.list() }
    if (method === "POST") {
      const request = researchRequestSchema.parse(body)
      const decisions = store.processingState.published()
      let title: string
      let summary: string
      let materials: PublishedDecision[]
      if (request.target.kind === "story") {
        const pack = store.reading.researchPack(request.target.storyId)
        const current = store.stories.resolveLink(request.target.storyId)
        if (pack.status !== "ready" || current.kind !== "current")
          throw new AutomationError("invalid_target")
        title = pack.title
        summary = pack.markdown
        const memberIds = new Set(current.revision.members.map((member) => member.inputSeq))
        materials = decisions.filter((decision) => memberIds.has(decision.input.seq))
        // 保留句子到原文片段的显式映射，事实支持程度仍需后续研究核查。
        summary += `\n\n## 引用映射\n${current.revision.citations
          .map((citation) => {
            const span = current.revision.sourceSpans.find(
              (candidate) => candidate.id === citation.sourceSpanId,
            )!
            return `- ${citation.id}：句子 ${citation.sentenceId} → 材料 ${span.inputSeq} / 片段 ${span.fragmentId}\n> ${span.quote.replaceAll("\n", "\n> ")}`
          })
          .join("\n")}`
      } else {
        const seq = request.target.inputSeq
        const published = decisions.find((decision) => decision.input.seq === seq)
        if (!published) throw new AutomationError("invalid_target")
        title = published.decision.title
        summary = published.decision.summary
        materials = [published]
      }
      const markdown = [
        `# ${title}`,
        "",
        "状态：已准备。文件生成不代表已提交研究或研究完成。",
        "",
        "## 用户问题",
        request.question,
        "",
        "## 研究目标",
        request.goal,
        "",
        "## 已知待验证问题",
        ...request.knownQuestions.map((question) => `- ${question}`),
        ...(request.knownQuestions.length
          ? []
          : ["- 尚未指定，请在研究时检查来源差异及引用支持程度。"]),
        "",
        "## 当前处理结果与主要差异",
        summary,
        "",
        "## 材料与处理依据",
        ...materials.map((material) => materialSection(store, material)),
      ].join("\n")
      return { pack: store.research.prepare(request, title, markdown) }
    }
  }
  const target = /^\/research-packs\/([^/]+)$/.exec(path)
  if (target) {
    const id = z.uuid().parse(target[1])
    if (method === "GET") return { pack: store.research.get(id) }
    if (method === "PUT") {
      const input = z
        .object({
          expectedRevision: z.number().int().positive(),
          status: z.enum(["submitted", "completed"]),
          reference: z.string().trim().min(1).max(4000),
        })
        .strict()
        .parse(body)
      return {
        pack: store.research.transition(id, input.expectedRevision, input.status, input.reference),
      }
    }
  }
  return undefined
}
