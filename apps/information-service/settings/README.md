# 信息服务设置快照

这里保存从本机信息服务导出的设置，供 Git 查看差异和保存版本：

- `ai-config.json`：服务商、模型、接口地址和推理强度，不包含 API Key。
- `information-settings.json`：当前规则草稿、当前生效规则、全局提示词、处理计划、来源标签及其绑定关系。

快照移除账号身份，保留规则 ID、来源 ID 和标签 ID，以保存配置之间的引用关系。文章、处理结果、阅读记录、会话票据和历史发布版本不进入快照。提示词保留原文；如果其中包含当前 AI 密钥，导出会失败。

在仓库根目录更新快照：

```sh
python3 apps/information-service/scripts/export-settings.py
pnpm exec prettier --write apps/information-service/settings/*.json
git diff -- apps/information-service/settings
```

数据目录默认是 `~/.local/share/folo-information-p0`，也可通过 `FOLO_INFORMATION_DATA_DIR` 或 `--data-dir` 指定。

本机设置仍保存到原数据目录。此快照不会自动导入或自动更新，修改设置后需重新导出并提交；换电脑时按快照在设置界面恢复配置，密钥需要单独填写。完整业务库的恢复方式见[使用与运维手册](../../../docs/information-user-guide.md#部署与数据恢复)。
