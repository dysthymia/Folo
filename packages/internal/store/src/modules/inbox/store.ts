import type { InboxSchema } from "@follow/database/schemas/types"
import { InboxService } from "@follow/database/services/inbox"

import { api } from "../../context"
import type { Hydratable, Resetable } from "../../lib/base"
import { createImmerSetter, createTransaction, createZustandStore } from "../../lib/helper"
import type { InboxModel } from "./types"

interface InboxState {
  inboxes: Record<string, InboxModel>
}

const defaultState = {
  inboxes: {},
}

export const useInboxStore = createZustandStore<InboxState>("inbox")(() => defaultState)

const get = useInboxStore.getState
const set = useInboxStore.setState
const immerSet = createImmerSetter(useInboxStore)

class InboxActions implements Hydratable, Resetable {
  async hydrate() {
    const inboxes = await InboxService.getInboxAll()
    inboxActions.upsertManyInSession(inboxes)
  }
  async upsertManyInSession(inboxes: InboxSchema[]) {
    const state = useInboxStore.getState()
    const nextInboxes: InboxState["inboxes"] = {
      ...state.inboxes,
    }
    inboxes.forEach((inbox) => {
      nextInboxes[inbox.id] = {
        type: "inbox",
        ...inbox,
      }
    })
    set({
      ...state,
      inboxes: nextInboxes,
    })
  }
  async upsertMany(inboxes: InboxSchema[]) {
    const tx = createTransaction()
    tx.store(() => {
      this.upsertManyInSession(inboxes)
    })
    tx.persist(() => {
      return InboxService.upsertMany(inboxes)
    })
    await tx.run()
  }

  deleteById(id: string) {
    immerSet((state) => {
      delete state.inboxes[id]
    })
  }

  async reset() {
    const tx = createTransaction()
    tx.store(() => {
      set(defaultState)
    })

    tx.persist(() => {
      return InboxService.reset()
    })

    await tx.run()
  }
}

class InboxSyncService {
  private async requestInboxById(handle: string): Promise<InboxSchema> {
    const { data } = await api().inboxes.get({ handle })
    return {
      id: data.id,
      title: data.title,
      secret: data.secret,
    }
  }

  async fetchInboxById(handle: string) {
    const inbox = await this.requestInboxById(handle)

    await inboxActions.upsertMany([inbox])

    return inbox
  }

  async fetchOwnedInboxes() {
    const { data } = await api().inboxes.list()
    const inboxes = data.map((inbox) => ({
      id: inbox.id,
      title: inbox.title,
      secret: inbox.secret,
    }))

    await inboxActions.upsertMany(inboxes)

    return inboxes
  }

  async getInboxSecret(handle: string) {
    const cachedSecret = get().inboxes[handle]?.secret
    if (cachedSecret) return cachedSecret

    const inbox = await this.fetchInboxById(handle)
    if (!inbox.secret) {
      throw new Error("Inbox secret is unavailable")
    }

    return inbox.secret
  }

  async createInbox({ handle, title }: { handle: string; title: string }) {
    await api().inboxes.post({
      handle,
      title,
    })

    let inbox: InboxSchema
    try {
      inbox = await this.requestInboxById(handle)
    } catch (error) {
      console.error("Failed to fetch the created inbox", error)
      await inboxActions.upsertMany([
        {
          id: handle,
          title,
          secret: "",
        },
      ])
      return
    }

    await inboxActions.upsertMany([inbox])
  }

  async updateInbox({ handle, title }: { handle: string; title: string }) {
    const existingInbox = get().inboxes[handle]
    if (!existingInbox) return

    const newInbox = {
      ...existingInbox,
      title,
    }
    const tx = createTransaction()
    tx.store(async () => {
      await inboxActions.upsertManyInSession([newInbox])
    })
    tx.request(async () => {
      await api().inboxes.put({
        handle,
        title,
      })
    })

    tx.persist(() => InboxService.upsertMany([newInbox]))
    tx.rollback(() => inboxActions.upsertMany([existingInbox]))
    await tx.run()
  }

  async deleteInbox(inboxId: string) {
    const inbox = get().inboxes[inboxId]
    if (!inbox) return

    const tx = createTransaction(inbox)
    tx.store(async () => inboxActions.deleteById(inboxId))
    tx.request(async () => {
      await api().inboxes.delete({
        handle: inboxId,
      })
    })

    tx.persist(() => InboxService.deleteById(inboxId))
    tx.rollback(async (inbox) => inboxActions.upsertMany([inbox]))
    await tx.run()
  }
}

export const inboxActions = new InboxActions()
export const inboxSyncService = new InboxSyncService()
