import type { UnifiedRuleRow, UnifiedRuleScope } from "./unified-action-list"

/**
 * 处理服务详情的虚拟选中项（§2 D2）。
 *
 * 统一列表把三种执行位置合并成一个列表后，规则详情只在「选中某条规则」时挂载。
 * 但处理服务规则集为空时（新账号，或规则被全部删除）列表里没有任何 `processing_service`
 * 行，`?scope=processing_service` 深链就选不中任何东西——而它正是 `information-user-guide`
 * 记录的入口，结果是界面上没有任何路径可以新建第一条处理服务规则。
 * 用这个虚拟 id 让详情面板可以脱离规则行挂载：它不参与列表高亮，只用来渲染详情。
 */
export const PROCESSING_DETAIL_SELECTION = "processing_service:__detail__"

export const isProcessingDetailSelection = (id: string | null): boolean =>
  id === PROCESSING_DETAIL_SELECTION

/**
 * 请求的执行位置：`?scope=` 显式指定优先；未指定（或给了不认识的值）时本机部署默认进入
 * 处理服务（§4 P0-2 第一步），其余环境保持未选中——不假装有能力，交给空占位说明。
 */
export const resolveRequestedScope = ({
  requested,
  local,
}: {
  requested: string | null
  local: boolean
}): UnifiedRuleScope | null => {
  if (requested === "cloud" || requested === "local") return requested
  return local ? "processing_service" : null
}

/**
 * `?scope=` / 默认执行位置的初始选中：
 * 先选该执行位置的第一条规则；该位置没有规则时，只有处理服务可以回落成详情面板
 * （见 `PROCESSING_DETAIL_SELECTION`），其余位置不选中，交给空占位。
 */
export const resolveInitialSelection = ({
  scope,
  rows,
  canOpenProcessingDetail,
}: {
  scope: UnifiedRuleScope | null
  rows: readonly Pick<UnifiedRuleRow, "id" | "scope">[]
  canOpenProcessingDetail: boolean
}): string | null => {
  if (!scope) return null
  const first = rows.find((row) => row.scope === scope)
  if (first) return first.id
  if (scope === "processing_service" && canOpenProcessingDetail) return PROCESSING_DETAIL_SELECTION
  return null
}
