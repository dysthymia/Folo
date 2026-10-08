import type { SemanticEntity } from "@follow/information-core"
import {
  semanticEntitiesSchema,
  semanticEntityId,
  semanticEntitySchema,
} from "@follow/information-core"
import { z } from "zod"

import type { EvidenceCatalog } from "./processing-evidence"

export const SEMANTIC_ENTITY_REQUIREMENTS = `具体实体：在 entities 返回至多 8 个与本条主要事实直接相关的名称，没有可靠实体时返回 []。单条结果使用顶层 entities，分块观察使用 semantic.entities。
kind 区分 organization（公司/机构，如 Revolut、BitMine）、project（协议/项目）、product（明确的软件、产品或功能）、asset（币种/资产）。不得把机构名称一律当产品，也不因来源位于 Blockchain 类别就断定其领域。
name 使用原文明确出现的稳定名称与大小写；parentName 仅为原文明确指出的产品所属机构/项目，否则 null；aliases 仅列原文明确出现且指向同一对象的别名，不添加凭常识推断的名称。常见词与泛称不提取，顺带提及的对象也不提取。
每个实体必须提供当前目录中的 evidenceIds，证据须含 name、非空 parentName 和所有 aliases，并支持该实体类别及主要事实。confidence 如实给出；不足 0.9 的结果只供详情复核，不展示为列表标签。不同实体类别或所属关系不得合并；不做模糊名称合并。`

// 只接受所选原文里出现的名称；拉丁缩写必须完整匹配，避免把 ETHW/BETH 当作 ETH。
function containsName(quote: string, name: string) {
  const source = quote.normalize("NFKC").toLowerCase()
  const target = name.normalize("NFKC").toLowerCase()
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
  const left = /^[a-z0-9]/u.test(target) ? "(?<![a-z0-9])" : ""
  const right = /[a-z0-9]$/u.test(target) ? "(?![a-z0-9])" : ""
  return new RegExp(`${left}${escaped}${right}`, "u").test(source)
}

export function entitiesHaveEvidence(
  entities: readonly SemanticEntity[],
  resolve: EvidenceCatalog["resolve"],
) {
  return entities.every((entity) => {
    const quotes = entity.evidenceIds.map(resolve)
    if (quotes.some((quote) => !quote)) return false
    return [
      entity.name,
      ...(entity.parentName ? [entity.parentName] : []),
      ...entity.aliases,
    ].every((name) => quotes.some((quote) => quote !== null && containsName(quote, name)))
  })
}

// 输出 schema 绑定当前条目证据；其它条目的编号、无据名称与重复身份均被拒绝。
export function semanticEntitiesForCatalog(catalog: EvidenceCatalog) {
  const ids = catalog.fragments.map((fragment) => fragment.evidenceId)
  const schema = ids.length
    ? z
        .array(
          semanticEntitySchema.extend({
            evidenceIds: z
              .array(z.enum(ids as [string, ...string[]]))
              .min(1)
              .max(10),
          }),
        )
        .max(8)
    : semanticEntitiesSchema.max(0)
  return schema.superRefine((entities, context) => {
    if (!entitiesHaveEvidence(entities, catalog.resolve))
      context.addIssue({ code: "custom", message: "unsupported_entity_name" })
    if (new Set(entities.map(semanticEntityId)).size !== entities.length)
      context.addIssue({ code: "custom", message: "duplicate_semantic_entity" })
  })
}
