# Notion X 来源导入与对账

Notion 维护账号分类；此工具只读 Notion，在显式 apply 时写本机 Folo 标签，不订阅新来源，也不回写 Notion。所有操作先预览，冲突账号不自动绑定，源标题不参与身份匹配。

## 使用

从仓库根目录执行（数据库必须已经绑定已核验的 Folo 账号）：

```bash
# 离线 JSON / CSV 清单对账，默认 preview
pnpm --filter @follow/information-service exec node --import tsx scripts/import-notion-sources.ts \
  --db /absolute/path/information.sqlite --input /absolute/path/accounts.json --output /absolute/path/preview.json

# 直接读取 Notion 账号数据库，token 复用现有独立 0600 external-config 文件
pnpm --filter @follow/information-service exec node --import tsx scripts/import-notion-sources.ts \
  --db /absolute/path/information.sqlite --database NOTION_DATABASE_ID \
  --external-config /absolute/path/external-config.json --output /absolute/path/preview.json

# 数据库存在多个 data source 时，使用 --data-source 指定账号清单；也可通过 NOTION_TOKEN 提供 token
# 检查报告后，用同一份输入和预览返回的 revision 写入本地标签
pnpm --filter @follow/information-service exec node --import tsx scripts/import-notion-sources.ts \
  --db /absolute/path/information.sqlite --input /absolute/path/accounts.json --apply --revision 12 \
  --output /absolute/path/applied.json
```

`--format csv` 接受 Username / 用户名、Link / URL / 链接、Tags / 标签，以及可选 ID / Page ID、User ID / X User ID。标签使用逗号、分号或竖线分隔；含逗号的字段需要 CSV 引号。JSON 可以使用规范化数组，或 Notion query 接口完整的 `{ "results": [...] }` 导出。

```json
[
  {
    "id": "notion-page-id",
    "username": "@example",
    "url": "https://x.com/example",
    "tags": ["AI", "Crypto-投研"]
  }
]
```

可选 `userId` 为字符串形式的稳定 X ID；`active: false` 的记录继续出现在对账中但不写标签。直接读取 Notion 时，归档页面和已取关 / 取关 / unfollowed checkbox 为 true 的记录按 inactive 处理。属性名支持 Username、User ID、X User ID、URL、Link、Tags 及上述中文别名，显示名称不能代替 Username。

## 身份与替换

优先稳定 ID，缺 ID 时规范化 @ / X URL / 大小写匹配，兼容 RSSHub twitter/x 的 user 与 user_by_id 路由。同名显示名称、多路由、多份登记、来源 URL 与 route 身份相互矛盾时必须人工处理。来源只有 username 而输入已给稳定 ID 时，不用同名猜测 ID。

`manager` 默认为 `notion:x-accounts`。每次只替换无冲突匹配记录上该 manager 前次写入的标签；不删除未在本次清单出现的账号绑定。手工标签保留；用户手工再次添加受管理标签后，工具不再拥有删除该绑定的权限。标签定义保留，以免破坏已发布规则引用。导入事务有 revision 校验，过期预览拒绝写入。账号改名、取关清理不通过猜测自动执行。

## 报告

每行包含 accountId、username、sourceKeys、状态、期望 tagNames、待加 add、仅受管理标签的待删 remove、lastSuccessAt 与 failure。状态包括：

- `source_missing`：Notion 有登记，本机没有匹配来源。
- `identity_conflict`：身份或多路由冲突，不自动写入。
- `fetch_error`：该来源获取失败，保留最近错误。
- `not_in_plan`：已匹配但未纳入当前处理计划，或 inactive。
- `needs_context`：正文、引用、串文或图片关键材料待补。
- `awaiting_fetch`：来源已纳入但尚未取得完整获取成功记录。
- `ready`：标签与范围可处理，获取成功；不表示模型已处理或内容质量已验收。

报告含来源清单刷新状态 `inventory`：`fresh` / `previous` 与 failure。订阅刷新失败不清空旧快照；分页预算与时间戳边界仍在运行报告逐源 coverage 中记录，不能称为完整覆盖。

## 材料保护边界

后台先刷新清单，再解析动态范围并冻结新批次；空闲轮询每分钟发现新订阅，显式待处理批次立即刷新，同一轮只核验一次会话并读取一次清单。

普通无图短公告可以处理，不采用字数淘汰。普通 status 外链、推荐线程与自足正文的配图不代表材料缺失。明确不可用引用、缺段串文、截断提示，以及依赖关键图表的简短说明保持 missing / needs_context；实际 HTML 包含实质引用原帖正文或完整编号串文时可核验相应 complete。紧迫材料优先按每批最多 8 条补读、处理并正式发布，下轮可重试；已读条目仍在读取前跳过。此阶段没有新增图片视觉或完整 X 串文抓取 API，图片下载不等于图片已读，不虚报上下文已获取。
