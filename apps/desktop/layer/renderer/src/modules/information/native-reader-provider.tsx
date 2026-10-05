import type { PropsWithChildren } from "react"

import { NativeReaderContext } from "./native-reader-context"
import type { GeneratedReaderOptions } from "./use-generated-reader"
import { useGeneratedReader } from "./use-generated-reader"

/** Provider 随原生布局持续挂载，普通行消费 Context 时不初始化网络或认证模块。 */
export function NativeReaderProvider({
  children,
  ...options
}: PropsWithChildren<GeneratedReaderOptions>) {
  const reader = useGeneratedReader(options)
  return <NativeReaderContext value={reader}>{children}</NativeReaderContext>
}
