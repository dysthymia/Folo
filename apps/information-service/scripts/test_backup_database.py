"""验证快照写入外置目录、凭据不外流，以及保留策略只回收旧快照。"""

import datetime
import importlib.util
import os
import pathlib
import sqlite3
import tempfile
import unittest

# 脚本文件名带连字符（与其余脚本一致），不能直接按模块名导入。
_spec = importlib.util.spec_from_file_location(
    "backup_database", pathlib.Path(__file__).with_name("backup-database.py"))
backup_database = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(backup_database)

business_tables = backup_database.business_tables
create_snapshot = backup_database.create_snapshot
has_timestamp = backup_database.has_timestamp
prune = backup_database.prune
resolve_backup_dir = backup_database.resolve_backup_dir


def make_database(path: pathlib.Path, tokens: int = 2) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    try:
        connection.execute("CREATE TABLE entries (id INTEGER PRIMARY KEY, body TEXT)")
        connection.execute("CREATE TABLE entry_decisions (id INTEGER PRIMARY KEY, body TEXT)")
        connection.execute("CREATE TABLE access_tokens (token TEXT)")
        connection.executemany("INSERT INTO entries (body) VALUES (?)", [("条目",), ("另一条",)])
        connection.executemany(
            "INSERT INTO access_tokens (token) VALUES (?)", [(f"token-{index}",) for index in range(tokens)]
        )
        connection.commit()
    finally:
        connection.close()


class BackupDatabaseTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.database = self.root / "information.sqlite"
        self.backups = self.root / "backups"
        make_database(self.database)

    def tables(self, path: pathlib.Path) -> list[str]:
        connection = sqlite3.connect(path)
        try:
            return business_tables(connection)
        finally:
            connection.close()

    def test_snapshot_keeps_business_data_and_drops_tokens(self):
        target = self.backups / "before-feature-20261013-120000.sqlite"
        create_snapshot(self.database, target)

        self.assertTrue(target.is_file())
        # 业务表结构必须与业务库一致，否则恢复时会缺表。
        self.assertEqual(self.tables(target), self.tables(self.database))
        self.assertNotEqual(target.stat().st_mode & 0o777, 0o644)

        connection = sqlite3.connect(target)
        try:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM entries").fetchone()[0], 2)
            # 凭据不得随备份传播。
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM access_tokens").fetchone()[0], 0)
        finally:
            connection.close()

    def test_existing_destination_is_rejected(self):
        target = self.backups / "before-dup.sqlite"
        create_snapshot(self.database, target)
        with self.assertRaises(RuntimeError):
            create_snapshot(self.database, target)
        # 唯一业务库绝不能被当成备份目标覆盖。
        self.assertTrue(self.database.is_file())

    def test_failed_snapshot_leaves_no_partial_file(self):
        target = self.backups / "before-broken.sqlite"
        with self.assertRaises(sqlite3.DatabaseError):
            create_snapshot(self.root / "missing.sqlite", target)
        self.assertFalse(target.exists())
        self.assertEqual(list(self.backups.glob(".*tmp*")), [])

    def test_prune_keeps_latest_and_aged_files(self):
        now = datetime.datetime.now().timestamp()
        old = [
            self.write_snapshot(f"before-old-{index}.sqlite", now - (60 - index) * 86400)
            for index in range(3)
        ]
        fresh = [
            self.write_snapshot(f"before-fresh-{index}.sqlite", now - index * 60)
            for index in range(2)
        ]
        unrelated = self.backups / "browser-cache-20261013-205502"
        unrelated.mkdir()

        removed, freed = prune(self.backups, keep_latest=3, keep_days=30)

        # 最新的 3 个按时间保留，更旧的超出天数被回收。
        self.assertEqual(len(removed), 2)
        self.assertEqual(set(removed), {path.name for path in old[:2]})
        self.assertTrue(freed > 0)
        for path in fresh:
            self.assertTrue(path.is_file())
        # 浏览器缓存备份不是本流程产物，不能被波及。
        self.assertTrue(unrelated.is_dir())

    def write_snapshot(self, name: str, mtime: float) -> pathlib.Path:
        path = self.backups / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"snapshot")
        os.utime(path, (mtime, mtime))
        return path

    def test_human_reports_actual_size(self):
        # 快照实际约 1.06 GB，不能显示成1.0 MB（原实现少除了一级 1024）。
        self.assertEqual(backup_database.human(1110114304), "1.0 GB")
        self.assertEqual(backup_database.human(1024 ** 3), "1.0 GB")
        self.assertEqual(backup_database.human(0), "0.0 B")

    def test_timestamp_suffix_is_not_duplicated(self):
        self.assertTrue(has_timestamp("before-x-20261013-191059"))
        self.assertFalse(has_timestamp("before-x"))

    def test_backup_dir_prefers_explicit_path(self):
        self.assertEqual(resolve_backup_dir(str(self.backups)), self.backups)

    def test_unmounted_external_volume_refuses_silent_fallback(self):
        # 外置卷不可用时，内置盘空间不足必须报错而不是悄悄写回系统盘。
        from unittest.mock import patch

        with patch.object(backup_database, "DEFAULT_BACKUP_DIR", "/nonexistent-folo-backups"), \
             patch.object(backup_database, "free_gb", return_value=1.0):
            with self.assertRaises(SystemExit):
                backup_database.resolve_backup_dir(None)

    def test_unmounted_external_volume_falls_back_when_room_is_enough(self):
        from unittest.mock import patch

        with patch.object(backup_database, "DEFAULT_BACKUP_DIR", "/nonexistent-folo-backups"), \
             patch.object(backup_database, "free_gb", return_value=100.0):
            resolved = backup_database.resolve_backup_dir(None)
        self.assertEqual(resolved, backup_database.data_dir() / "backups")

    def test_mount_detection_follows_device_id(self):
        home = pathlib.Path.home()
        self.assertFalse(backup_database.mounted_elsewhere(self.root, home))
        external = pathlib.Path("/Volumes/SSD")
        if external.is_dir():
            # 外置卷在测试机上确实是独立设备；这正是不能退回系统盘的原因。
            self.assertTrue(backup_database.mounted_elsewhere(external, home))


if __name__ == "__main__":
    unittest.main()