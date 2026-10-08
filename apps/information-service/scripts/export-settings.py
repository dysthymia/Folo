#!/usr/bin/env python3
"""将本机信息服务的设置导出为可提交到 Git 的 JSON 快照。"""

import argparse
import json
import os
import pathlib
import sqlite3
import tempfile
from contextlib import closing


PRIVATE_FIELDS = {
    "ownerId",
    "owner_id",
    "apiKey",
    "apiKeyBaseUrl",
    "accessToken",
    "refreshToken",
    "sessionToken",
}
AI_FIELDS = ("provider", "model", "baseUrl", "reasoningEffort")


def public_settings(value):
    # 保留规则与来源引用，递归移除账号身份及凭据字段。
    if isinstance(value, dict):
        return {
            key: public_settings(item)
            for key, item in value.items()
            if key not in PRIVATE_FIELDS
        }
    if isinstance(value, list):
        return [public_settings(item) for item in value]
    return value


def json_body(database, query):
    row = database.execute(query).fetchone()
    return public_settings(json.loads(row[0])) if row else None


def rows(database, query):
    return [dict(row) for row in database.execute(query)]


def export_settings(data_directory, output_directory):
    data_directory = pathlib.Path(data_directory).resolve()
    output_directory = pathlib.Path(output_directory).resolve()
    if data_directory == output_directory:
        raise ValueError("输出目录不能覆盖正在使用的数据目录")

    private_ai = json.loads((data_directory / "ai-config.json").read_text(encoding="utf-8"))
    ai = {key: private_ai[key] for key in AI_FIELDS if key in private_ai}
    database_uri = (data_directory / "information.sqlite").as_uri() + "?mode=ro"
    with closing(sqlite3.connect(database_uri, uri=True)) as database:
        database.row_factory = sqlite3.Row
        # 只读事务保证所有设置来自同一快照，同时包含尚在 WAL 中的已提交修改。
        database.execute("BEGIN")
        information = {
            "formatVersion": 1,
            "automation": {
                "draft": json_body(database, "SELECT body FROM automation_draft WHERE id=1"),
                "published": json_body(
                    database,
                    "SELECT body FROM rule_set_releases ORDER BY version DESC LIMIT 1",
                ),
            },
            "processingSchedule": json_body(
                database, "SELECT body FROM processing_schedule WHERE id=1"
            ),
            "subscriptionTags": {
                "formatVersion": database.execute(
                    "SELECT format_version FROM subscription_tag_metadata WHERE id=1"
                ).fetchone()[0],
                "tags": rows(database, "SELECT id,name FROM subscription_tags ORDER BY id"),
                "bindings": rows(
                    database,
                    'SELECT source_key AS "sourceKey",tag_id AS "tagId" '
                    "FROM source_tag_bindings ORDER BY source_key,tag_id",
                ),
                "managedBindings": rows(
                    database,
                    'SELECT manager,source_key AS "sourceKey",tag_id AS "tagId" '
                    "FROM managed_source_tag_bindings ORDER BY manager,source_key,tag_id",
                ),
            },
        }

    contents = {
        "ai-config.json": json.dumps(ai, ensure_ascii=False, indent=2) + "\n",
        "information-settings.json": json.dumps(information, ensure_ascii=False, indent=2) + "\n",
    }
    # Prompt 可能手工粘贴过密钥；在写出任何文件前检查，失败时不回显密钥。
    api_key = private_ai.get("apiKey")
    if api_key and any(
        api_key in content or json.dumps(api_key)[1:-1] in content
        for content in contents.values()
    ):
        raise ValueError("设置文本含有 API Key，请先从规则或提示词中移除")

    output_directory.mkdir(parents=True, exist_ok=True)
    for name, content in contents.items():
        # 同目录临时文件原子替换，避免失败导出或已有符号链接写坏快照及源文件。
        descriptor, temporary = tempfile.mkstemp(prefix=".settings-", dir=output_directory)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as output:
                output.write(content)
            os.replace(temporary, output_directory / name)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    return [output_directory / name for name in contents]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--data-dir",
        default=os.environ.get(
            "FOLO_INFORMATION_DATA_DIR",
            str(pathlib.Path.home() / ".local/share/folo-information-p0"),
        ),
    )
    parser.add_argument(
        "--output-dir", default=pathlib.Path(__file__).resolve().parents[1] / "settings"
    )
    arguments = parser.parse_args()
    for path in export_settings(arguments.data_dir, arguments.output_dir):
        print(f"已导出 {path}（{path.stat().st_size} 字节）")
