// 本地读取逐条列出，不能把同一路径的发布、试运行或外部同步操作当成只读查询。
const localGetPaths = [
  /^(?:automation\/(?:editor|status)|configuration(?:\/effective)?)$/u,
  /^(?:rules(?:\/[^/]+)?|global-instructions|subscription-tags|source-tags)$/u,
  /^(?:schedule|runs|inputs|rule-set-releases(?:\/\d+)?)$/u,
  /^(?:reading-snapshot|research-pack\/[^/]+|research-packs(?:\/[^/]+)?)$/u,
  /^stories(?:\/[^/]+(?:\/revisions\/\d+|\/split-preview)?)?$/u,
  /^processing\/(?:model-catalog|model-settings|roles|entry-results|semantic-tags|entries)$/u,
  /^processing\/entries\/\d+(?:\/(?:explanation|semantics|events|duplicates))?$/u,
  /^processing\/events(?:\/[^/]+(?:\/members)?)?$/u,
  /^processing\/stories\/[^/]+\/(?:digest|reader-state)$/u,
  /^processing\/(?:generated-feeds|generated-feed\/(?:stats|items|entries\/[^/]+))$/u,
  /^(?:feedback|diagnostics|integrations\/settings|exports(?:\/[^/]+)?|x\/(?:settings|queries))$/u,
]

const localPostPaths = [
  /^(?:rules\/preview|rule-set-releases\/preview|reading-snapshot(?:\/refresh)?)$/u,
  /^processing\/(?:semantics\/query|events(?:\/[^/]+\/members)?)$/u,
  /^processing\/entries\/\d+\/duplicates$/u,
  /^processing\/stories\/[^/]+\/digest$/u,
  /^processing\/generated-feed\/(?:items|locate)$/u,
]

export function isLocalInformationRead(method: string, path: string, body?: unknown): boolean {
  const verb = method.toUpperCase()
  if (/^\/information\/api\/(?:snapshot|settings)$/u.test(path))
    return (verb === "GET" || verb === "POST") && body === undefined
  const route = path.replace(/^\/information\/v1\//u, "").replace(/^\//u, "")
  if (
    route === "processing/generated-feed/items" &&
    body !== null &&
    typeof body === "object" &&
    "mode" in body &&
    body.mode === "collections" &&
    "refresh" in body &&
    body.refresh === true
  )
    // 官方收藏的显式刷新实际会联网，不能混入离线读取路径。
    return false
  return (verb === "GET" ? localGetPaths : verb === "POST" ? localPostPaths : []).some((pattern) =>
    pattern.test(route),
  )
}
