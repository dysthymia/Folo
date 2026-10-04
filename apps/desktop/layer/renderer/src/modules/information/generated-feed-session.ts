import type { GeneratedFeedPage, GeneratedReaderItem } from "./generated-feed-client"
import { generatedItemKey } from "./generated-feed-identity"

export type ReaderSession = {
  page: GeneratedFeedPage
  items: GeneratedReaderItem[]
  cursors: Array<string | undefined>
  scrollTop: number
  readChanges?: Array<[string, { read?: boolean; collected?: boolean }]>
}
const sessions = new Map<string, ReaderSession>()
let activeOwner: string | null = null

// 会话只驻留内存且按账号清空；切换原始模式或标签页不等于退出账号。
export function readerSession(owner: string | null, scope: string) {
  if (owner !== activeOwner) {
    sessions.clear()
    activeOwner = owner
  }
  const session = owner ? sessions.get(scope) : undefined
  return session ? structuredClone(session) : undefined
}
export function saveReaderSession(owner: string | null, scope: string, session: ReaderSession) {
  // 晚到旧账号的cleanup不能把activeOwner倒退，并将旧结果重新塞回缓存。
  if (!owner || owner !== activeOwner) return
  sessions.set(scope, structuredClone(session))
  // 限制历史范围的数量，避免长期阅读占用无限内存。
  if (sessions.size > 12) sessions.delete(sessions.keys().next().value!)
}

// 读态和收藏属于账号与条目，切换筛选后完成的操作仍需更新该账号的旧快照。
export function updateReaderSessions(
  owner: string,
  itemKey: string,
  state: { read?: boolean; collected?: boolean },
) {
  if (owner !== activeOwner) return
  for (const session of sessions.values()) {
    session.items = session.items.map((item) =>
      generatedItemKey(item) === itemKey ? { ...item, ...state } : item,
    )
    const changes = new Map(session.readChanges ?? [])
    changes.set(itemKey, { ...changes.get(itemKey), ...state })
    session.readChanges = [...changes]
  }
}
