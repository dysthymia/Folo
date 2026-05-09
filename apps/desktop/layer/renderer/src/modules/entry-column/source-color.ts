import type { CSSProperties } from "react"

export type EntrySourceColorStyle = CSSProperties & {
  "--entry-source-background": string
  "--entry-source-background-hover": string
  "--entry-source-background-read": string
  "--entry-source-background-read-hover": string
}

export type EntrySourceColor = {
  hue: number
  saturation: number
}

const cleanSourceKey = (sourceKey: string) => sourceKey.replaceAll(/[^\p{L}\s]/gu, "")

export const getEntrySourceColor = (sourceKey: string): EntrySourceColor => {
  let hash = 0

  for (let index = 0; index < sourceKey.length; index++) {
    const divisor = index !== 0 ? sourceKey.length % index : 1
    const codePoint = sourceKey.codePointAt(index) ?? 0
    const remainder = divisor !== 0 ? codePoint % divisor : codePoint
    hash += remainder
  }

  return {
    hue: ((hash % 36) + 1) * 10,
    saturation: 30 + ((hash % 5) + 1) * 10,
  }
}

export const getEntrySourceColorStyle = (
  sourceKey: string | null | undefined,
): EntrySourceColorStyle | undefined => {
  const normalizedSourceKey = sourceKey ? cleanSourceKey(sourceKey).trim() : ""
  if (!normalizedSourceKey) return undefined

  const { hue, saturation } = getEntrySourceColor(normalizedSourceKey)

  return {
    "--entry-source-background": `hsl(${hue}, ${saturation}%, 80%)`,
    "--entry-source-background-hover": `hsl(${hue}, ${saturation}%, 85%)`,
    "--entry-source-background-read": `hsl(${hue}, ${saturation}%, 90%)`,
    "--entry-source-background-read-hover": `hsl(${hue}, ${saturation}%, 95%)`,
  }
}
