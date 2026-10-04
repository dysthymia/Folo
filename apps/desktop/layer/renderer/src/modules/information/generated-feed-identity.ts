import type { GeneratedReaderItem } from "./generated-feed-client"

// 页内稳定身份不含修订号；缓存也可复用，避免为纯身份计算初始化网络客户端。
export const generatedItemKey = (item: GeneratedReaderItem) =>
  item.kind === "story" ? `story:${item.id}` : `entry:${item.sourceKey}:${item.id}`
