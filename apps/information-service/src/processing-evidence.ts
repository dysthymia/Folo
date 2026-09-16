import { z } from "zod"

export const evidenceFactSelectionSchema = z
  .object({
    text: z.string().min(1).max(2_000),
    evidenceId: z.string().min(1).max(80),
    kind: z.enum(["fact", "source_claim", "inference"]),
  })
  .strict()

export type EvidenceFactSelection = z.infer<typeof evidenceFactSelectionSchema>
export type EvidenceFragment = { evidenceId: string; quote: string }
export type EvidenceCatalog = {
  fragments: readonly EvidenceFragment[]
  resolve: (evidenceId: string) => string | null
  identify: (quote: string) => string | null
}
export type EvidenceCatalogOptions = { prefix?: string; maxFragmentChars?: number }

const MAX_QUOTE_CHARS = 4_000
const prefixPattern = /^[A-Za-z][\w-]{0,31}$/u

// 原文只出现一次；模型选择编号，服务端持有编号到连续原文的唯一映射。
export function createEvidenceCatalog(
  text: string,
  options: EvidenceCatalogOptions = {},
): EvidenceCatalog {
  const maxFragmentChars = options.maxFragmentChars ?? MAX_QUOTE_CHARS
  validateOptions(options.prefix, maxFragmentChars)
  const quotes: string[] = []
  const sentenceSegmenter = new Intl.Segmenter("und", { granularity: "sentence" })
  // 先保留换行定义的段落边界，再按句子切分；硬上限只在 grapheme 边界继续拆分。
  for (const paragraph of text.split(/(?<=\n)/u))
    for (const sentence of sentenceSegmenter.segment(paragraph))
      quotes.push(...splitAtGraphemeBoundary(sentence.segment, maxFragmentChars))
  return catalogFromQuotes(quotes, options.prefix ?? "E", false)
}

export function createEvidenceCatalogFromQuotes(
  quotes: readonly string[],
  options: Pick<EvidenceCatalogOptions, "prefix"> = {},
): EvidenceCatalog {
  validateOptions(options.prefix, MAX_QUOTE_CHARS)
  return catalogFromQuotes(quotes, options.prefix ?? "E", true)
}

export function renderEvidenceCatalog(catalog: EvidenceCatalog): string {
  return JSON.stringify(
    catalog.fragments.map((fragment) => ({
      evidenceId: fragment.evidenceId,
      text: fragment.quote,
    })),
  )
}

export function materializeEvidenceFacts(
  catalog: EvidenceCatalog,
  selections: readonly EvidenceFactSelection[],
): Array<{ text: string; quote: string; kind: EvidenceFactSelection["kind"] }> {
  return selections.map(({ evidenceId, ...selection }) => {
    const quote = catalog.resolve(evidenceId)
    if (quote === null) throw new Error("invalid_model_reference")
    return { ...selection, quote }
  })
}

function catalogFromQuotes(quotes: readonly string[], prefix: string, deduplicate: boolean) {
  const fragments: EvidenceFragment[] = []
  const byQuote = new Map<string, string>()
  for (const quote of quotes) {
    if (!quote.trim()) continue
    if (quote.length > MAX_QUOTE_CHARS) throw new Error("invalid_evidence_fragment")
    if (deduplicate && byQuote.has(quote)) continue
    const evidenceId = `${prefix}${String(fragments.length + 1).padStart(6, "0")}`
    fragments.push({ evidenceId, quote })
    if (!byQuote.has(quote)) byQuote.set(quote, evidenceId)
  }
  const byId = new Map(fragments.map((fragment) => [fragment.evidenceId, fragment.quote]))
  return {
    fragments,
    resolve: (evidenceId: string) => byId.get(evidenceId) ?? null,
    identify: (quote: string) => byQuote.get(quote) ?? null,
  } satisfies EvidenceCatalog
}

function splitAtGraphemeBoundary(text: string, maxChars: number): string[] {
  const parts: string[] = []
  let current = ""
  for (const segment of new Intl.Segmenter("und", { granularity: "grapheme" }).segment(text)) {
    if (segment.segment.length > maxChars) throw new Error("invalid_evidence_fragment")
    if (current && current.length + segment.segment.length > maxChars) {
      parts.push(current)
      current = ""
    }
    current += segment.segment
  }
  if (current) parts.push(current)
  return parts
}

function validateOptions(prefix: string | undefined, maxFragmentChars: number) {
  if (prefix !== undefined && !prefixPattern.test(prefix))
    throw new Error("invalid_evidence_prefix")
  if (
    !Number.isSafeInteger(maxFragmentChars) ||
    maxFragmentChars < 1 ||
    maxFragmentChars > MAX_QUOTE_CHARS
  )
    throw new Error("invalid_evidence_fragment_size")
}
