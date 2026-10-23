import { beforeEach, describe, expect, test, vi } from "vitest"

import { apiContext } from "../../context"
import type { FollowAPI } from "../../types"
import { inboxSyncService, useInboxStore } from "./store"

const mocks = vi.hoisted(() => ({
  deleteById: vi.fn(),
  getInboxAll: vi.fn(),
  getInbox: vi.fn(),
  listInboxes: vi.fn(),
  postInbox: vi.fn(),
  reset: vi.fn(),
  upsertMany: vi.fn(),
}))

vi.mock("@follow/database/services/inbox", () => ({
  InboxService: {
    deleteById: mocks.deleteById,
    getInboxAll: mocks.getInboxAll,
    reset: mocks.reset,
    upsertMany: mocks.upsertMany,
  },
}))

const handle = "test-inbox"
const serverInbox = {
  id: handle,
  secret: "server-secret",
  title: "Test Inbox",
  type: "inbox" as const,
}

describe("inboxSyncService", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.upsertMany.mockResolvedValue(undefined)
    useInboxStore.setState({ inboxes: {} })
    apiContext.provide({
      inboxes: {
        get: mocks.getInbox,
        list: mocks.listInboxes,
        post: mocks.postInbox,
      },
    } as unknown as FollowAPI)
  })

  test("refreshes an empty cached secret from the owned inbox list", async () => {
    useInboxStore.setState({
      inboxes: {
        [handle]: {
          id: handle,
          secret: "",
          title: "Test Inbox",
          type: "inbox",
        },
      },
    })
    mocks.listInboxes.mockResolvedValue({ code: 0, data: [serverInbox] })

    await expect(inboxSyncService.fetchOwnedInboxes()).resolves.toEqual([
      {
        id: handle,
        secret: "server-secret",
        title: "Test Inbox",
      },
    ])

    expect(useInboxStore.getState().inboxes[handle]?.secret).toBe("server-secret")
    expect(mocks.upsertMany).toHaveBeenCalledWith([
      {
        id: handle,
        secret: "server-secret",
        title: "Test Inbox",
      },
    ])
  })

  test("fetches and persists the generated secret after creating an inbox", async () => {
    mocks.postInbox.mockResolvedValue({ code: 0 })
    mocks.getInbox.mockResolvedValue({ code: 0, data: serverInbox })

    await inboxSyncService.createInbox({ handle, title: "Test Inbox" })

    expect(mocks.postInbox).toHaveBeenCalledWith({ handle, title: "Test Inbox" })
    expect(mocks.getInbox).toHaveBeenCalledWith({ handle })
    expect(useInboxStore.getState().inboxes[handle]?.secret).toBe("server-secret")
    expect(mocks.upsertMany).toHaveBeenCalledOnce()
    expect(mocks.upsertMany).toHaveBeenCalledWith([
      {
        id: handle,
        secret: "server-secret",
        title: "Test Inbox",
      },
    ])
  })

  test("keeps a created inbox when its initial secret refresh fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    mocks.postInbox.mockResolvedValue({ code: 0 })
    mocks.getInbox.mockRejectedValueOnce(new Error("temporary failure"))

    await expect(inboxSyncService.createInbox({ handle, title: "Test Inbox" })).resolves.toBe(
      undefined,
    )

    expect(useInboxStore.getState().inboxes[handle]?.secret).toBe("")
    expect(mocks.upsertMany).toHaveBeenCalledWith([
      {
        id: handle,
        secret: "",
        title: "Test Inbox",
      },
    ])

    mocks.getInbox.mockResolvedValueOnce({ code: 0, data: serverInbox })
    await expect(inboxSyncService.getInboxSecret(handle)).resolves.toBe("server-secret")
    expect(useInboxStore.getState().inboxes[handle]?.secret).toBe("server-secret")

    consoleError.mockRestore()
  })

  test("retrieves a missing secret before returning it to the copy action", async () => {
    useInboxStore.setState({
      inboxes: {
        [handle]: {
          id: handle,
          secret: "",
          title: "Test Inbox",
          type: "inbox",
        },
      },
    })
    mocks.getInbox.mockResolvedValue({ code: 0, data: serverInbox })

    await expect(inboxSyncService.getInboxSecret(handle)).resolves.toBe("server-secret")

    expect(mocks.getInbox).toHaveBeenCalledWith({ handle })
    expect(useInboxStore.getState().inboxes[handle]?.secret).toBe("server-secret")
  })
})
