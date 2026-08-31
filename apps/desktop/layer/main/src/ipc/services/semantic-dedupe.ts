import { app } from "electron"
import { IpcMethod, IpcService } from "electron-ipc-decorator"
import { join } from "pathe"

import type {
  EvaluateSemanticDuplicatesOutput,
  SemanticDedupeCodexOptions,
  SemanticDuplicateCandidate,
} from "../../lib/semantic-dedupe-codex"
import { evaluateSemanticDuplicateCandidates } from "../../lib/semantic-dedupe-codex"

interface EvaluateSemanticDuplicatesInput {
  candidates: SemanticDuplicateCandidate[]
  options?: SemanticDedupeCodexOptions
}

const getRuntimeDir = () => join(app.getPath("userData"), "semantic-dedupe")

export class SemanticDedupeService extends IpcService {
  static override readonly groupName = "semanticDedupe"

  @IpcMethod()
  // electron-ipc-decorator 1.x 会自行管理 IPC 上下文，方法只暴露业务参数。
  evaluateCandidates(
    input: EvaluateSemanticDuplicatesInput,
  ): Promise<EvaluateSemanticDuplicatesOutput> {
    return evaluateSemanticDuplicateCandidates({
      candidates: input.candidates,
      options: input.options,
      runtimeDir: getRuntimeDir(),
    })
  }
}
