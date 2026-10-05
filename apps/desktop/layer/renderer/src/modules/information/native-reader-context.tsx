import { createContext, useContext } from "react"

import type { GeneratedReader } from "./use-generated-reader"

export const NativeReaderContext = createContext<GeneratedReader | null>(null)

export const useNativeReader = () => useContext(NativeReaderContext)
