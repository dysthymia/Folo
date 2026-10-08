import { describe, expect, it } from "vitest"

import { LocalReadSessionError, LocalReadSessions } from "./local-read-session"

describe("本地只读会话", () => {
  it("绑定已有工作区，过期、撤销和未知票据都失效", () => {
    let now = 1000
    const sessions = new LocalReadSessions(
      () => "owner",
      () => now,
    )
    const access = sessions.issue("owner")
    expect(access.token).toMatch(/^[a-f0-9]{64}$/u)
    expect(sessions.verify(access.token).ownerId).toBe("owner")
    expect(() => sessions.verify("unknown")).toThrow(LocalReadSessionError)
    now = access.expiresAt
    expect(() => sessions.verify(access.token)).toThrow("authorization")
    const next = sessions.issue(null)
    sessions.revoke(next.token)
    expect(() => sessions.verify(next.token)).toThrow("authorization")
  })

  it("不能绑定新账号，工作区身份变化立即撤销旧票据", () => {
    let owner: string | null = null
    const sessions = new LocalReadSessions(() => owner)
    expect(() => sessions.issue(null)).toThrow("authorization")
    owner = "owner-a"
    expect(() => sessions.issue("owner-b")).toThrow("account_mismatch")
    const access = sessions.issue("owner-a")
    owner = "owner-b"
    expect(() => sessions.verify(access.token)).toThrow("account_mismatch")
    expect(() => sessions.verify(access.token)).toThrow("authorization")
  })
})
