import { parseHTML } from "linkedom"

import type { SourceEntry } from "./folo"
import { sourceText } from "./service"

type ContextKind = "quote" | "thread" | "images" | "links"
const incompleteText = /\b(?:show more|tweet unavailable)\b|显示更多|展开全文/iu
const quotePlaceholder =
  /^(?:quoted (?:tweet|post)|original (?:tweet|post)|view (?:tweet|post)|引用原帖|查看原帖|原帖不可用)[\s.:：…]*$/iu

// 只识别明确依赖正文的教程/报告链接，不按短文长度抓取普通新闻、广告或所有外链。
export function requiredMaterialLinks(entry: SourceEntry): string[] {
  const { document } = parseHTML(
    `<html><body>${entry.originalContent ?? entry.content ?? ""}</body></html>`,
  )
  for (const node of document.querySelectorAll("script,style,noscript,iframe,blockquote"))
    node.remove()
  const text = sourceText(document.body.innerHTML)
  const material = /教程|指南|文档|论文|报告|研究全文|tutorial|guide|documentation|paper|report/iu
  const dependency =
    /详见|详细.{0,12}(?:见|链接|这里|原文)|完整.{0,12}(?:见|链接|阅读)|(?:全文|完整教程|完整指南|原文).{0,12}(?:见|链接|阅读)|(?:内容|步骤|方法).{0,8}见(?:原文|链接|这里)|read (?:the )?(?:full|complete)|full (?:tutorial|guide|report|paper)|details? (?:at|in|here)/iu
  if (!material.test(text) || !dependency.test(text)) return []
  // 多段实质正文证明这是一篇文章；尾部通用“Full Report”只是拓展 CTA，不能反推原文缺失。
  // 长摘录若明确声明摘要、缺少步骤或截断，仍必须补读，不能仅凭长度豁免。
  const substantialArticle =
    !/https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\//iu.test(entry.url ?? "") &&
    text.length >= 2000 &&
    [...document.querySelectorAll("p")].filter(
      (paragraph) => sourceText(paragraph.innerHTML).length >= 120,
    ).length >= 3
  const explicitDependency =
    /(?:本文|本帖|以下|这里|此处).{0,16}(?:仅|只是|只提供|只展示).{0,12}(?:摘要|摘录|节选|预览)|(?:正文|详细步骤|完整步骤|后续步骤|关键步骤|具体方法).{0,16}(?:未提供|未包含|见原文|见链接|详见|在链接)|(?:this (?:article|post)|below).{0,30}(?:only|just|excerpt|summary)|(?:remaining|detailed|full) (?:steps|instructions).{0,30}(?:link|original|elsewhere)|全文未完|正文截断|展开全文|show more/iu
  const requiresTarget = (localText: string, targetCount: number) =>
    !substantialArticle ||
    explicitDependency.test(localText) ||
    (targetCount === 1 && explicitDependency.test(text))
  const urls = new Set<string>()
  const anchors = [...document.querySelectorAll("a[href]")]
  for (const link of anchors) {
    const localText = sourceText(link.closest("p,li,div")?.innerHTML ?? link.outerHTML)
    if (!requiresTarget(localText, anchors.length)) continue
    // 多链接帖子只抓明确正文引用所在段落；单一目标允许承接上一段的“详见原文”。
    if (anchors.length > 1 && !(material.test(localText) && dependency.test(localText))) continue
    try {
      const url = new URL(link.getAttribute("href")!, entry.url ?? undefined)
      if (!["http:", "https:"].includes(url.protocol)) continue
      if (entry.url) {
        const original = new URL(entry.url)
        if (original.origin === url.origin && original.pathname === url.pathname) continue
      }
      url.hash = ""
      urls.add(url.href)
    } catch {
      /* 无效引用只保留原文，不把不明地址变成网络请求。 */
    }
  }
  // 纯文本导出也保留实际 URL；多链接时逐段核对引用依赖，去掉句尾标点再规范化。
  const lines = text.split(/\n+/u)
  const plainUrls = [...text.matchAll(/https?:\/\/[^\s<>"']+/giu)]
  for (const [index, line] of lines.entries()) {
    const previous = lines[index - 1] ?? ""
    if (!requiresTarget(`${previous}\n${line}`, plainUrls.length)) continue
    const explicit = material.test(line) && dependency.test(line)
    const continued =
      material.test(previous) &&
      dependency.test(previous) &&
      !/https?:\/\//iu.test(previous) &&
      /^(?:原文|链接|全文|教程|报告)?[：: ]*https?:\/\/\S+$/iu.test(line.trim())
    if (plainUrls.length > 1 && !explicit && !continued) continue
    for (const match of line.matchAll(/https?:\/\/[^\s<>"']+/giu)) {
      const raw = match[0].replace(/[),.;!?…，。；！？、）】》]+$/u, "")
      try {
        const url = new URL(raw)
        if (entry.url) {
          const original = new URL(entry.url)
          if (original.origin === url.origin && original.pathname === url.pathname) continue
        }
        url.hash = ""
        urls.add(url.href)
      } catch {
        /* 文本地址不完整时不发请求，不从展示名称猜测目标。 */
      }
    }
  }
  return [...urls]
}

// 只把材料实际包含的引用正文与完整编号串文记为已读；普通链接不代表缺引用。
export function inspectMaterialContext(entry: SourceEntry) {
  const missing: Array<"text" | ContextKind> = []
  const verified: NonNullable<SourceEntry["context"]> = {}
  const content = entry.content ?? ""
  const text = sourceText(content)
  if (!text) missing.push("text")
  const links = requiredMaterialLinks(entry)
  if (links.length) {
    const complete = links.every((url) =>
      entry.linkedMaterials?.some(
        (material) =>
          material.url === url &&
          material.status === "complete" &&
          material.content &&
          text.includes(material.content.trim()),
      ),
    )
    if (complete) verified.links = "complete"
    else missing.push("links")
  }
  // links 状态由本次真实依赖目标决定；旧误判的拓展链接失败不得永久挡住已完整的原文。
  const isX = /https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\//iu.test(entry.url ?? "")
  if (!isX) return { missing, verified }
  const contextContent = entry.originalContent ?? content
  const contextText = sourceText(contextContent)
  if (incompleteText.test(contextText)) missing.push("text")
  const { document } = parseHTML(`<html><body>${contextContent}</body></html>`)
  const quotes = [...document.querySelectorAll("blockquote")]
  const embeddedQuote = quotes.some((quote) => {
    const clone = quote.cloneNode(true) as typeof quote
    for (const link of clone.querySelectorAll("a,script,style,iframe")) link.remove()
    const body = (clone.textContent ?? "").trim()
    return Boolean(
      body &&
      !quotePlaceholder.test(body) &&
      !incompleteText.test(body) &&
      !/[.…]{3}|…$/u.test(body),
    )
  })
  if (embeddedQuote) verified.quote = "complete"
  const quoteRequired =
    !embeddedQuote &&
    (quotes.length > 0 ||
      /引用原帖(?:未读取|不可用|见链接)|quoted (?:tweet|post) (?:unavailable|not loaded)|原帖不可用/iu.test(
        contextText,
      ))

  // 编号表示真实材料分段时，所有分段都存在才核验完整；提到 thread 或推荐链接不要求补读。
  const parts = [...contextText.matchAll(/(?:^|\n)\s*(\d+)\/(\d+)\s+([^\n]+)/gu)]
  const expected = parts[0] ? Number(parts[0][2]) : 0
  const fullThread =
    expected > 1 &&
    expected <= 200 &&
    parts.length === expected &&
    parts.every(
      (part, index) =>
        Number(part[1]) === index + 1 &&
        Number(part[2]) === expected &&
        part[3]!.trim() &&
        !incompleteText.test(part[3]!),
    )
  if (fullThread) verified.thread = "complete"
  const threadRequired =
    !fullThread &&
    ((parts.length > 0 && expected > 1) ||
      /thread continues|串文未完|后续串文未读取|线程内容未加载/iu.test(contextText))

  const hasImages = document.querySelector("img") !== null || (entry.imageCount ?? 0) > 0
  const outsideQuotes = document.body.cloneNode(true) as typeof document.body
  for (const node of outsideQuotes.querySelectorAll("blockquote,a,img,script,style,iframe"))
    node.remove()
  const ownText = (outsideQuotes.textContent ?? "").trim()
  // 关键图表/截图指向且只有简短说明时保守待补；自足正文和装饰图不因图片存在被整体阻断。
  const imageDependent =
    /见图|看图|图中|如图|图表|截图|图片里|see (?:the )?(?:image|chart|screenshot)|in (?:the )?(?:image|chart)|chart below/iu.test(
      ownText,
    )
  const sparseCaption =
    ownText.replace(/\s/gu, "").length <= 120 && ownText.split(/\s+/u).length <= 24
  const imagesRequired = hasImages && imageDependent && sparseCaption
  for (const [kind, required] of [
    ["quote", quoteRequired],
    ["thread", threadRequired],
    ["images", imagesRequired],
  ] as const) {
    const state = verified[kind] ?? entry.context?.[kind]
    if ((required || state === "missing" || state === "failed") && state !== "complete")
      missing.push(kind)
  }
  return { missing: [...new Set(missing)], verified }
}

export function missingMaterialContext(entry: SourceEntry) {
  return inspectMaterialContext(entry).missing
}
