# Folo Information Service

独立 Node 后台：复用主站登录授权、保存来源和分页进度、通过 Codex CLI 调用后台配置的模型，将结果交给 Folo 的生产 Web `/information` 页面。当前已接入规则编辑、发布、处理计划与 Story；完整 v3.1 的真实验收仍以台账为准。

早期 P0 实测见 [P0 验证记录](../../docs/information-p0-verification.md)。真实 Feed 已跑通读取、模型处理、落盘和同域展示；长期观察及分页覆盖边界仍待验收。

v3.1 的完整开发范围和逐项状态见 [开发与验收台账](../../docs/information-v3.1-progress.md)。规则核心与 `/information/v1/` API 已连接 Actions、后台 worker 和稳定阅读页。日常配置、标签、预览、发布回退与排错见 [使用与运维手册](../../docs/information-user-guide.md)。开发完成度与真实效果验收分别记录。

## 运行

需要 Node >=24.5（本机已测26.8.1）、pnpm、Codex CLI >=0.134，以及当前浏览器中的 Folo 主站登录；千问模式使用独立 API Key，OpenAI 模式才需要 Codex 登录。命令从仓库根目录执行。

```sh
pnpm install --frozen-lockfile
# 构建后台、主站和信息页，校验同一份源码与三份文件摘要，再一起安装。
pnpm --filter @follow/information-service deploy:local

# 只准备完整发布；首次拆分安装需等旧版任务结束，后续可在规则运行中安装。
pnpm --filter @follow/information-service build:local
python3 apps/information-service/scripts/install-launch-agent.py --check
python3 apps/information-service/scripts/install-launch-agent.py

# 临时调试可使用 serve；不要与已安装的常驻 worker 同时运行。
# pnpm --filter @follow/information-service start serve

# 在已登录 Folo 的浏览器打开 http://local.folo.is/information，无需 connect。
```

打开工作台时，页面沿用主站的认证客户端生成一次性凭据；同源 POST 交给后台，后台通过官方 apply 接口和 get-session 核验账号后返回快照。没有另一套工作台登录或绑定操作。未登录时提供主站登录入口；账号不符时不显示已有数据；返回页面和刷新时重新核验。

后台凭据原子保存在 `~/.local/share/folo-information-p0/web-credential.json`（0600），不写入页面、日志或业务快照，也不改写 `~/.folo/config.json`。每项后台任务优先读取网页授权；旧安装尚无网页授权时才兼容 CLI 配置。网页授权失效后不会悄悄回退到另一个账号，重新打开已登录的工作台即可更新。

`connect` 命令仅保留打开工作台的兼容入口，不签发本地会话。旧 `/information/connect` 返回 410，旧 Cookie 不再授权；快照接口只接受同源 POST 和新的一次性凭据。服务仍仅监听127.0.0.1:2240，Apache 代理 `/information` 与 `/information-static/`，主站页面也由同域生产构建提供。

## 旧 P0 调试命令

```sh
# 使用 sync 返回的真实来源 key，支持 feed/、list/、inbox/。
pnpm --filter @follow/information-service start scan --source 'feed/<id>' --limit 5 --pages 3
pnpm --filter @follow/information-service start status
pnpm --filter @follow/information-service start items

# 可在 status / 结果快照中查看任务；单次 worker 适合调试恢复。
pnpm --filter @follow/information-service start run-once

# 使用 Folo 后台保存的 provider/model；也可用 --model 覆盖本条任务的模型。
pnpm --filter @follow/information-service start process --source 'feed/<id>' --entry '<entry-id>'

# 继续预算暂停或失败的扫描，保留已经落盘的游标。
pnpm --filter @follow/information-service start resume --job '<scan-job-id>'

# 验证已订阅列表的成员与完整性。
pnpm --filter @follow/information-service start members --source 'list/<id>'
```

以下描述是旧 P0 调试队列的口径；正式自动化由 Actions 计划驱动，智能阅读按固定快照分页提供全量范围，不受此调试快照条数限制。

`scan` / `process` 只入队；安装版的 `serve-web` 负责网页/API，独立的 `worker` 执行队列。临时调试的 `serve` 同时包含两种角色，`run-once` 执行一次；任何时候只有一个进程能够持有 worker 锁。扫描默认3页、每页5条并取详情，不代表历史全量完成。`status` 返回最近100项任务；Web最多展示最近200条输入和100条结果。分页字段 `coverage` 区分 `pending`、`budget`、`end`、`timestamp_boundary`，`succeeded` 只代表本次作业正常结束。

现有上游分页用 `publishedAfter` 表示继续读取更早条目。没有可验证的 ID 次序游标，时间戳密集边界、API保留范围、迟到条目和更新覆盖都必须实测；不能把短页当作全部历史已覆盖的证明。适配器在游标不前进或页面逆序时失败并保留断点。检测到多条相同边界时间时保留覆盖缺口标记，不使用减1毫秒跳过数据。

页面详情与水位在同一 SQLite 事务提交；事务回滚时内存水位也不前进。进程重启后扫描恢复排队，运行中的模型任务标为 `interrupted_model_outcome_unknown`，不自动重复调用。对相同账号、来源、条目、正文、标题、材料类型、模型与 Prompt 版本，成功结果幂等复用。需重试失败的模型任务时明确重新入队。

`source_text` 表示上游提供的正文，不保证是外站文章全文。Feed/List 详情没有有效正文时，按条目 ID 请求 Folo 官方 readability 接口；仍没有正文才处理描述并标记 `description_only`。正文接口认证或网络错误显式失败；邮箱只使用邮件自身材料。没有材料报 `material_missing`。旧 P0 命令超过60000字符报 `needs_context`；正式自动化对长文执行完整分块、逐块引用校验与综合，不静默截断，分块或汇总失败仍保留明确待处理状态。不会主动抓取任意外部 URL 或自动修改官方条目阅读状态。

## Folo AI 模型设置

在头像菜单打开「设置 → AI → 本机处理模型与密钥」，从本机 Codex CLI 目录选择模型，或填写自定义模型的 API 基础地址、模型 ID 和 API Key。自定义接口需兼容 OpenAI Chat Completions 与结构化 JSON；「使用千问配置」保留原千问兼容入口。模型目录查询不调用模型；缓存目录会明确标为可能过期。信息工作台新处理任务及 `local.folo.is` 原有 AI 聊天共用此设置；其他部署的聊天仍走原官方接口。点击保存后才生效，新处理目标固定 provider/model/endpoint，旧结果保持原模型记录。详细说明见 [使用指南](../../docs/information-user-guide.md#设置规则与模型)。

**执行框架始终是 Codex CLI。** 千问调用使用任务专用 `CODEX_HOME` 和 `folo.config.toml`，通过 `codex exec --profile folo` 请求每任务独立的回环 Responses 桥。桥将 Codex 的 `text.format` 转换为千问 Chat Completions 的 `response_format.json_schema`（严格模式），固定请求 `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` 并关闭 thinking；这样避免千问 Responses 忽略格式约束。模型能力目录和实际输出 Schema 保留在专用目录，最终仍严格验证 JSON、业务结构与原文引用。桥仅接受纯文本输入，不向上游转发工具声明，拒绝实际工具调用；失败不自动换模型或重复付费调用。

单篇与长文的模型输出只选择本次请求中的原文证据编号，服务端据此还原连续原文引文；Story 聚合和修复按候选条目与事实编号交叉校验引用。未知编号与模型自由输出的 quote 均被拒绝，映射后仍保留原有引用和展示策略校验。编号保证引用出自原文，不代表摘要或事实表述已经完成人工语义验收。已保存的决策格式不变，新 Prompt 版本隔离待处理任务的缓存。

密钥只存数据目录 `ai-config.json`（0600），运行时由父进程中的桥持有；Codex 子进程仅获得一次性回环令牌 `FOLO_QIANWEN_PROXY_TOKEN`，不会获得真实千问 Key。profile、命令行、浏览器响应、日志和数据库不含真实 Key。任务完成后关闭回环端口并删除专用目录。不会修改 `~/.codex/config.toml`、客户端模型选择或全局环境变量。设置中的空密码表示保留已有 Key。

接口均要求同源请求及新的主站 OTT：`POST /information/api/settings` 读取元信息，`PUT` 保存；`POST /information/api/chat` 接收 AI SDK UIMessage。聊天读取用户的富文本 Markdown 和历史对话，当前文章通过 Folo 官方接口补全，时间线最多取 4 个来源各 5 篇并告知覆盖范围；本轮没有接入附件解析和联网工具。CLI 完成并校验后通过 UIMessage SSE 返回正文，等待期间显示进行中，关闭连接会取消 CLI 子进程。

## 配置与数据

| 环境变量                         | 默认值                                      |
| -------------------------------- | ------------------------------------------- |
| `FOLO_INFORMATION_DATA_DIR`      | `~/.local/share/folo-information-p0`        |
| `FOLO_INFORMATION_CLI_CONFIG`    | `~/.folo/config.json`                       |
| `FOLO_INFORMATION_PUBLIC_ORIGIN` | `http://local.folo.is`                      |
| `FOLO_INFORMATION_PORT`          | `2240`                                      |
| `FOLO_INFORMATION_WEB_ROOT`      | 包目录下的 `../desktop/out/information-web` |

SQLite文件权限0600，初建目录0700，使用WAL。服务错误仅打印固定分类，不输出SDK异常正文或Codex原始日志。Codex调用使用独立临时目录、stdin输入、结构化输出和运行时校验，关闭Web搜索并配置工具限制，检测到工具事件立即中止。该限制**不是独立安全容器**：CLI 0.151.0对 `unified_exec=false` 的实际行为有限制，不能把事件检测称为事前阻止全部副作用的保证。

网络沿用进程中的代理变量；本机 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 为已有配置，启动脚本启用 Node 的环境代理支持，不修改全局设置。官方 API origin 当前限定为 `https://api.folo.is`。

## 定向检查

```sh
pnpm --filter @follow/information-service typecheck
pnpm --filter @follow/information-service lint
pnpm --filter @follow/information-service format:check
pnpm --filter @follow/information-service test
pnpm --filter @follow/information-service build
pnpm --filter @follow/information-service build:web
```

Folo读取、SQLite恢复、服务授权测试使用可控测试数据；Codex适配器使用真实子进程的假CLI测试取消和异常退出。离线测试不能替代目标账号的真实权限与分页验收。

## local.folo.is 反向代理

本机已在 `output/local-folo.conf` 的虚拟主机中将以下规则置于现有根路径代理之前，并通过 Apache 配置检查与平滑重载。该文件属于本机运行配置，未纳入 Git。

```apache
# 信息工作台及生产静态资源使用同一站点域名。
ProxyPass /information-static/ http://host.docker.internal:2240/information-static/
ProxyPassReverse /information-static/ http://host.docker.internal:2240/information-static/
ProxyPass /information http://host.docker.internal:2240/information
ProxyPassReverse /information http://host.docker.internal:2240/information
```

保留 `ProxyPreserveHost On`。访问日志使用 `SetEnvIf Request_URI "^/information/connect$" folo_information_connect`，并在原 `CustomLog` 后添加 `env=!folo_information_connect`，使一次性连接票据不进入访问日志。

`build:web` 复用桌面 Vite 配置、页面组件和UIKit样式，独立入口为 `information-main.tsx`，静态资源基路径为 `/information-static/`。它仅初始化页面翻译和后台读接口，不等待阅读器数据库的初始化或账号同步；避免同域打开时被阅读器初始化阻塞。

## macOS 常驻部署

处理顺序固定为：完全同文去重 → 分类/标签与事实提取 → 按标签隐藏/虚化 → 语义去重 → 综述。完全同文阶段沿用已启用去重规则的范围，只用完整一致的材料分组，并复用代表条目的模型分析；每条原文仍独立匹配阅读策略，所有来源和正文保留。规则列表最前面显示这一固定步骤，后续规则按上述阶段排列；规则优先级用于同字段冲突裁决，不能替代执行依赖。

安装器将后台、主站和信息页作为完整发布复制到 `~/Library/Application Support/FoloLocal/information-releases/<发布号-文件摘要>`，`information-runtime` 原子指向当前版本，`information-runtime-previous` 指向上一版。网页/API 由 `is.folo.local.information` 管理，自动化执行器由 `is.folo.local.information.worker` 管理；二者通过同一个 WAL 数据库交换任务和结果。更新只重启网页进程；仅界面有变化时，执行器无需重启。后台代码有变化时，执行器保持原 PID 和完整旧版代码，完成当前扫描作业或规则批次后自行退出，再由 LaunchAgent 启动新版。连续发布也不会删除仍在使用的旧目录；历史目录需在确认不再使用后人工清理。首次从旧单进程迁移需等待任务空闲；手工选材研究仍在网页进程执行，其运行中暂不重启网页。数据库仍在原数据目录，后台不依赖外置工作区挂载，更新统一使用 `deploy:local`。

`build:local` 在构建前后计算源码内容摘要，包含未提交源码、新文件和本机 Vite 环境文件；三份构建全部成功后才写入 `dist/local-release.json`。安装器要求清单、当前源码和每个产物文件一致，并校验复制后的文件。缺失前端、源码变化、单独重建或直接修改 bundle 都会在停服务前被拒绝；`--check` 只核对发布，不操作服务。各个原有 `build` 命令仍可用于开发，但不能独立形成可安装的发布。构建与安装共用文件锁，避免并发发布混用目录。

发布号嵌入两份前端，并由后台通过 `X-Folo-Local-Release` 返回。已打开的旧标签页下次请求本地接口时，后台在鉴权和写入前拒绝不同发布号；自动化页显示“页面版本已过期”并提供整页刷新，保留未保存修改且刷新前仍确认丢弃草稿。安装就绪检查同时核对真实响应的发布号，HTTP 200 不再单独代表发布成功。

日志：`~/Library/Logs/FoloInformation/service.log`、`service.error.log`；独立规则执行器使用同目录的 `worker.log`、`worker.error.log`。这是登录用户级常驻，退出账号或休眠时不保证继续工作；安装器不自行创建规则或启用计划；服务会执行用户已保存、发布并启用的处理计划。安装器只继承已有代理及运行目录，不复制认证密钥。千问模式由每次运行的独立 profile 提供配置；OpenAI 模式保留本机 Codex 登录，没有自动备用模型。

```sh
# 检查服务；停止时只卸载此服务，保留部署产物和数据库。
launchctl print "gui/$(id -u)/is.folo.local.information"
launchctl bootout "gui/$(id -u)/is.folo.local.information"
```
