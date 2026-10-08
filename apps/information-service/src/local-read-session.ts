import { randomBytes } from "node:crypto"

export class LocalReadSessionError extends Error {
  constructor(
    public readonly status: 401 | 403,
    public readonly code: "authorization" | "account_mismatch",
  ) {
    super(code)
  }
}

type LocalReadSession = { ownerId: string; token: string; expiresAt: number }

// 本地工作区访问独立于云端登录凭据；票据只在进程内保存，不能用于写入或外部同步。
export class LocalReadSessions {
  private readonly sessions = new Map<string, LocalReadSession>()
  constructor(
    private readonly owner: () => string | null,
    private readonly now = Date.now,
  ) {}

  issue(expectedOwner: string | null): LocalReadSession {
    const ownerId = this.owner()
    if (!ownerId) throw new LocalReadSessionError(401, "authorization")
    if (expectedOwner !== null && expectedOwner !== ownerId)
      throw new LocalReadSessionError(403, "account_mismatch")
    for (const [token, session] of this.sessions)
      if (session.expiresAt <= this.now()) this.sessions.delete(token)
    while (this.sessions.size >= 64) this.sessions.delete(this.sessions.keys().next().value!)
    const session = {
      ownerId,
      token: randomBytes(32).toString("hex"),
      expiresAt: this.now() + 5 * 60_000,
    }
    this.sessions.set(session.token, session)
    return session
  }

  verify(token: unknown): LocalReadSession {
    const session =
      typeof token === "string" && token.length === 64 ? this.sessions.get(token) : undefined
    if (!session || session.expiresAt <= this.now()) {
      if (typeof token === "string") this.sessions.delete(token)
      throw new LocalReadSessionError(401, "authorization")
    }
    if (session.ownerId !== this.owner()) {
      this.sessions.delete(session.token)
      throw new LocalReadSessionError(403, "account_mismatch")
    }
    return session
  }

  revoke(token: unknown) {
    if (typeof token === "string") this.sessions.delete(token)
  }
}
