#!/usr/bin/env python3
"""把信息库的一致性快照写到指定备份目录，并按保留策略回收旧快照。

备份走 SQLite 的 VACUUM INTO，与 backup-information-db.ts 同一条一致性路径；
默认落到外置卷，避免单份上 GB 的快照长期占用内置盘。

用法：
    python3 scripts/backup-database.py --name before-<功能>-<时间戳>
    python3 scripts/backup-database.py --name ... --backup-dir /path/to/backups
    python3 scripts/backup-database.py --prune-only
"""
import argparse
import datetime
import json
import os
import pathlib
import re
import shutil
import sqlite3
import sys
import tempfile

DEFAULT_BACKUP_DIR = "/Volumes/SSD/folo-verify-backups"
# 单份快照已到GB 级，内置盘只剩几 GB 时不再往系统盘写。
INTERNAL_FALLBACK_LIMIT_GB = 20
KEEP_LATEST = 5
KEEP_DAYS = 30
VOLATILE_TABLES = ("access_tokens",)


def data_dir() -> pathlib.Path:
    return pathlib.Path(
        os.environ.get(
            "FOLO_INFORMATION_DATA_DIR", str(pathlib.Path.home() / ".local/share/folo-information-p0")
        )
    )


def human(size: int) -> str:
    """字节数转可读字符串。"""
    n = float(size)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def free_gb(path: pathlib.Path) -> float:
    try:
        return shutil.disk_usage(path).free / 1024**3
    except OSError:
        return float("inf")


def integrity_check(connection: sqlite3.Connection) -> None:
    rows = connection.execute("PRAGMA quick_check").fetchall()
    if len(rows) != 1 or any(value != "ok" for value in rows[0]):
        raise RuntimeError("sqlite_integrity_check_failed")


def business_tables(connection: sqlite3.Connection) -> list[str]:
    rows = connection.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    return sorted(name for (name,) in rows if not name.startswith("sqlite_"))


def create_snapshot(database: pathlib.Path, target: pathlib.Path) -> None:
    """用 VACUUM INTO 生成一致性副本；目标必须是新文件，避免误覆盖唯一业务库。"""
    if target.exists():
        raise RuntimeError("backup_destination_exists")
    target.parent.mkdir(parents=True, exist_ok=True)
    # 先写临时文件并校验，通过后再原子改名，避免中断留下半个损坏快照。
    handle, temporary = tempfile.mkstemp(dir=target.parent, prefix=".snapshot-", suffix=".tmp")
    os.close(handle)
    staged = pathlib.Path(temporary)
    try:
        source = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)
        try:
            integrity_check(source)
            tables = business_tables(source)
            source.execute("VACUUM INTO ?", (str(staged),))
        finally:
            source.close()
        snapshot = sqlite3.connect(staged)
        try:
            # 会话票据属于短期私密凭据；业务库恢复后应重新签发，不能随备份传播。
            existing = {row[0] for row in snapshot.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")}
            for table in VOLATILE_TABLES:
                if table in existing:
                    snapshot.execute(f"DELETE FROM {table}")
            snapshot.commit()
            integrity_check(snapshot)
            restored = business_tables(snapshot)
        finally:
            snapshot.close()
        if restored != tables:
            raise RuntimeError("business_tables_missing_from_backup")
        staged.chmod(0o600)
        staged.replace(target)
    except Exception:
        staged.unlink(missing_ok=True)
        raise


def mounted_elsewhere(path: pathlib.Path, reference: pathlib.Path) -> bool:
    """判断 path 是否位于与 reference 不同的卷上（外置卷已挂载）。"""
    try:
        return os.stat(path).st_dev != os.stat(reference).st_dev
    except OSError:
        return False


def resolve_backup_dir(requested: str | None) -> pathlib.Path:
    if requested:
        return pathlib.Path(requested).expanduser()
    home = pathlib.Path.home()
    # 外置卷未挂载时不要静默回落到内置盘，否则又会在系统盘堆GB 级快照。
    external = pathlib.Path(DEFAULT_BACKUP_DIR)
    if external.is_dir() and mounted_elsewhere(external, home):
        return external
    if free_gb(home) < INTERNAL_FALLBACK_LIMIT_GB:
        raise SystemExit(
            f"外置备份目录不可用（{external} 未挂载），且内置盘可用空间不足 "
            f"{INTERNAL_FALLBACK_LIMIT_GB} GB；请挂载外置卷或用 --backup-dir 指定路径。"
        )
    fallback = data_dir() / "backups"
    fallback.mkdir(parents=True, exist_ok=True)
    return fallback


def prune(directory: pathlib.Path, keep_latest: int, keep_days: int) -> tuple[list[str], int]:
    """只清理本次流程自己产生的快照；其它子目录（如浏览器缓存备份）一律不动。"""
    snapshots = sorted(
        (path for path in directory.glob("before-*.sqlite") if path.is_file()),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    removed: list[str] = []
    freed = 0
    cutoff = datetime.datetime.now().timestamp() - keep_days * 86400
    for index, snapshot in enumerate(snapshots):
        if index < keep_latest or snapshot.stat().st_mtime >= cutoff:
            continue
        freed += snapshot.stat().st_size
        snapshot.unlink()
        removed.append(snapshot.name)
    return removed, freed


def has_timestamp(name: str) -> bool:
    """文件名已带时间戳时不再追加，避免出现 before-x-20261013-191059-20261013-221600。"""
    return bool(re.search(r"\d{8}-\d{6}$", name))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name", help="快照文件名（不含 .sqlite），如 before-<功能>")
    parser.add_argument("--backup-dir", help=f"备份目录，默认 {DEFAULT_BACKUP_DIR}")
    parser.add_argument("--keep-latest", type=int, default=KEEP_LATEST)
    parser.add_argument("--keep-days", type=int, default=KEEP_DAYS)
    parser.add_argument("--prune-only", action="store_true", help="只按保留策略回收，不新建快照")
    args = parser.parse_args()

    if not args.prune_only and not args.name:
        parser.error("需要 --name，或使用 --prune-only")

    directory = resolve_backup_dir(args.backup_dir)
    database = data_dir() / "information.sqlite"
    result: dict[str, object] = {"backupDir": str(directory)}

    if args.prune_only:
        if not directory.is_dir():
            raise SystemExit(f"备份目录不存在：{directory}")
    else:
        if not database.is_file():
            raise SystemExit(f"找不到业务库：{database}")
        name = args.name if has_timestamp(args.name) else (
            f"{args.name}-{datetime.datetime.now().strftime('%Y%m%d-%H%M%S')}"
        )
        target = directory / f"{name}.sqlite"
        create_snapshot(database, target)
        result["snapshot"] = target.name
        result["size"] = human(target.stat().st_size)

    removed, freed = prune(directory, args.keep_latest, args.keep_days)
    result["pruned"] = removed
    result["prunedSize"] = human(freed)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()