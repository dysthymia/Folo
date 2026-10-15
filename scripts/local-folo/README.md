# Local Folo runtime

This directory keeps `http://local.folo.is` available after macOS restarts.

- `is.folo.local.proxy` checks every 600 seconds that Docker is responsive, the Apache container has persistent Folo virtual-host mounts, the installed production backend responds on port 2240, and the main page is reachable through `local.folo.is`. A Docker probe is limited to 15 seconds. If proxy health fails after the Docker services process accumulates at least 50,000 open files, it restarts the existing high-file-limit Docker LaunchAgent and restores the container immediately; otherwise it only restarts the proxy container.
- `is.folo.local.information` serves the installed production main page, information page and backend APIs from the internal disk. Builds are installed with `apps/information-service/scripts/install-launch-agent.py`; the domain no longer depends on Vite.
- `is.folo.local.dev-web` is an optional development stack; it starts the pinned `pnpm@10.17.0` web/SSR development stack and restarts it if it exits.

The LaunchAgents are installed in `~/Library/LaunchAgents`, while executable copies live in `~/Library/Application Support/FoloLocal` so macOS can start them before the external workspace is ready. Runtime logs are written to `/tmp/folo-local-proxy*.log` and `/tmp/folo-dev-web*.log`.

To disable both services:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/is.folo.local.proxy.plist
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/is.folo.local.dev-web.plist
```

## 生产更新与回退

使用 `pnpm --filter @follow/information-service backup:local -- --name before-<功能>` 备份业务数据库后，统一运行 `pnpm --filter @follow/information-service deploy:local`，完整构建后台、主站和信息页再一起安装。安装器核对源码及三份产物摘要，拒绝旧文件和局部构建，通过原子发布指针保留完整旧版目录。网页与规则执行器使用两个 LaunchAgent；更新只重启网页；仅界面变化时不重启执行器，后台代码变化时执行器完成当前扫描或规则批次后自动加载新版，不取消当前模型调用。首次从旧单进程拆分仍需空闲，手工选材研究运行中也暂不重启网页。模型配置和主站授权仍使用数据目录中的私有文件。可先执行 `build:local`，之后运行 `python3 apps/information-service/scripts/install-launch-agent.py` 安装；不要手工覆盖某一个运行产物。

主站根路径及 `/information` 都由 2240 的生产服务响应。开发时可以运行 2233，但不会自动替换域名上的生产版本。原开发代理配置可恢复到 `ProxyPass / http://host.docker.internal:2233/`，经 Apache 配置校验后平滑重载；不要重建业务库或重置 Codex 模型配置。

## 数据库快照

`apps/information-service/scripts/backup-database.py` 用 SQLite 的 `VACUUM INTO` 生成一致性副本，与 `deploy:local` 相互独立 —— 部署流程不负责备份，备份必须在部署前显式执行。

```bash
pnpm --filter @follow/information-service backup:local -- --name before-<功能>
pnpm --filter @follow/information-service backup:prune    # 只按保留策略回收
```

- **默认写到外置卷** `/Volumes/SSD/folo-verify-backups`。外置卷未挂载且内置盘可用空间不足 20 GB 时直接报错，不会静默退回系统盘堆快照；需要时用 `--backup-dir` 指定其它路径。
- **每次写入自动执行保留策略**：保留最新 5 份且不超过 30 天，只回收 `before-*.sqlite`，浏览器缓存备份等其它子目录不受影响。
- 快照会清空 `access_tokens`（短期凭据不随备份传播），权限为 `0600`；先写临时文件、校验通过后再原子改名，中断不会留下半个损坏快照。
- 业务库路径沿用 `FOLO_INFORMATION_DATA_DIR`，默认 `~/.local/share/folo-information-p0`。
