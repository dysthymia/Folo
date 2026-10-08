import { readableContentMaxWidthClassName } from "~/constants/ui"

export const girdClassNames = tw`grid grid-cols-1 @lg:grid-cols-2 @3xl:grid-cols-3 @6xl:grid-cols-4 @7xl:grid-cols-5 gap-1.5`

// Shared max-width styles for readable content
export const readableContentMaxWidth = tw`${readableContentMaxWidthClassName} mx-auto px-3`

// 所有条目视图共用淡灰色样式；保留点击和键盘操作，悬停时提高可读性。
export const entryDimmedClassName =
  "opacity-50 grayscale transition-opacity hover:opacity-80 focus-within:opacity-80"
