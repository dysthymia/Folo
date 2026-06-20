const normalizeCount = (value: number) => {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

export const getInitialSelectedItemIds = (itemCount: number, remainingQuota: number) => {
  const selectedCount = Math.min(normalizeCount(remainingQuota), normalizeCount(itemCount))

  return new Set(Array.from({ length: selectedCount }, (_, index) => index.toString()))
}

export const addSelectedItemIdsWithinQuota = (
  currentItems: Set<string>,
  itemIds: string[],
  remainingQuota: number,
) => {
  const nextItems = new Set(currentItems)
  const normalizedRemainingQuota = normalizeCount(remainingQuota)

  for (const itemId of itemIds) {
    if (nextItems.has(itemId)) {
      continue
    }

    if (nextItems.size >= normalizedRemainingQuota) {
      break
    }

    nextItems.add(itemId)
  }

  return nextItems
}
