import { env } from "@follow/shared/env.desktop"
import type { HttpChatTransportInitOptions, UIMessageChunk } from "ai"
import { HttpChatTransport, parseJsonEventStream, uiMessageChunkSchema } from "ai"

import { getAIModelState } from "../atoms/session"
import { getOneTimeToken, isLocalFoloHost } from "../local-provider"
import { AIPersistService } from "../services"
import type { BizUIMessage } from "./types"

type TitleHandlerPersistOption = boolean | ((title: string) => void | Promise<void>)

export interface TitleHandlerOptions {
  chatId?: string
  shouldHandle?: () => boolean
  onTitleChange?: (title: string) => void
  persist?: TitleHandlerPersistOption
}

export interface CreateChatTransportOptions {
  onValue?: (value: UIMessageChunk) => void
  titleHandler?: TitleHandlerOptions
}

export interface CreateChatTitleHandlerOptions {
  chatId: string
  getActiveChatId: () => string | null | undefined
  onTitleChange?: (title: string) => void
  persist?: TitleHandlerPersistOption
}

export function createChatTitleHandler(
  options: CreateChatTitleHandlerOptions,
): TitleHandlerOptions {
  const { chatId, getActiveChatId, onTitleChange, persist } = options

  return {
    chatId,
    persist,
    onTitleChange,
    shouldHandle: () => getActiveChatId() === chatId,
  }
}

/**
 * Create a chat transport for AI SDK
 * This is used by the AbstractChat instance to communicate with AI providers
 */
export function createChatTransport({ onValue, titleHandler }: CreateChatTransportOptions = {}) {
  const useLocalProvider = isLocalFoloHost()

  return new ExtendChatTransport({
    onValue,
    titleHandler,
    localProvider: useLocalProvider,
    api: useLocalProvider ? "/information/api/chat" : `${env.VITE_API_URL}/ai/chat`,
    credentials: useLocalProvider ? "same-origin" : "include",
    headers: useLocalProvider
      ? async () => ({ "X-Folo-One-Time-Token": await getOneTimeToken() })
      : undefined,
    // 本地模型由后台设置决定，不能把官方持久化的模型选择覆盖过去。
    body: () => {
      if (useLocalProvider) return {}

      const modelState = getAIModelState()
      const { selectedModel } = modelState

      return selectedModel ? { model: selectedModel } : {}
    },
  })
}

type UIMessageChunkParseResult =
  ReturnType<typeof parseJsonEventStream<UIMessageChunk>> extends ReadableStream<infer T>
    ? T
    : never

const coerceFinishChunk = (chunk: UIMessageChunkParseResult): UIMessageChunk | null => {
  const { rawValue } = chunk
  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
    return null
  }

  if ((rawValue as { type?: unknown }).type !== "finish") {
    return null
  }

  const { finishReason, messageMetadata } = rawValue as {
    finishReason?: unknown
    messageMetadata?: unknown
  }

  return {
    type: "finish",
    finishReason: typeof finishReason === "string" ? finishReason : undefined,
    messageMetadata,
  } as UIMessageChunk
}

export const normalizeLocalMessageMetadata = (metadata: unknown) => {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return metadata
  }

  // 本地后台仅返回 model 时，转换为既有消息展示组件使用的 modelUsed 字段。
  const value = metadata as { model?: unknown; modelUsed?: unknown }
  if (typeof value.model === "string" && typeof value.modelUsed !== "string") {
    return { ...value, modelUsed: value.model }
  }

  return metadata
}

class ExtendChatTransport extends HttpChatTransport<BizUIMessage> {
  constructor(
    private options: HttpChatTransportInitOptions<BizUIMessage> & {
      onValue?: (value: UIMessageChunk) => void
      titleHandler?: TitleHandlerOptions
      localProvider?: boolean
    },
  ) {
    super(options)
  }

  protected processResponseStream(
    stream: ReadableStream<Uint8Array<ArrayBufferLike>>,
  ): ReadableStream<UIMessageChunk> {
    const { onValue, localProvider } = this.options || {}
    const handleGeneratedTitle = this.handleGeneratedTitle.bind(this)
    return parseJsonEventStream({
      stream,
      schema: uiMessageChunkSchema,
    }).pipeThrough(
      new TransformStream<UIMessageChunkParseResult, UIMessageChunk>({
        async transform(chunk, controller) {
          let parsedChunk = chunk.success ? chunk.value : coerceFinishChunk(chunk)
          if (!parsedChunk) {
            throw chunk.error
          }

          if (localProvider && parsedChunk.type === "finish") {
            parsedChunk = {
              ...parsedChunk,
              messageMetadata: normalizeLocalMessageMetadata(parsedChunk.messageMetadata),
            }
          }

          await handleGeneratedTitle(parsedChunk)
          onValue?.(parsedChunk)
          controller.enqueue(parsedChunk)
        },
      }),
    )
  }

  private async handleGeneratedTitle(chunk: UIMessageChunk) {
    const { titleHandler } = this.options
    if (!titleHandler) {
      return
    }

    if (chunk.type !== "data-generated-title" || typeof chunk.data !== "string") {
      return
    }

    const shouldHandle = titleHandler.shouldHandle?.() ?? true
    if (!shouldHandle) {
      return
    }

    titleHandler.onTitleChange?.(chunk.data)

    const persistOption = titleHandler.persist
    const shouldPersist = persistOption === undefined ? true : persistOption

    if (!shouldPersist) {
      return
    }

    try {
      if (typeof persistOption === "function") {
        await persistOption(chunk.data)
        return
      }

      if (titleHandler.chatId) {
        await AIPersistService.updateSessionTitle(titleHandler.chatId, chunk.data)
      }
    } catch (error) {
      console.error("Failed to persist generated title:", error)
    }
  }

  override reconnectToStream(
    options: Parameters<HttpChatTransport<BizUIMessage>["reconnectToStream"]>[0],
  ) {
    options.chatId = encodeURIComponent(options.chatId)
    return super.reconnectToStream(options)
  }
}
