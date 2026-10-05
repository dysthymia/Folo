import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"

import { join } from "pathe"
import { expect, it } from "vitest"

import { resolveCodexCommand } from "./codex-command"

it("CLI解析共用显式覆盖和客户端内置版本，无客户端时回退PATH", async () => {
  const directory = await mkdtemp(join(tmpdir(), "folo-cli-resolution-"))
  try {
    // 用临时可执行文件验证选择规则，不读取凭据或启动真实推理。
    const bundledPath = join(directory, "bundled-codex")
    await writeFile(bundledPath, "#!/bin/sh\nexit 0\n")
    await chmod(bundledPath, 0o700)
    expect(
      resolveCodexCommand({ override: "/explicit/codex", platform: "darwin", bundledPath }),
    ).toBe("/explicit/codex")
    expect(resolveCodexCommand({ override: "", platform: "darwin", bundledPath })).toBe(bundledPath)
    expect(resolveCodexCommand({ override: "", platform: "linux", bundledPath })).toBe("codex")
    expect(
      resolveCodexCommand({
        override: "",
        platform: "darwin",
        bundledPath: join(directory, "missing"),
      }),
    ).toBe("codex")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
