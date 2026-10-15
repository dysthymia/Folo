"""发布只切换网页服务，运行中的规则执行器与旧代码必须完整保留。"""
from contextlib import closing
import hashlib
import importlib.util
import pathlib
import plistlib
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import MagicMock, patch

from local_release import ReleaseError

spec = importlib.util.spec_from_file_location("installer", pathlib.Path(__file__).with_name("install-launch-agent.py"))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallReleaseTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.home = self.root / "home"
        self.package = self.root / "repo/apps/information-service"
        self.support = self.home / "Library/Application Support/FoloLocal"
        self.runtime = self.support / "information-runtime"
        self.agents = self.home / "Library/LaunchAgents"
        self.agents.mkdir(parents=True)
        self.database = self.home / ".local/share/folo-information-p0/information.sqlite"
        self.database.parent.mkdir(parents=True)
        with closing(sqlite3.connect(self.database)) as db, db:
            for table in ("jobs", "processing_inputs", "processing_schedule_triggers"):
                db.execute(f"CREATE TABLE {table}(status TEXT)")
            db.execute("CREATE TABLE research_records(body TEXT)")
        self.worker_registered = False
        self.calls = []
        self.manifest = self.prepare_release("new-release")
        self.opener = MagicMock()
        self.opener.open.return_value.__enter__.return_value.status = 200
        self.opener.open.return_value.__enter__.return_value.headers = {"X-Folo-Local-Release": self.manifest["releaseId"]}
        patches = [
            patch.dict(installer.os.environ, {}, clear=True),
            patch.object(installer.shutil, "which", return_value="/usr/local/bin/node"),
            patch.object(installer.subprocess, "run", side_effect=self.command),
            patch.object(installer, "validate_release", side_effect=lambda root: self.manifest),
            patch.object(installer.urllib.request, "build_opener", return_value=self.opener),
        ]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)

    def prepare_release(self, release_id):
        files = {}
        for name, source in (
            ("index.mjs", self.package / "dist/index.js"),
            ("web/index.html", self.package.parent / "desktop/out/information-web/index.html"),
            ("main-web/index.html", self.package.parent / "desktop/out/web/index.html"),
        ):
            source.parent.mkdir(parents=True, exist_ok=True)
            source.write_text(release_id + name)
            files[name] = hashlib.sha256(source.read_bytes()).hexdigest()
        return {"releaseId": release_id, "files": files}

    def command(self, args, **kwargs):
        self.calls.append(args)
        if args[:2] == ["launchctl", "print"]:
            present = self.worker_registered if args[-1].endswith(installer.WORKER_LABEL) else True
            return subprocess.CompletedProcess(args, 0 if present else 1, stdout="", stderr="")
        return subprocess.CompletedProcess(args, 0, stdout="", stderr="")

    def running(self):
        with closing(sqlite3.connect(self.database)) as db, db:
            for table in ("jobs", "processing_inputs", "processing_schedule_triggers"):
                db.execute(f"INSERT INTO {table} VALUES('running')")

    def split(self):
        self.worker_registered = True
        (self.agents / (installer.WEB_LABEL + ".plist")).write_bytes(plistlib.dumps({
            "EnvironmentVariables": {"FOLO_INFORMATION_PROCESS_ROLE": "web"},
        }))
        old = self.support / "information-releases/old"
        old.mkdir(parents=True)
        (old / "index.mjs").write_text("active-worker-code")
        self.runtime.symlink_to(old, target_is_directory=True)
        return old

    def test_active_worker_survives_repeated_deployments(self):
        old = self.split()
        self.running()
        for release_id in ("new-release", "next-release"):
            self.manifest = self.prepare_release(release_id)
            self.opener.open.return_value.__enter__.return_value.headers = {"X-Folo-Local-Release": release_id}
            installer.install(self.manifest, self.package, self.home)
            self.assertEqual((old / "index.mjs").read_text(), "active-worker-code")
            self.assertEqual((self.runtime / "index.mjs").read_text(), release_id + "index.mjs")
        # 任何部署调用都不能停止、重新注册或重写执行器的 LaunchAgent。
        worker_changes = [call for call in self.calls if call[0] == "launchctl" and call[1] != "print" and installer.WORKER_LABEL in " ".join(call)]
        self.assertEqual(worker_changes, [])
        self.assertFalse((self.agents / (installer.WORKER_LABEL + ".plist")).exists())
        with closing(sqlite3.connect(self.database)) as db, db:
            self.assertEqual(db.execute("SELECT status FROM processing_inputs").fetchone()[0], "running")

    def test_first_migration_preserves_a_busy_monolithic_service(self):
        self.running()
        with self.assertRaisesRegex(SystemExit, "首次拆分"):
            installer.install(self.manifest, self.package, self.home)
        self.assertFalse(self.runtime.exists())
        self.assertFalse(any(call[:2] == ["launchctl", "bootout"] for call in self.calls))

    def test_manual_research_still_protects_its_web_process(self):
        old = self.split()
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute('INSERT INTO research_records VALUES(\'{"target":{"kind":"selection"},"status":"running"}\')')
        with self.assertRaisesRegex(SystemExit, "选材研究"):
            installer.install(self.manifest, self.package, self.home)
        self.assertEqual(self.runtime.resolve(), old.resolve())

    def test_idle_migration_creates_two_independent_agents(self):
        self.runtime.mkdir(parents=True)
        (self.runtime / "index.mjs").write_text("legacy-code")
        installer.install(self.manifest, self.package, self.home)
        self.assertTrue(self.runtime.is_symlink())
        self.assertEqual((self.support / "information-runtime-previous/index.mjs").read_text(), "legacy-code")
        for label, role in ((installer.WEB_LABEL, "web"), (installer.WORKER_LABEL, "worker")):
            config = plistlib.loads((self.agents / (label + ".plist")).read_bytes())
            self.assertEqual(config["EnvironmentVariables"]["FOLO_INFORMATION_PROCESS_ROLE"], role)
        self.assertIn('export FOLO_INFORMATION_WORKER_RUNTIME="$PWD"', (self.support / "run-information-worker.sh").read_text())
        self.assertIn("serve-web", (self.support / "run-information.sh").read_text())

    def test_corrupted_artifacts_do_not_stop_web_or_switch_runtime(self):
        old = self.split()
        (self.package / "dist/index.js").write_text("corrupt")
        with self.assertRaises(ReleaseError):
            installer.install(self.manifest, self.package, self.home)
        self.assertEqual(self.runtime.resolve(), old.resolve())
        self.assertFalse(any(call[:2] == ["launchctl", "bootout"] for call in self.calls))

    def test_legacy_task_started_before_handoff_resumes_without_termination(self):
        state = subprocess.CompletedProcess([], 0, stdout="pid = 888\n", stderr="")
        with patch.object(installer, "registered", return_value=state), \
             patch.object(installer.os, "kill") as kill, \
             patch.object(installer, "check_running", side_effect=SystemExit("首次拆分需等待")):
            with self.assertRaisesRegex(SystemExit, "首次拆分"):
                installer.stop_web("gui/501", self.database, False)
            self.assertEqual([call.args for call in kill.call_args_list], [
                (888, installer.signal.SIGSTOP), (888, installer.signal.SIGCONT),
            ])
        self.assertFalse(any(call[:2] == ["launchctl", "bootout"] for call in self.calls))

    def test_idle_legacy_handoff_cannot_claim_more_work(self):
        state = subprocess.CompletedProcess([], 0, stdout="pid = 888\n", stderr="")
        signals = []
        def kill(pid, value):
            if value == 0:
                raise ProcessLookupError()
            signals.append(value)
        with patch.object(installer, "registered", return_value=state), \
             patch.object(installer.os, "kill", side_effect=kill), \
             patch.object(installer, "check_running") as check:
            installer.stop_web("gui/501", self.database, False)
            check.assert_called_once_with(self.database, False)
        self.assertEqual(signals, [installer.signal.SIGSTOP, installer.signal.SIGKILL])
        self.assertEqual([call for call in self.calls if call[:2] == ["launchctl", "bootout"]], [
            ["launchctl", "bootout", "gui/501/" + installer.WEB_LABEL],
        ])

    def checkpoint_database(self, phase="entries", active_input=False):
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("ALTER TABLE processing_schedule_triggers ADD COLUMN id TEXT")
            db.execute("ALTER TABLE processing_schedule_triggers ADD COLUMN lease_token TEXT")
            db.execute("ALTER TABLE processing_schedule_triggers ADD COLUMN lease_until TEXT")
            db.execute("CREATE TABLE processing_trigger_reports(trigger_id TEXT, body TEXT)")
            db.execute("INSERT INTO processing_schedule_triggers VALUES('running','original','lease','future')")
            db.execute("INSERT INTO processing_trigger_reports VALUES('original',?)", (installer.json.dumps({"phase": phase}),))
            db.execute("INSERT INTO processing_inputs VALUES(?)", ("running" if active_input else "succeeded",))

    def test_checkpoint_rejects_active_model_and_untracked_paid_stages(self):
        self.checkpoint_database(active_input=True)
        with self.assertRaisesRegex(SystemExit, "首次拆分"):
            installer.check_running(self.database, False, True)
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("UPDATE processing_inputs SET status='succeeded'")
            db.execute("UPDATE processing_trigger_reports SET body=?", (installer.json.dumps({"phase": "dedupe"}),))
        with self.assertRaisesRegex(SystemExit, "检查点"):
            installer.check_running(self.database, False, True)

    def test_checkpoint_handoff_requeues_only_after_old_process_exits(self):
        self.checkpoint_database()
        state = subprocess.CompletedProcess([], 0, stdout="pid = 888\n", stderr="")
        signals = []
        def kill(pid, value):
            if value == 0:
                with closing(sqlite3.connect(self.database)) as db:
                    self.assertEqual(db.execute("SELECT status FROM processing_schedule_triggers").fetchone()[0], "running")
                raise ProcessLookupError()
            signals.append(value)
        with patch.object(installer, "registered", return_value=state), patch.object(installer.os, "kill", side_effect=kill):
            installer.stop_web("gui/501", self.database, False, True)
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(db.execute("SELECT status,lease_token FROM processing_schedule_triggers").fetchone(), ("pending", None))
            self.assertEqual(db.execute("SELECT status FROM processing_inputs").fetchone()[0], "succeeded")
        self.assertEqual(signals, [installer.signal.SIGSTOP, installer.signal.SIGKILL])

    def test_checkpoint_resumes_parent_when_model_child_still_exists(self):
        self.checkpoint_database()
        state = subprocess.CompletedProcess([], 0, stdout="pid = 888\n", stderr="")
        original = self.command
        def command(args, **kwargs):
            if args[0] == "ps":
                return subprocess.CompletedProcess(args, 0, stdout="999 888\n", stderr="")
            return original(args, **kwargs)
        with patch.object(installer, "registered", return_value=state), patch.object(installer.os, "kill") as kill, patch.object(installer.subprocess, "run", side_effect=command):
            with self.assertRaisesRegex(SystemExit, "子进程"):
                installer.stop_web("gui/501", self.database, False, True)
            self.assertEqual([call.args for call in kill.call_args_list], [(888, installer.signal.SIGSTOP), (888, installer.signal.SIGCONT)])
        self.assertFalse(any(call[:2] == ["launchctl", "bootout"] for call in self.calls))


if __name__ == "__main__":
    unittest.main()
