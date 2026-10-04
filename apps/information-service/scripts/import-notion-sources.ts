import { readFileSync, writeFileSync } from "node:fs"
import { parseArgs } from "node:util"

import { readExternalConfig } from "../src/external-config"
import {
  applyNotionSourceImport,
  parseNotionSourceAccounts,
  previewNotionSourceImport,
  readNotionDatabaseSourceAccounts,
  readNotionSourceAccounts,
} from "../src/notion-source-import"
import { Store } from "../src/store"

// 默认只生成对账；只有显式 --apply 与预览 revision 一致时才写本地受管理标签。
const { values } = parseArgs({
  options: {
    db: { type: "string" },
    input: { type: "string" },
    format: { type: "string", default: "json" },
    "data-source": { type: "string" },
    database: { type: "string" },
    "external-config": { type: "string" },
    apply: { type: "boolean", default: false },
    revision: { type: "string" },
    output: { type: "string" },
    manager: { type: "string", default: "notion:x-accounts" },
  },
})
if (
  !values.db ||
  [values.input, values["data-source"], values.database].filter(Boolean).length !== 1
)
  throw new Error("需要 --db 和 --input / --data-source / --database 三者之一")
const store = new Store(values.db)
try {
  if (!store.ownerId) throw new Error("数据库尚未绑定已核验的 Folo 账号")
  const token =
    process.env.NOTION_TOKEN ??
    (values["external-config"] ? readExternalConfig(values["external-config"])?.notion.token : null)
  if ((values["data-source"] || values.database) && !token)
    throw new Error("需要 NOTION_TOKEN 或 --external-config 私有配置")
  if (values.format !== "json" && values.format !== "csv")
    throw new Error("format 必须为 json 或 csv")
  const accounts = values.input
    ? parseNotionSourceAccounts(readFileSync(values.input, "utf8"), values.format)
    : values.database
      ? await readNotionDatabaseSourceAccounts(token!, values.database)
      : await readNotionSourceAccounts(token!, values["data-source"]!)
  if (values.apply && (!values.revision || !/^\d+$/u.test(values.revision)))
    throw new Error("apply 需要 --revision（先读取预览）")
  const report = values.apply
    ? applyNotionSourceImport(store, accounts, Number(values.revision), values.manager)
    : previewNotionSourceImport(store, accounts, values.manager)
  const output = JSON.stringify(
    {
      mode: values.apply ? "applied" : "preview",
      accounts: accounts.length,
      generatedAt: new Date().toISOString(),
      ...report,
    },
    null,
    2,
  )
  if (values.output) writeFileSync(values.output, output, { mode: 0o600 })
  else process.stdout.write(`${output}\n`)
} finally {
  store.close()
}
