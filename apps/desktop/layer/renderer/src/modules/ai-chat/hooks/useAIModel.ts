import { useQuery } from "@tanstack/react-query"
import { useEffect, useMemo } from "react"

import { setAIModelState, useAIModelState } from "../atoms/session"
import { isLocalFoloHost, loadLocalAISettings } from "../local-provider"
import { useAIConfiguration } from "./useAIConfiguration"

const useLocalAISettings = () => {
  return useQuery({
    queryKey: ["localAISettings"],
    queryFn: loadLocalAISettings,
    enabled: isLocalFoloHost(),
    staleTime: 60 * 1000,
    retry: false,
  })
}

export const useAIModel = () => {
  const useLocalProvider = isLocalFoloHost()
  const localSettings = useLocalAISettings()
  const officialConfiguration = useAIConfiguration(!useLocalProvider)
  const configuration = useMemo(() => {
    if (useLocalProvider) {
      if (!localSettings.data) return undefined
      return {
        defaultModel: localSettings.data.model,
        availableModels: [localSettings.data.model],
        availableModelsMenu: [
          {
            label: localSettings.data.model,
            value: localSettings.data.model,
            paidLevel: undefined,
          },
        ],
      }
    }

    return officialConfiguration.data
  }, [localSettings.data, officialConfiguration.data, useLocalProvider])
  const isLoading = useLocalProvider ? localSettings.isLoading : officialConfiguration.isLoading
  const modelState = useAIModelState()

  // Validate and sync persistent model with available models
  useEffect(() => {
    if (useLocalProvider || !configuration || isLoading) return

    const { selectedModel } = modelState
    const { defaultModel, availableModels = [] } = configuration

    // If no model is selected or selected model is not available, use default
    if (!selectedModel || !availableModels.includes(selectedModel)) {
      setAIModelState({
        selectedModel: defaultModel || null,
      })
    }
  }, [configuration, isLoading, modelState, useLocalProvider])

  // Get current effective model
  const currentModel = useMemo(() => {
    if (!configuration) return null

    const { selectedModel } = modelState
    const { defaultModel, availableModels = [] } = configuration

    // Return selected model if valid, otherwise fallback to default
    if (selectedModel && availableModels.includes(selectedModel)) {
      return selectedModel
    }

    return defaultModel || null
  }, [configuration, modelState])

  const changeModel = (model: string) => {
    // 本地模型配置属于信息工作台，聊天窗口不写入官方模型选择。
    if (useLocalProvider) return

    if (!configuration?.availableModels?.includes(model)) {
      console.warn(`Model ${model} is not available in current configuration`)
      return
    }

    setAIModelState({
      selectedModel: model,
    })
  }

  return {
    data: {
      defaultModel: configuration?.defaultModel,
      availableModels: configuration?.availableModels,
      availableModelsMenu: configuration?.availableModelsMenu,
      currentModel,
      isLocalProvider: useLocalProvider,
    },
    isLoading,
    changeModel,
  }
}
