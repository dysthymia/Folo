import { and, eq, gte, inArray, or, sql } from "drizzle-orm"

import { db } from "../db"
import { entryOpenStatsTable } from "../schemas"
import type { EntryOpenStatsSchema, EntrySchema } from "../schemas/types"
import type { Resetable } from "./internal/base"

export type EntryOpenSource = NonNullable<EntryOpenStatsSchema["openSource"]>

export type FeedOpenStatsPeriod = "day" | "week" | "month"

export interface FeedOpenStatsValue {
  opened: number
  openedFromPublished: number
  total: number
}

export type FeedOpenStats = Record<FeedOpenStatsPeriod, FeedOpenStatsValue>

export type FeedOpenStatsMap = Record<string, FeedOpenStats>

const PERIODS = ["day", "week", "month"] as const satisfies readonly FeedOpenStatsPeriod[]

const createEmptyPeriodStats = (): FeedOpenStatsValue => ({
  opened: 0,
  openedFromPublished: 0,
  total: 0,
})

export const createEmptyFeedOpenStats = (): FeedOpenStats => ({
  day: createEmptyPeriodStats(),
  week: createEmptyPeriodStats(),
  month: createEmptyPeriodStats(),
})

const getPeriodStarts = (now = new Date()): Record<FeedOpenStatsPeriod, Date> => {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  const week = new Date(day)
  week.setDate(day.getDate() - 6)

  const month = new Date(day)
  month.setDate(day.getDate() - 29)

  return { day, week, month }
}

const toSeenEntryRows = (entries: EntrySchema[]): EntryOpenStatsSchema[] =>
  entries
    .filter((entry) => entry.feedId && entry.publishedAt)
    .map((entry) => ({
      entryId: entry.id,
      feedId: entry.feedId!,
      publishedAt: entry.publishedAt!,
    }))

class EntryOpenStatsServiceStatic implements Resetable {
  async reset() {
    await db.delete(entryOpenStatsTable).execute()
  }

  async upsertSeenEntries(entries: EntrySchema[]) {
    const rows = toSeenEntryRows(entries)
    if (rows.length === 0) return

    await db
      .insert(entryOpenStatsTable)
      .values(rows)
      .onConflictDoUpdate({
        target: [entryOpenStatsTable.entryId],
        set: {
          feedId: sql`excluded.feed_id`,
          publishedAt: sql`excluded.published_at`,
        },
      })
  }

  async recordOpen({
    entryId,
    feedId,
    publishedAt,
    source,
  }: {
    entryId: string
    feedId: string
    publishedAt: Date
    source: EntryOpenSource
  }) {
    const firstOpenedAt = new Date()

    await db
      .insert(entryOpenStatsTable)
      .values({
        entryId,
        feedId,
        publishedAt,
        firstOpenedAt,
        openSource: source,
      })
      .onConflictDoUpdate({
        target: [entryOpenStatsTable.entryId],
        set: {
          feedId: sql`excluded.feed_id`,
          publishedAt: sql`excluded.published_at`,
          firstOpenedAt: sql`coalesce(${entryOpenStatsTable.firstOpenedAt}, excluded.first_opened_at)`,
          openSource: sql`coalesce(${entryOpenStatsTable.openSource}, excluded.open_source)`,
        },
      })
  }

  async getStatsByFeedIds(feedIds: string[], now = new Date()): Promise<FeedOpenStatsMap> {
    if (feedIds.length === 0) return {}

    const periodStarts = getPeriodStarts(now)
    const rows = await db.query.entryOpenStatsTable.findMany({
      where: and(
        inArray(entryOpenStatsTable.feedId, feedIds),
        or(
          gte(entryOpenStatsTable.publishedAt, periodStarts.month),
          gte(entryOpenStatsTable.firstOpenedAt, periodStarts.month),
        ),
      ),
      columns: {
        feedId: true,
        publishedAt: true,
        firstOpenedAt: true,
      },
    })

    const stats = Object.fromEntries(
      feedIds.map((feedId) => [feedId, createEmptyFeedOpenStats()]),
    ) as FeedOpenStatsMap

    for (const row of rows) {
      const feedStats = stats[row.feedId] ?? createEmptyFeedOpenStats()

      for (const period of PERIODS) {
        const start = periodStarts[period]

        if (row.firstOpenedAt && row.firstOpenedAt >= start) {
          feedStats[period].opened += 1
        }

        if (row.publishedAt >= start) {
          feedStats[period].total += 1

          if (row.firstOpenedAt) {
            feedStats[period].openedFromPublished += 1
          }
        }
      }

      stats[row.feedId] = feedStats
    }

    return stats
  }

  async deleteByEntryId(entryId: string) {
    await db.delete(entryOpenStatsTable).where(eq(entryOpenStatsTable.entryId, entryId)).execute()
  }
}

export const EntryOpenStatsService = new EntryOpenStatsServiceStatic()
