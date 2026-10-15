"""验证旧产物、局部构建和构建期间源码变化都不能混入本机发布。"""

import pathlib
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from local_release import (
    MANIFEST, ReleaseError, build_release, seal_release, source_fingerprint,
    validate_release, validate_runtime,
)


class LocalReleaseTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        self.write(".gitignore", "out/\napps/desktop/out/\napps/information-service/dist/\n.env*\n")
        self.write("package.json", "{}")
        self.write("packages/internal/information-core/src/attention.ts", "old-schema")
        self.write("apps/information-service/dist/index.js", "backend")
        self.write("apps/desktop/out/web/index.html", "main")
        self.write("apps/desktop/out/web/assets/main.js", "main-code")
        self.write("apps/desktop/out/information-web/index.html", "information")
        self.write("apps/desktop/out/information-web/assets/app.js", "information-code")

    def write(self, name, content):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        return path

    def seal(self):
        return seal_release(self.root, source_fingerprint(self.root))

    def test_complete_release_and_staged_files_match(self):
        manifest = self.seal()
        self.assertEqual(validate_release(self.root), manifest)
        staged = self.root / "out/staged"
        self.write("out/staged/index.mjs", "backend")
        shutil.copytree(self.root / "apps/desktop/out/web", staged / "main-web")
        shutil.copytree(self.root / "apps/desktop/out/information-web", staged / "web")
        validate_runtime(staged, manifest)
        (staged / "main-web/assets/main.js").write_text("old-frontend")
        with self.assertRaisesRegex(ReleaseError, "安装文件校验失败"):
            validate_runtime(staged, manifest)

    def test_installer_requires_a_manifest_and_all_three_artifacts(self):
        with self.assertRaisesRegex(ReleaseError, "没有完整发布清单"):
            validate_release(self.root)
        self.seal()
        (self.root / "apps/desktop/out/web/index.html").unlink()
        with self.assertRaisesRegex(ReleaseError, "缺少 main-web"):
            validate_release(self.root)

    def test_schema_changes_require_a_complete_rebuild(self):
        self.seal()
        self.write("packages/internal/information-core/src/attention.ts", "schema-with-interests")
        with self.assertRaisesRegex(ReleaseError, "源码已改变"):
            validate_release(self.root)

    def test_local_environment_and_new_source_files_invalidate_release(self):
        for name in ("apps/desktop/.env.local", "apps/desktop/new-module.ts"):
            with self.subTest(name=name):
                self.seal()
                self.write(name, "new-build-input")
                with self.assertRaisesRegex(ReleaseError, "源码已改变"):
                    validate_release(self.root)

    def test_partial_rebuild_or_modified_chunk_is_rejected(self):
        for name in ("apps/information-service/dist/index.js", "apps/desktop/out/web/assets/main.js",
                     "apps/desktop/out/information-web/assets/app.js"):
            with self.subTest(name=name):
                self.seal()
                (self.root / name).write_text("individually-rebuilt")
                with self.assertRaisesRegex(ReleaseError, "三份产物与发布清单不一致"):
                    validate_release(self.root)

    def test_failed_build_cannot_reuse_previous_manifest(self):
        self.seal()
        with patch("local_release.subprocess.run", side_effect=subprocess.CalledProcessError(1, "pnpm")):
            with self.assertRaises(subprocess.CalledProcessError):
                build_release(self.root)
        self.assertFalse((self.root / MANIFEST).exists())

    def test_edit_during_build_does_not_seal_mixed_outputs(self):
        source = source_fingerprint(self.root)
        self.write("packages/internal/information-core/src/attention.ts", "changed-during-build")
        with self.assertRaisesRegex(ReleaseError, "构建期间源码发生变化"):
            seal_release(self.root, source)
        self.assertFalse((self.root / MANIFEST).exists())


if __name__ == "__main__":
    unittest.main()
