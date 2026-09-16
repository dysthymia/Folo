import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"

import { afterEach, expect, it } from "vitest"

import { publicXConfig, readXConfig, saveXConfig } from "./x-config"

const paths: string[] = []
afterEach(() => paths.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })))

it("X token 保存在独立 0600 文件且公共设置不泄漏", () => {
  const directory = mkdtempSync(`${tmpdir()}/x-config-`)
  paths.push(directory)
  const path = `${directory}/x-config.json`
  expect(publicXConfig(readXConfig(path))).toMatchObject({ configured: false, enabled: false })
  expect(
    saveXConfig(path, { enabled: true, bearerToken: "secret-x-token", access: "recent_search" }),
  ).toMatchObject({ configured: true, enabled: true })
  expect(statSync(path).mode & 0o077).toBe(0)
  expect(JSON.stringify(publicXConfig(readXConfig(path)))).not.toContain("secret-x-token")
  expect(readXConfig(path)?.bearerToken).toBe("secret-x-token")
})
