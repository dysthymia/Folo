"""用内存 SQLite 验证上游同步迁移与本地打开统计迁移的接续。"""

import json
import sqlite3
import unittest
from pathlib import Path

DRIZZLE = Path(__file__).resolve().parents[1] / "src" / "drizzle"
JOURNAL = json.loads((DRIZZLE / "meta" / "_journal.json").read_text())["entries"]
LOCAL_LEGACY_TIMESTAMP = 1781791521000


class MigrationCompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("CREATE TABLE __drizzle_migrations (created_at INTEGER)")
        self.addCleanup(self.db.close)

    def migrate(self, entries):
        # 与桌面和移动迁移器一致：按最后成功迁移的时间戳接续。
        latest = self.db.execute("SELECT MAX(created_at) FROM __drizzle_migrations").fetchone()[0]
        for entry in entries:
            if latest is not None and latest >= entry["when"]:
                continue
            self.db.executescript((DRIZZLE / (entry["tag"] + ".sql")).read_text())
            self.db.execute("INSERT INTO __drizzle_migrations VALUES (?)", (entry["when"],))

    def seed_entry(self):
        self.db.execute(
            "INSERT INTO entries (id, guid, inserted_at, feed_id, published_at) VALUES ('entry-1', 'guid-1', 1000, 'feed-1', 1000)"
        )

    def assert_complete_schema(self):
        tables = {row[0] for row in self.db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertTrue({"sync_transactions", "sync_meta", "entry_open_stats"}.issubset(tables))
        columns = {row[1] for row in self.db.execute("PRAGMA table_info(sync_transactions)")}
        self.assertIn("user_id", columns)
        self.db.execute("INSERT INTO sync_transactions VALUES ('tx-1', 'read', '{}', 10, 'owner-1')")
        self.assertEqual(self.db.execute("SELECT user_id FROM sync_transactions").fetchone()[0], "owner-1")

    def test_fresh_database(self):
        self.migrate(JOURNAL)
        self.assert_complete_schema()
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM __drizzle_migrations").fetchone()[0], 42)

    def test_existing_local_0038_preserves_open_history(self):
        self.migrate(JOURNAL[:38])
        self.seed_entry()
        # 构造旧本地0038已成功执行的真实结构与时间戳，不读取任何在线数据库。
        legacy_sql = (DRIZZLE / "0041_local_entry_open_stats.sql").read_text()
        legacy_sql = legacy_sql.replace(" IF NOT EXISTS", "").replace("INSERT OR IGNORE", "INSERT")
        self.db.executescript(legacy_sql)
        self.db.execute("INSERT INTO __drizzle_migrations VALUES (?)", (LOCAL_LEGACY_TIMESTAMP,))
        self.db.execute(
            "UPDATE entry_open_stats SET first_opened_at=2000, open_source='timeline' WHERE entry_id='entry-1'"
        )
        self.db.execute(
            "INSERT INTO entries (id, guid, inserted_at, feed_id, published_at) VALUES ('entry-2', 'guid-2', 3000, 'feed-1', 3000)"
        )
        self.migrate(JOURNAL)
        self.assert_complete_schema()
        self.assertEqual(
            self.db.execute("SELECT first_opened_at, open_source FROM entry_open_stats WHERE entry_id='entry-1'").fetchone(),
            (2000, "timeline"),
        )
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM entry_open_stats").fetchone()[0], 2)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM entries").fetchone()[0], 2)
        self.db.execute("INSERT INTO sync_meta VALUES ('cursor', 'retained')")
        self.migrate(JOURNAL)
        self.assertEqual(self.db.execute("SELECT value FROM sync_meta WHERE key='cursor'").fetchone()[0], "retained")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM entry_open_stats").fetchone()[0], 2)

    def test_existing_upstream_0040_backfills_local_stats(self):
        self.migrate(JOURNAL[:41])
        self.seed_entry()
        self.db.execute("INSERT INTO sync_meta VALUES ('cursor', 'retained')")
        self.migrate(JOURNAL)
        self.assert_complete_schema()
        self.assertEqual(self.db.execute("SELECT value FROM sync_meta WHERE key='cursor'").fetchone()[0], "retained")
        self.assertEqual(self.db.execute("SELECT entry_id, published_at FROM entry_open_stats").fetchone(), ("entry-1", 1000))

    def test_snapshot_matches_integrated_tables(self):
        self.migrate(JOURNAL)
        snapshot = json.loads((DRIZZLE / "meta" / "0041_snapshot.json").read_text())
        for name in ("entry_open_stats", "sync_transactions", "sync_meta"):
            actual = {row[1] for row in self.db.execute(f"PRAGMA table_info({name})")}
            self.assertEqual(actual, set(snapshot["tables"][name]["columns"]))
        self.assertTrue(all(left["when"] < right["when"] for left, right in zip(JOURNAL, JOURNAL[1:])))


if __name__ == "__main__":
    unittest.main()
