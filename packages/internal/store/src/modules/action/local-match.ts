import type { ActionFeedField, ActionFilterItem, ActionOperation } from "@follow-app/client-sdk"

import { isEntryStarred } from "../collection/getter"
import { getEntry } from "../entry/getter"
import type { EntryModel } from "../entry/types"
import { getFeedById } from "../feed/getter"
import { getSubscriptionByEntryId, getSubscriptionByFeedId } from "../subscription/getter"
import type { SubscriptionModel } from "../subscription/types"
import { useLocalActionStore } from "./local-store"
import type { ActionItem } from "./store"

type LocalActionStatus = "collected" | "read" | "unread"

export interface LocalActionEntryContext {
  category: string
  entryAttachmentsDuration: number
  entryAuthor: string
  entryContent: string
  entryMediaLength: number
  entryTitle: string
  entryUrl: string
  feedTitle: string
  feedUrl: string
  siteUrl: string
  status: LocalActionStatus
  view?: number
}

const getTextValue = (value: string | null | undefined) => value ?? ""

const sumAttachmentDuration = (entry: EntryModel) =>
  (entry.attachments ?? []).reduce((duration, attachment) => {
    const nextDuration = Number(attachment.duration_in_seconds ?? 0)
    return Number.isFinite(nextDuration) ? duration + nextDuration : duration
  }, 0)

const buildEntryContent = (entry: EntryModel) =>
  [entry.description, entry.content, entry.readabilityContent].filter(Boolean).join("\n")

const getSubscriptionTitle = (subscription: SubscriptionModel | undefined, feedTitle: string) =>
  getTextValue(subscription?.title) || feedTitle

export const buildLocalActionEntryContext = (entryId: string): LocalActionEntryContext | null => {
  const entry = getEntry(entryId)
  if (!entry) return null

  const feed = entry.feedId ? getFeedById(entry.feedId) : undefined
  const subscription =
    getSubscriptionByEntryId(entry.id) ||
    (entry.feedId ? getSubscriptionByFeedId(entry.feedId) : undefined)
  const feedTitle = getTextValue(feed?.title)

  return {
    category: getTextValue(subscription?.category),
    entryAttachmentsDuration: sumAttachmentDuration(entry),
    entryAuthor: getTextValue(entry.author),
    entryContent: buildEntryContent(entry),
    entryMediaLength: entry.media?.length ?? 0,
    entryTitle: getTextValue(entry.title),
    entryUrl: getTextValue(entry.url),
    feedTitle: getSubscriptionTitle(subscription, feedTitle),
    feedUrl: getTextValue(feed?.url),
    siteUrl: getTextValue(feed?.siteUrl),
    status: isEntryStarred(entry.id) ? "collected" : entry.read ? "read" : "unread",
    view: subscription?.view,
  }
}

const getConditionValue = (
  context: LocalActionEntryContext,
  field: ActionFeedField,
): number | string | undefined => {
  switch (field) {
    case "category": {
      return context.category
    }
    case "entry_attachments_duration": {
      return context.entryAttachmentsDuration
    }
    case "entry_author": {
      return context.entryAuthor
    }
    case "entry_content": {
      return context.entryContent
    }
    case "entry_media_length": {
      return context.entryMediaLength
    }
    case "entry_title": {
      return context.entryTitle
    }
    case "entry_url": {
      return context.entryUrl
    }
    case "feed_url": {
      return context.feedUrl
    }
    case "site_url": {
      return context.siteUrl
    }
    case "status": {
      return context.status
    }
    case "title": {
      return context.feedTitle
    }
    case "view": {
      return context.view
    }
    default: {
      return undefined
    }
  }
}

const hasComparableValue = (value: ActionFilterItem["value"] | undefined) => {
  if (value === undefined || value === null) return false
  return typeof value !== "string" || value.length > 0
}

const compareNumber = (
  actualValue: number | string | undefined,
  expectedValue: ActionFilterItem["value"],
  operator: ActionOperation,
) => {
  const actualNumber = Number(actualValue)
  const expectedNumber = Number(expectedValue)

  if (!Number.isFinite(actualNumber) || !Number.isFinite(expectedNumber)) return false

  switch (operator) {
    case "eq": {
      return actualNumber === expectedNumber
    }
    case "gt": {
      return actualNumber > expectedNumber
    }
    case "lt": {
      return actualNumber < expectedNumber
    }
    case "not_eq": {
      return actualNumber !== expectedNumber
    }
    default: {
      return false
    }
  }
}

const compareText = (
  actualValue: number | string | undefined,
  expectedValue: ActionFilterItem["value"],
  operator: ActionOperation,
) => {
  const actualText = String(actualValue ?? "")
  const expectedText = String(expectedValue)

  switch (operator) {
    case "contains": {
      return actualText.includes(expectedText)
    }
    case "eq": {
      return actualText === expectedText
    }
    case "not_contains": {
      return !actualText.includes(expectedText)
    }
    case "not_eq": {
      return actualText !== expectedText
    }
    case "regex": {
      try {
        return new RegExp(expectedText).test(actualText)
      } catch {
        return false
      }
    }
    default: {
      return false
    }
  }
}

const isNumericField = (field: ActionFeedField) =>
  field === "entry_media_length" || field === "entry_attachments_duration" || field === "view"

export const doesLocalActionConditionMatch = (
  context: LocalActionEntryContext,
  condition: ActionFilterItem,
) => {
  if (!condition.field || !condition.operator) return false
  if (!hasComparableValue(condition.value)) return false

  const actualValue = getConditionValue(context, condition.field)
  if (isNumericField(condition.field)) {
    return compareNumber(actualValue, condition.value, condition.operator)
  }

  return compareText(actualValue, condition.value, condition.operator)
}

export const doesLocalActionRuleMatch = (rule: ActionItem, context: LocalActionEntryContext) => {
  if (rule.result.disabled) return false
  if (rule.condition.length === 0) return true

  return rule.condition.some(
    (conditionGroup) =>
      conditionGroup.length > 0 &&
      conditionGroup.every((condition) => doesLocalActionConditionMatch(context, condition)),
  )
}

const getLocalMatchedRules = (entryId: string) => {
  const context = buildLocalActionEntryContext(entryId)
  if (!context) return []

  return useLocalActionStore
    .getState()
    .rules.filter((rule) => doesLocalActionRuleMatch(rule, context))
}

export const getLocalActionMatchedRules = (entryId: string) => getLocalMatchedRules(entryId)

export const isEntryBlockedByLocalActions = (entryId: string) =>
  getLocalMatchedRules(entryId).some((rule) => rule.result.block)

export const isEntrySilencedByLocalActions = (entryId: string) => {
  if (isEntryBlockedByLocalActions(entryId)) return false

  return getLocalMatchedRules(entryId).some((rule) => rule.result.silence)
}

export const filterLocalActionEntryIds = (entryIds: string[]) =>
  entryIds.filter((entryId) => !isEntryBlockedByLocalActions(entryId))

export const getLocalActionSilenceEntryIds = (entryIds: string[]) =>
  entryIds.filter((entryId) => {
    const entry = getEntry(entryId)
    return entry && !entry.read && isEntrySilencedByLocalActions(entryId)
  })
