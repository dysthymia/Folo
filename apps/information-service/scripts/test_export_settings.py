"""验证设置快照不会携带密钥、账号身份或运行数据，也不会修改源库。"""

import json
import pathlib
import runpy
import sqlite3
import tempfile
import unittest


export_settings = runpy.run_path(str(pathlib.Path(__file__).with_name("export-settings.py")))[
    "export_settings"
]


class SettingsExportTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.source = pathlib.Path(self.temporary.name) / "source"
        self.output = pathlib.Path(self.temporary.name) / "output"
        self.source.mkdir()
        self.ai = {
            "provider": "codex",
            "model": "test-model",
            "reasoningEffort": "high",
            "apiKey": "private-test-key",
        }
        (self.source / "ai-config.json").write_text(json.dumps(self.ai))
        self.database = sqlite3.connect(self.source / "information.sqlite")
        self.addCleanup(self.database.close)
        # 保持 WAL 连接打开，验证导出读取提交后的规则而非仅复制主数据库文件。
        self.database.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE automation_draft(id INTEGER, body TEXT);
            CREATE TABLE rule_set_releases(version INTEGER, body TEXT);
            CREATE TABLE processing_schedule(id INTEGER, body TEXT);
            CREATE TABLE subscription_tag_metadata(id INTEGER, format_version INTEGER);
            CREATE TABLE subscription_tags(id TEXT, name TEXT, owner_id TEXT);
            CREATE TABLE source_tag_bindings(source_key TEXT, tag_id TEXT, owner_id TEXT);
            CREATE TABLE managed_source_tag_bindings(manager TEXT, source_key TEXT, tag_id TEXT);
            CREATE TABLE entries(body TEXT);
            CREATE TABLE access_tokens(hash TEXT);
            INSERT INTO subscription_tag_metadata VALUES(1,1);
            INSERT INTO subscription_tags VALUES('tag','示例标签','private-owner');
            INSERT INTO source_tag_bindings VALUES('feed/example','tag','private-owner');
            INSERT INTO processing_schedule VALUES(1,'{"times":["08:00"],"enabled":true}');
            INSERT INTO entries VALUES('private-article');
            INSERT INTO access_tokens VALUES('private-session');
        """)
        self.set_draft("已提交的提示词")
        self.database.execute(
            "INSERT INTO rule_set_releases VALUES(1,?)",
            (
                json.dumps({
                    "ownerId": "private-owner",
                    "global": {"markdown": "已发布提示词"},
                }),
            ),
        )
        self.database.commit()

    def set_draft(self, prompt):
        self.database.execute("DELETE FROM automation_draft")
        self.database.execute(
            "INSERT INTO automation_draft VALUES(1,?)",
            (
                json.dumps({
                    "ownerId": "private-owner",
                    "global": {"markdown": prompt},
                    "rules": [{"ownerId": "private-owner", "name": "规则"}],
                }),
            ),
        )
        self.database.commit()

    def test_export_settings_only_is_deterministic_and_preserves_source(self):
        original_ai = (self.source / "ai-config.json").read_bytes()
        original_rows = list(self.database.iterdump())
        paths = export_settings(self.source, self.output)
        original_exports = {path.name: path.read_bytes() for path in paths}
        settings = json.loads((self.output / "information-settings.json").read_text())
        self.assertEqual(
            settings["automation"]["draft"]["global"]["markdown"], "已提交的提示词"
        )
        self.assertEqual(
            settings["automation"]["published"]["global"]["markdown"], "已发布提示词"
        )
        self.assertEqual(
            settings["subscriptionTags"]["bindings"],
            [{"sourceKey": "feed/example", "tagId": "tag"}],
        )
        self.assertEqual(settings["processingSchedule"]["times"], ["08:00"])
        for private in (
            "private-test-key", "private-owner", "private-article", "private-session", "apiKey"
        ):
            self.assertFalse(
                any(private.encode() in content for content in original_exports.values())
            )
        export_settings(self.source, self.output)
        self.assertEqual(original_exports, {path.name: path.read_bytes() for path in paths})
        self.assertEqual(original_ai, (self.source / "ai-config.json").read_bytes())
        self.assertEqual(original_rows, list(self.database.iterdump()))

    def test_key_in_prompt_blocks_export_without_overwriting_snapshot(self):
        export_settings(self.source, self.output)
        before = {path.name: path.read_bytes() for path in self.output.iterdir()}
        self.set_draft(self.ai["apiKey"])
        with self.assertRaisesRegex(ValueError, "设置文本含有 API Key"):
            export_settings(self.source, self.output)
        self.assertEqual(before, {path.name: path.read_bytes() for path in self.output.iterdir()})

    def test_refuses_source_directory_and_its_symlink(self):
        alias = pathlib.Path(self.temporary.name) / "alias"
        alias.symlink_to(self.source, target_is_directory=True)
        for output in (self.source, alias):
            with self.assertRaisesRegex(ValueError, "输出目录不能覆盖"):
                export_settings(self.source, output)


if __name__ == "__main__":
    unittest.main()
