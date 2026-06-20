import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"

import { join } from "pathe"

export interface SemanticDuplicateEntryContext {
  id: string
  title: string
  feedTitle: string
  description: string
  publishedAt: string
  urlHost: string
}

export interface SemanticDuplicateCandidate {
  pairKey: string
  keepEntryId: string
  testEntryId: string
  similarity: number
  entries: [SemanticDuplicateEntryContext, SemanticDuplicateEntryContext]
}

export interface SemanticDuplicateEvaluation {
  pairKey: string
  duplicate: boolean
  confidence: number
  keepEntryId?: string | null
  hideEntryId?: string | null
  reason?: string | null
}

export interface EvaluateSemanticDuplicatesOutput {
  results: SemanticDuplicateEvaluation[]
}

interface CodexSemanticDedupeOutput {
  results: Array<{
    pairKey: string
    duplicate: boolean
    confidence: number
    keepEntryId: string | null
    hideEntryId: string | null
    reason: string | null
  }>
}

const REQUESTED_CODEX_MODEL = "GPT-5.3-Codex-Spark"
const CODEX_REASONING_EFFORT = process.env.FOLO_SEMANTIC_DEDUPE_CODEX_REASONING_EFFORT ?? "low"
const CODEX_TIMEOUT = 20_000
const MAX_CANDIDATES_PER_REQUEST = 16
const MAX_OUTPUT_BYTES = 1024 * 1024
const unavailableCodexModels = new Set<string>()

const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["pairKey", "duplicate", "confidence", "keepEntryId", "hideEntryId", "reason"],
        properties: {
          pairKey: { type: "string" },
          duplicate: { type: "boolean" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          keepEntryId: { anyOf: [{ type: "string" }, { type: "null" }] },
          hideEntryId: { anyOf: [{ type: "string" }, { type: "null" }] },
          reason: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
      },
    },
  },
}

const ensureOutputSchema = async (runtimeDir: string) => {
  await mkdir(runtimeDir, { recursive: true })

  const schemaPath = join(runtimeDir, "codex-output-schema.json")
  await writeFile(schemaPath, `${JSON.stringify(outputSchema, null, 2)}\n`, "utf8")

  return schemaPath
}

const createPrompt = (
  candidates: SemanticDuplicateCandidate[],
) => `You are a strict duplicate-news classifier.

Decide whether each candidate pair describes the same core news event.

Rules:
- Return duplicate=true only when both entries describe the same core event, entities, facts, and conclusion.
- Return duplicate=false when they are only the same topic, when one is a later update, when numbers differ, when the time window differs, or when a key fact changes.
- feedTitle and urlHost are supporting context, not decisive by themselves.
- Prefer keepEntryId unless the other entry is clearly more complete or more recent.
- Use title and description. Do not infer facts that are not present.
- Be conservative. If uncertain, duplicate=false or confidence below 0.85.

Return JSON matching the provided schema only.

Candidates:
${JSON.stringify({ candidates }, null, 2)}
`

const unique = <T>(items: T[]) => Array.from(new Set(items))

const getCodexCandidates = () =>
  unique(
    [process.env.CODEX_BIN, "codex", "/opt/homebrew/bin/codex", "/usr/local/bin/codex"].filter(
      (candidate): candidate is string => !!candidate,
    ),
  ).filter((candidate) => !candidate.startsWith("/") || existsSync(candidate))

const getCodexModelCandidates = () =>
  unique([
    process.env.FOLO_SEMANTIC_DEDUPE_CODEX_MODEL || REQUESTED_CODEX_MODEL,
    process.env.FOLO_SEMANTIC_DEDUPE_CODEX_FALLBACK_MODEL || null,
  ]).filter((model) => !model || !unavailableCodexModels.has(model))

const isUnsupportedModelError = (error: Error) => error.message.includes("model is not supported")

const collectOutput = (buffer: Buffer[], chunk: Buffer) => {
  const nextSize = buffer.reduce((size, item) => size + item.byteLength, 0) + chunk.byteLength
  if (nextSize > MAX_OUTPUT_BYTES) return
  buffer.push(chunk)
}

const runCodex = async ({
  outputPath,
  prompt,
  schemaPath,
}: {
  outputPath: string
  prompt: string
  schemaPath: string
}) => {
  let lastError: Error | null = null
  let lastCommandError: Error | null = null

  for (const model of getCodexModelCandidates()) {
    const args = [
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "--ignore-rules",
      "--sandbox",
      "read-only",
      ...(model ? ["-m", model] : []),
      "-c",
      `model_reasoning_effort="${CODEX_REASONING_EFFORT}"`,
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outputPath,
      "-",
    ]

    for (const command of getCodexCandidates()) {
      try {
        return await new Promise<string>((resolve, reject) => {
          const stdout: Buffer[] = []
          const stderr: Buffer[] = []
          const child = spawn(command, args, {
            cwd: tmpdir(),
            env: {
              ...process.env,
              NO_COLOR: "1",
            },
            stdio: ["pipe", "pipe", "pipe"],
          })

          const timeout = setTimeout(() => {
            child.kill("SIGTERM")
            reject(new Error("Codex semantic duplicate check timed out"))
          }, CODEX_TIMEOUT)

          child.stdout.on("data", (chunk: Buffer) => collectOutput(stdout, chunk))
          child.stderr.on("data", (chunk: Buffer) => collectOutput(stderr, chunk))
          child.on("error", reject)
          child.on("close", (code) => {
            clearTimeout(timeout)
            if (code === 0) {
              resolve(Buffer.concat(stdout).toString("utf8"))
              return
            }

            reject(
              new Error(
                Buffer.concat(stderr).toString("utf8").trim() ||
                  `Codex semantic duplicate check exited with ${code}`,
              ),
            )
          })

          child.stdin.end(prompt)
        })
      } catch (error) {
        const normalizedError =
          error instanceof Error ? error : new Error("Codex semantic duplicate check failed")

        if (model && isUnsupportedModelError(normalizedError)) {
          unavailableCodexModels.add(model)
        }
        if (normalizedError.message.includes("ENOENT")) {
          lastCommandError = normalizedError
        } else {
          lastError = normalizedError
        }
      }
    }
  }

  throw lastError ?? lastCommandError ?? new Error("Codex CLI is not available")
}

const parseCodexOutput = (rawOutput: string): CodexSemanticDedupeOutput => {
  const trimmedOutput = rawOutput.trim()
  try {
    return JSON.parse(trimmedOutput) as CodexSemanticDedupeOutput
  } catch {
    const jsonMatch = trimmedOutput.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error("Codex semantic duplicate output is not JSON")
    return JSON.parse(jsonMatch[0]) as CodexSemanticDedupeOutput
  }
}

const normalizeEvaluation = (
  candidateByPairKey: Map<string, SemanticDuplicateCandidate>,
  evaluation: CodexSemanticDedupeOutput["results"][number],
): SemanticDuplicateEvaluation | null => {
  const candidate = candidateByPairKey.get(evaluation.pairKey)
  if (!candidate) return null

  const confidence = Math.max(0, Math.min(1, Number(evaluation.confidence)))
  if (!Number.isFinite(confidence)) return null

  const keepEntryId =
    evaluation.duplicate && evaluation.keepEntryId ? evaluation.keepEntryId : candidate.keepEntryId
  const hideEntryId =
    evaluation.duplicate && evaluation.hideEntryId ? evaluation.hideEntryId : candidate.testEntryId

  const validKeepEntryId =
    keepEntryId === candidate.keepEntryId || keepEntryId === candidate.testEntryId
      ? keepEntryId
      : candidate.keepEntryId
  const validHideEntryId =
    hideEntryId === candidate.keepEntryId || hideEntryId === candidate.testEntryId
      ? hideEntryId
      : candidate.testEntryId

  return {
    confidence,
    duplicate: evaluation.duplicate,
    hideEntryId: evaluation.duplicate ? validHideEntryId : null,
    keepEntryId: evaluation.duplicate ? validKeepEntryId : null,
    pairKey: evaluation.pairKey,
    reason: evaluation.reason,
  }
}

const createFallbackEvaluation = (
  candidate: SemanticDuplicateCandidate,
): SemanticDuplicateEvaluation => ({
  confidence: 0,
  duplicate: false,
  hideEntryId: null,
  keepEntryId: null,
  pairKey: candidate.pairKey,
  reason: "No Codex decision returned.",
})

export const evaluateSemanticDuplicateCandidates = async ({
  candidates: inputCandidates,
  runtimeDir,
}: {
  candidates: SemanticDuplicateCandidate[]
  runtimeDir: string
}): Promise<EvaluateSemanticDuplicatesOutput> => {
  const candidates = inputCandidates.slice(0, MAX_CANDIDATES_PER_REQUEST)
  if (candidates.length === 0) {
    return { results: [] }
  }

  await mkdir(runtimeDir, { recursive: true })

  const schemaPath = await ensureOutputSchema(runtimeDir)
  const outputPath = join(runtimeDir, `codex-output-${randomUUID()}.json`)

  try {
    await runCodex({
      outputPath,
      prompt: createPrompt(candidates),
      schemaPath,
    })

    const output = parseCodexOutput(await readFile(outputPath, "utf8"))
    const candidateByPairKey = new Map(
      candidates.map((candidate) => [candidate.pairKey, candidate]),
    )
    const evaluationByPairKey = new Map(
      output.results
        .map((evaluation) => normalizeEvaluation(candidateByPairKey, evaluation))
        .filter((evaluation): evaluation is SemanticDuplicateEvaluation => !!evaluation)
        .map((evaluation) => [evaluation.pairKey, evaluation]),
    )

    return {
      results: candidates.map(
        (candidate) =>
          evaluationByPairKey.get(candidate.pairKey) ?? createFallbackEvaluation(candidate),
      ),
    }
  } finally {
    void rm(outputPath, { force: true })
  }
}
