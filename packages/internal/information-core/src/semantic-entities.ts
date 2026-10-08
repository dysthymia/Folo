import { z } from "zod"

export const SEMANTIC_ENTITY_VERSION = 1

const entityNameSchema = z.string().trim().min(1).max(100)

// 实体必须有输入证据；别名仅记录证据明确给出的名字，后端负责核验对应关系。
export const semanticEntitySchema = z
  .object({
    kind: z.enum(["organization", "project", "product", "asset"]),
    name: entityNameSchema,
    parentName: entityNameSchema.nullable(),
    aliases: z.array(entityNameSchema).max(5),
    confidence: z.number().min(0).max(1),
    evidenceIds: z.array(z.string().min(1).max(200)).min(1).max(10),
  })
  .strict()

export type SemanticEntity = z.infer<typeof semanticEntitySchema>
export const semanticEntitiesSchema = z.array(semanticEntitySchema).max(8)

const normalizeEntityName = (name: string): string => name.normalize("NFKC").trim().toLowerCase()

// 只规范化 Unicode、大小写和首尾空白，不按拼写相似度或别名合并实体。
export const semanticEntityId = (
  entity: Pick<SemanticEntity, "kind" | "name" | "parentName">,
): string =>
  JSON.stringify([
    entity.kind,
    normalizeEntityName(entity.name),
    entity.parentName === null ? null : normalizeEntityName(entity.parentName),
  ])
