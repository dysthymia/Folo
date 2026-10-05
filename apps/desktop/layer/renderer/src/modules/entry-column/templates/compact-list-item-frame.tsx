import { cn } from "@follow/utils/utils"
import type { PropsWithChildren } from "react"

/** 全部列表与综述复用单行密度及未读点位置，避免两种身份出现不同的行高。 */
export function CompactListItemFrame({ read, children }: PropsWithChildren<{ read: boolean }>) {
  return (
    <div
      className={cn(
        "group relative flex cursor-menu items-center py-2",
        !read &&
          "before:absolute before:-left-4 before:top-[14px] before:block before:size-2 before:rounded-full before:bg-accent",
      )}
    >
      {children}
    </div>
  )
}
