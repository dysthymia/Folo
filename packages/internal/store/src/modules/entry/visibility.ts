import type { SubscriptionModel } from "../subscription/types"
import type { EntryModel } from "./types"

export const getEntrySubscriptionSourceIds = (
  entry: Pick<EntryModel, "feedId" | "inboxHandle" | "sources">,
) => {
  const ids = new Set<string>()

  for (const sourceId of entry.sources ?? []) {
    if (sourceId && sourceId !== "feed") {
      ids.add(sourceId)
    }
  }

  if (entry.feedId) {
    ids.add(entry.feedId)
  }

  if (entry.inboxHandle) {
    ids.add(`inbox/${entry.inboxHandle}`)
  }

  return Array.from(ids)
}

export const isEntryHiddenBySubscriptions = ({
  entry,
  excludePrivate,
  getSubscription,
}: {
  entry: Pick<EntryModel, "feedId" | "inboxHandle" | "sources">
  excludePrivate?: boolean
  getSubscription: (id: string) => SubscriptionModel | undefined
}) => {
  const subscriptions = getEntrySubscriptionSourceIds(entry)
    .map((id) => getSubscription(id))
    .filter((subscription): subscription is SubscriptionModel => !!subscription)

  if (subscriptions.length === 0) {
    return false
  }

  return subscriptions.every(
    (subscription) =>
      subscription.hideFromTimeline === true || (excludePrivate === true && subscription.isPrivate),
  )
}
