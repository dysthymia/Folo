import { FeedViewType } from "@follow/constants"

import { RelativeTime } from "~/components/ui/datetime"
import { Media } from "~/components/ui/media/Media"
import { FeedIcon } from "~/modules/feed/feed-icon"
import { FeedTitle } from "~/modules/feed/feed-title"

import type { EntryItemStatelessProps, UniversalItemProps } from "../types"
import { AllItem } from "./all-item"
import { ListItemSkeleton } from "./list-item"

export function ArticleItem({ view = FeedViewType.Articles, ...props }: UniversalItemProps) {
  // 文章复用全部的紧凑单行布局，并保留文章视图的操作上下文。
  return <AllItem {...props} view={view} />
}

ArticleItem.wrapperClassName = AllItem.wrapperClassName

export function ArticleItemStateLess({ entry, feed }: EntryItemStatelessProps) {
  return (
    <div className="group relative flex py-4">
      <FeedIcon target={feed} fallback className="mr-2 size-5" />
      <div className="-mt-0.5 min-w-0 flex-1 text-sm leading-tight">
        <div className="flex gap-1 text-[10px] font-bold text-text-secondary">
          <FeedTitle feed={feed} />
          <span>·</span>
          <span>{!!entry.publishedAt && <RelativeTime date={entry.publishedAt} />}</span>
        </div>
        <div className="relative my-0.5 truncate break-words font-medium text-text">
          {entry.title}
        </div>
        <div className="truncate text-[13px] text-text-secondary">{entry.description}</div>
      </div>
      {entry.media?.[0] && (
        <Media
          thumbnail
          src={entry.media[0].url}
          type={entry.media[0].type}
          previewImageUrl={entry.media[0].preview_image_url}
          className="ml-2 size-20 shrink-0 overflow-hidden rounded"
          mediaContainerClassName="w-auto h-auto rounded"
          loading="lazy"
          proxy={{
            width: 160,
            height: 160,
          }}
          height={entry.media[0].height}
          width={entry.media[0].width}
          blurhash={entry.media[0].blurhash}
        />
      )}
    </div>
  )
}

// 加载占位也使用相同的行高，避免切换到文章列表时先出现大卡片。
export const ArticleItemSkeleton = ListItemSkeleton
