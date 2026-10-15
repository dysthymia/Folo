type SchemaObject = Record<string, unknown>

function object(value: unknown): value is SchemaObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// 改写为紧凑协议后移除已不可达的旧联合定义，否则模型仍会读到整份旧契约。
function pruneDefinitions(schema: SchemaObject): SchemaObject {
  if (!object(schema.$defs)) return schema
  const definitions = schema.$defs
  const reachable = new Set<string>()
  const visit = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(visit)
    if (!object(value)) return
    if (typeof value.$ref === "string" && value.$ref.startsWith("#/$defs/")) {
      const name = value.$ref
        .slice("#/$defs/".length)
        .split("/")[0]!
        .replaceAll("~1", "/")
        .replaceAll("~0", "~")
      if (!reachable.has(name)) {
        reachable.add(name)
        visit(definitions[name])
      }
    }
    Object.values(value).forEach(visit)
  }
  const { $defs: _definitions, ...root } = schema
  visit(root)
  return reachable.size
    ? {
        ...root,
        $defs: Object.fromEntries([...reachable].map((name) => [name, definitions[name]])),
      }
    : root
}

// Zod 的局部引用名称不同也可能指向同一结构；先展开非递归引用，再按实际结构共享。
function inlineDefinitions(schema: SchemaObject): SchemaObject {
  if (!object(schema.$defs)) return schema
  const definitions = schema.$defs
  const expand = (value: unknown, active: ReadonlySet<string>): unknown => {
    if (Array.isArray(value)) return value.map((item) => expand(item, active))
    if (!object(value)) return value
    if (
      Object.keys(value).length === 1 &&
      typeof value.$ref === "string" &&
      value.$ref.startsWith("#/$defs/")
    ) {
      const name = value.$ref.slice("#/$defs/".length)
      if (!active.has(name) && definitions[name])
        return expand(definitions[name], new Set([...active, name]))
    }
    return Object.fromEntries(
      Object.entries(value).map(([field, item]) => [field, expand(item, active)]),
    )
  }
  const { $defs: _definitions, ...root } = schema
  return pruneDefinitions({ ...(expand(root, new Set()) as SchemaObject), $defs: definitions })
}

// 标签名称和定义版本由程序拥有；线上只请求按标签键索引的评估，避免重复展开整个判别联合。
export function keyedTagAssessmentsSchema(schema: SchemaObject): SchemaObject {
  const resolve = (value: unknown): SchemaObject | null => {
    if (!object(value)) return null
    if (typeof value.$ref !== "string") return value
    if (!value.$ref.startsWith("#/$defs/") || !object(schema.$defs)) return null
    return resolve(schema.$defs[value.$ref.slice("#/$defs/".length)])
  }
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit)
    if (!object(value)) return value
    const result = Object.fromEntries(
      Object.entries(value).map(([field, item]) => [field, visit(item)]),
    )
    if (!object(result.properties) || !result.properties.tagAssessments) return result
    const assessments = resolve(result.properties.tagAssessments)
    const items = resolve(assessments?.items)
    if (!items) return result
    const properties: SchemaObject = {}
    for (const candidate of Array.isArray(items.anyOf) ? items.anyOf : [items]) {
      const variant = resolve(candidate)
      if (!variant || !object(variant.properties)) return result
      const id = resolve(variant.properties.tagId)
      const tagId = id?.const ?? (Array.isArray(id?.enum) ? id.enum[0] : undefined)
      if (typeof tagId !== "string") return result
      properties[tagId] = {
        ...variant,
        properties: Object.fromEntries(
          Object.entries(variant.properties).filter(
            ([field]) => !["tagId", "definitionVersion"].includes(field),
          ),
        ),
        required: Array.isArray(variant.required)
          ? variant.required.filter(
              (field) => !["tagId", "definitionVersion"].includes(String(field)),
            )
          : [],
      }
    }
    result.properties.tagAssessments = {
      type: "object",
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    }
    return result
  }
  return visit(schema) as SchemaObject
}

// 只引用结构完全相同的契约片段，保留证据、标签、必填字段和严格对象约束。
export function compactModelSchema(schema: SchemaObject): SchemaObject {
  schema = inlineDefinitions(schema)
  const repeated = new Map<string, { count: number; schema: SchemaObject }>()
  const key = (value: unknown) => {
    if (
      !object(value) ||
      (typeof value.type !== "string" &&
        !Array.isArray(value.type) &&
        !Array.isArray(value.anyOf) &&
        !Array.isArray(value.oneOf) &&
        !Array.isArray(value.allOf))
    )
      return null
    const serialized = JSON.stringify(value)
    return serialized.length >= 64 ? serialized : null
  }
  const collect = (value: unknown) => {
    const identity = key(value)
    if (identity && object(value)) {
      const previous = repeated.get(identity)
      repeated.set(identity, { count: (previous?.count ?? 0) + 1, schema: value })
    }
    if (Array.isArray(value)) value.forEach(collect)
    else if (object(value)) Object.values(value).forEach(collect)
  }
  collect(schema)
  const definitions = object(schema.$defs) ? schema.$defs : {}
  const names = new Map<string, string>()
  let index = 0
  for (const [identity, item] of repeated) {
    if (item.count < 2) continue
    let name: string
    do name = `S${index++}`
    while (name in definitions)
    names.set(identity, name)
  }
  const rewrite = (value: unknown, root = false): unknown => {
    const identity = key(value)
    const name = identity ? names.get(identity) : undefined
    if (!root && name) return { $ref: `#/$defs/${name}` }
    if (Array.isArray(value)) return value.map((item) => rewrite(item))
    if (object(value))
      return Object.fromEntries(
        Object.entries(value).map(([field, item]) => [field, rewrite(item)]),
      )
    return value
  }
  const result = rewrite(schema, true) as SchemaObject
  if (!names.size) return pruneDefinitions(result)
  result.$defs = {
    ...(object(result.$defs) ? result.$defs : {}),
    ...Object.fromEntries(
      [...names].map(([identity, name]) => [name, rewrite(repeated.get(identity)!.schema, true)]),
    ),
  }
  return pruneDefinitions(result)
}
