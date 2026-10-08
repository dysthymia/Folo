import { describe, expect, it } from "vitest"

import { isLocalInformationRead } from "./local-information-read"

describe("本地读取范围", () => {
  it.each([
    ["GET", "automation/editor"],
    ["GET", "/information/v1/configuration/effective"],
    ["GET", "rules/custom-rule"],
    ["GET", "processing/entries/42"],
    ["GET", "processing/entries/42/events"],
    ["GET", "processing/entries/42/semantics"],
    ["GET", "processing/model-settings"],
    ["GET", "processing/stories/story-id/reader-state"],
    ["GET", "/information/api/settings"],
    ["GET", "/information/api/snapshot"],
    ["POST", "processing/semantics/query"],
    ["POST", "reading-snapshot"],
    ["POST", "reading-snapshot/refresh"],
    ["POST", "processing/events/evt_id/members"],
    ["POST", "processing/generated-feed/items"],
  ])("允许本地读取 %s %s", (method, path) => {
    expect(isLocalInformationRead(method, path)).toBe(true)
  })

  it.each([
    ["PUT", "configuration"],
    ["POST", "rules/trial"],
    ["PUT", "rules/custom-rule/activate"],
    ["POST", "feedback"],
    ["POST", "runs"],
    ["POST", "processing/list-loaded"],
    ["POST", "processing/stories/story-id/reader-state"],
    ["POST", "x/sync"],
    ["POST", "exports"],
    ["POST", "research-selections/preview"],
    ["POST", "/information/api/chat"],
    ["GET", "unknown-route"],
  ])("拒绝以本地读会话执行 %s %s", (method, path) => {
    expect(isLocalInformationRead(method, path)).toBe(false)
  })

  it("收藏刷新仍需官方授权，普通缓存分页不联网", () => {
    expect(
      isLocalInformationRead("POST", "processing/generated-feed/items", { mode: "collections" }),
    ).toBe(true)
    expect(
      isLocalInformationRead("POST", "processing/generated-feed/items", {
        mode: "collections",
        refresh: true,
      }),
    ).toBe(false)
    expect(isLocalInformationRead("POST", "/information/api/settings", { provider: "codex" })).toBe(
      false,
    )
  })
})
