import { cn } from "@follow/utils/utils"
import type { HTMLAttributes, ReactNode } from "react"

import { feedColumnStyles } from "./styles"

// 官方来源与私人生成来源只共享呈现，身份、拖动和持久化各自留在调用层。
export const sourceRowClassName = cn(feedColumnStyles.item, "justify-between py-0.5")

export function SourceRowContent({
  children,
  trailing,
  leadingClassName,
}: {
  children: ReactNode
  trailing?: ReactNode
  leadingClassName?: string
}) {
  return (
    <>
      <div className={cn("flex min-w-0 items-center", leadingClassName)}>{children}</div>
      {trailing}
    </>
  )
}

export function SourceRow({
  children,
  trailing,
  leadingClassName,
  className,
  renderContainer,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  trailing?: ReactNode
  leadingClassName?: string
  renderContainer?: (props: HTMLAttributes<HTMLDivElement>) => ReactNode
}) {
  const rowProps: HTMLAttributes<HTMLDivElement> = {
    ...props,
    className: cn(sourceRowClassName, className),
    children: (
      <SourceRowContent trailing={trailing} leadingClassName={leadingClassName}>
        {children}
      </SourceRowContent>
    ),
  }
  // 官方行可保留原拖动容器，生成行使用普通容器；两者经过同一呈现外壳。
  return renderContainer ? renderContainer(rowProps) : <div {...rowProps} />
}
