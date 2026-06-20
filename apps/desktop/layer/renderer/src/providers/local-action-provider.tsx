import {
  useLocalActionHydration,
  useLocalActionSilenceProcessor,
} from "@follow/store/action/local-hooks"
import { useWhoami } from "@follow/store/user/hooks"

export const LocalActionProvider = () => {
  const user = useWhoami()

  useLocalActionHydration(user?.id)
  useLocalActionSilenceProcessor()

  return null
}
