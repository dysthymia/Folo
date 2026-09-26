# Folo 项目长期记忆

## 质量门（2026-09-26 定案）

- **两档**：迭代期用 `pnpm run check:changed`（= `scripts/check-changed.mjs`：只 eslint 改动文件 + 对「拥有这些文件的包及其下游」跑 typecheck/test）；提交/PR 前才跑全量 `turbo run format:check typecheck lint` + `turbo run test`。**不再「每次改动跑全仓」。**
- `format:check` / `lint` 是**根任务**（`//#format:check`、`//#lint`＝整仓 prettier/eslint/tsslint），`--filter` 对它们无效；改动文件的 eslint+prettier 由 pre-commit 的 lint-staged 兜底。
- **别用 `turbo run ... --filter="[HEAD]"` 当增量门**：本仓 turbo 2.10.4 的 git 过滤**非确定**（同一状态反复跑，归属在 `@follow/web` 与 `Folo` 之间跳）。归到 `Folo` 时因该包**没有 typecheck/test 脚本**，turbo 静默跳过任务并 exit 0 —— 看起来通过、其实什么都没查。`scripts/check-changed.mjs` 用「最长目录前缀」定归属来绕开这一点。
- `test` 任务必须带 `CI=1`（部分包 test 脚本是裸 `vitest`＝watch 模式，会挂住）。
- `typecheck` 在 turbo.json 里 `dependsOn: ["@follow/electron-main#build"]`，所以任何 typecheck 都会先拉一次 electron-main 的 tsc（有缓存时约 15s）。
- turbo 默认 `continue: false`：同批里一个任务失败，其余任务会被**中途掐掉**。日志尾部看到「测试全绿 / Test Files 78 passed」也不能当通过 —— 先看 turbo 汇总行的 `Tasks: N successful, M total`。
- 想只复现某个包（比整门快得多）：类型 = `cd apps/desktop/layer/renderer && ../../../../node_modules/.bin/tsc --noEmit`；单文件测试 = 同目录 `CI=1 ../../../../node_modules/.bin/vitest run <file>`。注意 `@follow/web` 的 `test` 是 `vitest --typecheck`，会连 test-d.ts 一起检查。
- 这个 vitest 版本里裸 `vi.fn()` 推断为 `Mock<Procedure | Constructable>`，赋给具体函数签名会 TS2322。要 mock 有参回调必须写 `vi.fn<(a: T) => R>(...)`。

## 本机环境（易踩）

- **没有全局 pnpm**；corepack 0.34.6 在 `~/.workbuddy/binaries/node/versions/22.22.2-3/bin/corepack`，但未 enable。直接跑 `node_modules/.bin/turbo` 会报 `Unable to find package manager binary` —— turbo 需要 `PATH` 里有 pnpm（或用 `npx --yes pnpm@10.17.0 run <script>`）。
- 系统数据卷 `/System/Volumes/Data` 已近满（曾出现 ENOSPC、备份写失败）；仓库在 `/Volumes/SSD`（空间充足）。
- **AGENTS.md 无法由代理写入**（Edit / rm / cp 均被文件代理拒绝：`modify backup failed`），同仓库其它文件可正常改。改 AGENTS.md 需用户在普通终端执行，补丁见 `.workbuddy/AGENTS.md.patched`。
