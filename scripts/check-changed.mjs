#!/usr/bin/env node
/**
 * Incremental quality gate: lint only the files that changed, and typecheck/test only
 * the packages that own them (plus the packages that depend on those).
 *
 * Why not plain `turbo run typecheck test --filter="[HEAD]"`: turbo's git-ref filtering
 * is not deterministic in this workspace. `apps/*` and `apps/desktop/layer/*` both match
 * files under `apps/desktop`, and the attribution randomly lands on the app root "Folo",
 * which has no `typecheck`/`test` script. turbo then skips the task and still exits 0,
 * so the gate silently checks nothing. Resolving the owning package by longest directory
 * prefix is deterministic.
 *
 * Usage:
 *   node scripts/check-changed.mjs              # lint changed files + typecheck/test owning packages
 *   node scripts/check-changed.mjs --dry        # print the resolved scope, run nothing
 *   node scripts/check-changed.mjs --no-lint    # skip eslint
 *   node scripts/check-changed.mjs --since=origin/dev
 */

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import process from "node:process"

import fg from "fast-glob"
import { parse as parseYaml } from "yaml"

const REPO = path.resolve(import.meta.dirname, "..")
const TURBO = path.join(REPO, "node_modules/.bin/turbo")
const ESLINT = path.join(REPO, "node_modules/.bin/eslint")
const LINTABLE = /\.(?:[cm]?[jt]sx?|json|jsonc)$/

const args = process.argv.slice(2)
const dry = args.includes("--dry")
const lint = !args.includes("--no-lint")
const since = args.find((a) => a.startsWith("--since="))?.slice("--since=".length) ?? "HEAD"

const git = (...gitArgs) =>
  execFileSync("git", gitArgs, { cwd: REPO, encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)

/** Workspace packages, resolved the same way pnpm does, plus directory longest-prefix lookup. */
const workspacePackages = () => {
  const { packages: patterns = [] } = parseYaml(
    readFileSync(path.join(REPO, "pnpm-workspace.yaml"), "utf8"),
  )
  const includes = patterns.filter((p) => !p.startsWith("!"))
  const excludes = patterns
    .filter((p) => p.startsWith("!"))
    .map((p) => p.slice(1).replace(/\/+$/, ""))
  const isExcluded = (dir) => excludes.some((e) => dir === e || dir.startsWith(`${e}/`))

  return fg
    .sync(
      includes.map((p) => `${p}/package.json`),
      { cwd: REPO, dot: false, ignore: ["**/node_modules/**"] },
    )
    .map((file) => path.dirname(file))
    .filter((dir) => !isExcluded(dir))
    .map((dir) => ({
      dir,
      name: JSON.parse(readFileSync(path.join(REPO, dir, "package.json"), "utf8")).name,
    }))
    .filter((pkg) => typeof pkg.name === "string")
}

const packages = workspacePackages()
const changedFiles = [
  ...new Set([
    ...git("diff", "--name-only", "--diff-filter=d", since),
    ...git("ls-files", "--others", "--exclude-standard"),
  ]),
]

/** Owning package = deepest workspace directory containing the file. */
const ownersOf = (file) =>
  packages
    .filter((pkg) => file === pkg.dir || file.startsWith(`${pkg.dir}/`))
    .sort((a, b) => b.dir.length - a.dir.length)[0]

const owners = new Map()
const orphanFiles = []
for (const file of changedFiles) {
  const owner = ownersOf(file)
  if (owner) owners.set(owner.name, owner)
  else orphanFiles.push(file)
}

const filters = [...owners.keys()].flatMap((name) => [`--filter=${name}`, `--filter=...${name}`])
const lintable = changedFiles.filter(
  (file) => LINTABLE.test(file) && existsSync(path.join(REPO, file)),
)

console.log(`[check:changed] since ${since} — ${changedFiles.length} changed file(s)`)
console.log(`[check:changed] packages: ${[...owners.keys()].join(", ") || "(none)"}`)
if (orphanFiles.length)
  console.log(`[check:changed] repo-level files (no package): ${orphanFiles.length}`)

if (dry) {
  console.log(`[check:changed] lint files: ${lintable.length}`)
  console.log(`[check:changed] turbo filters: ${filters.join(" ") || "(none)"}`)
  process.exit(0)
}

const run = (bin, binArgs) => {
  console.log(`\n[check:changed] $ ${path.basename(bin)} ${binArgs.join(" ")}`)
  try {
    execFileSync(bin, binArgs, { cwd: REPO, stdio: "inherit", env: { ...process.env, CI: "1" } })
    return true
  } catch {
    return false
  }
}

let ok = true
if (lint && lintable.length) ok = run(ESLINT, lintable) && ok
if (filters.length) ok = run(TURBO, ["run", "typecheck", "test", ...filters]) && ok
if (!ok) {
  console.error("\n[check:changed] failed")
  process.exit(1)
}
console.log("\n[check:changed] passed")
