import { app } from "electron"
import type { IpcContext } from "electron-ipc-decorator"
import { IpcMethod, IpcService } from "electron-ipc-decorator"
import { join } from "pathe"

import type {
  EvaluateSemanticDuplicatesOutput,
  SemanticDuplicateCandidate,
} from "../../lib/semantic-dedupe-codex"
import { evaluateSemanticDuplicateCandidates } from "../../lib/semantic-dedupe-codex"

interface EvaluateSemanticDuplicatesInput {
  candidates: SemanticDuplicateCandidate[]
}

const getRuntimeDir = () => join(app.getPath("userData"), "semantic-dedupe")

export class SemanticDedupeService extends IpcService {
  static override readonly groupName = "semanticDedupe"

  @IpcMethod()
  evaluateCandidates(
    _context: IpcContext,
    input: EvaluateSemanticDuplicatesInput,
  ): Promise<EvaluateSemanticDuplicatesOutput> {
    return evaluateSemanticDuplicateCandidates({
      candidates: input.candidates,
      runtimeDir: getRuntimeDir(),
    })
  }
}
