#!/usr/bin/env python3
"""把本机后台、主站和信息页作为同一个发布单元构建与校验。"""

import argparse
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
import pathlib
import subprocess


ROOT = pathlib.Path(__file__).resolve().parents[3]
MANIFEST = pathlib.Path("apps/information-service/dist/local-release.json")
INPUTS = (
    "apps/desktop", "apps/information-service", "packages", "locales",
    "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json",
    "turbo.json", ".npmrc", "patches", "scripts", "tsconfig*.json",
)
BUILD_COMMANDS = (
    ("pnpm", "--filter", "@follow/information-service", "build"),
    ("pnpm", "--filter", "@follow/information-service", "build:web"),
    ("pnpm", "--filter", "Folo", "build:web"),
)


class ReleaseError(RuntimeError):
    pass


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


@contextlib.contextmanager
def release_lock(root):
    # 锁放在统一输出目录，不能被 tsup 清空 dist 时一并删除。
    lock = root / "out/local-release.lock"
    lock.parent.mkdir(parents=True, exist_ok=True)
    with lock.open("a") as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        yield


def source_fingerprint(root):
    # 摘要包含未提交和新建的源码；只看 Git 提交号会漏掉日常本地开发。
    names = subprocess.check_output(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", *INPUTS],
        cwd=root,
    ).decode().split("\0")
    selected = {
        name for name in names if name
        and not name.endswith((".md", ".test.ts", ".test.tsx", ".test.py", ".pyc"))
        and "__pycache__" not in pathlib.Path(name).parts
        and not pathlib.Path(name).name.startswith("test_")
        and name != "apps/desktop/layer/renderer/src/generated-routes.ts"
    }
    # Vite 的本机环境文件通常被 Git 忽略，仍然会改变构建结果，只记录其摘要。
    selected.update(str(path.relative_to(root)) for base in (
                        root, root / "apps/desktop", root / "apps/desktop/layer/renderer")
                    for path in base.glob(".env*") if path.is_file())
    rows = [(name, digest(root / name) if (root / name).is_file() else None)
            for name in sorted(selected)]
    return hashlib.sha256(json.dumps(rows, separators=(",", ":")).encode()).hexdigest()


def artifact_paths(root):
    service = root / "apps/information-service/dist/index.js"
    if not service.is_file():
        raise ReleaseError("缺少后台构建，请运行 build:local。")
    files = {"index.mjs": service}
    # 主站不再是可选项，缺任何一份产物都不能安装。
    for name, directory in (("web", "information-web"), ("main-web", "web")):
        source = root / "apps/desktop/out" / directory
        if not (source / "index.html").is_file():
            raise ReleaseError(f"缺少 {name} 构建，请运行 build:local。")
        files.update({f"{name}/{path.relative_to(source).as_posix()}": path
                      for path in source.rglob("*") if path.is_file()})
    return files


def artifact_hashes(root):
    return {name: digest(path) for name, path in sorted(artifact_paths(root).items())}


def seal_release(root, source):
    if source_fingerprint(root) != source:
        raise ReleaseError("构建期间源码发生变化，未生成发布清单；请重新运行 build:local。")
    manifest = {
        "formatVersion": 1, "releaseId": source,
        "builtAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "files": artifact_hashes(root),
    }
    (root / MANIFEST).write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    return manifest


def validate_release(root):
    try:
        manifest = json.loads((root / MANIFEST).read_text())
    except (OSError, ValueError) as error:
        raise ReleaseError("没有完整发布清单，请运行 pnpm --filter @follow/information-service build:local。") from error
    if manifest.get("formatVersion") != 1 or manifest.get("releaseId") != source_fingerprint(root):
        raise ReleaseError("源码已改变，现有构建已过期；请重新运行 build:local。")
    if manifest.get("files") != artifact_hashes(root):
        raise ReleaseError("三份产物与发布清单不一致，可能存在单独重建或文件修改；请重新运行 build:local。")
    return manifest


def validate_runtime(runtime, manifest):
    # 安装前再核对已复制的文件，不能仅凭来源目录通过检查就认定部署正确。
    for name, expected in manifest["files"].items():
        path = runtime / name
        if not path.is_file() or digest(path) != expected:
            raise ReleaseError(f"安装文件校验失败：{name}")


def build_release(root):
    # 任意准备阶段失败也不能留下上次的清单，让旧构建被误认为这次发布。
    (root / MANIFEST).unlink(missing_ok=True)
    source = source_fingerprint(root)
    environment = {**os.environ, "VITE_FOLO_LOCAL_RELEASE_ID": source}
    for command in BUILD_COMMANDS:
        subprocess.run(command, cwd=root, env=environment, check=True)
    return seal_release(root, source)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("build", "deploy", "check"))
    args = parser.parse_args()
    try:
        with release_lock(ROOT):
            manifest = validate_release(ROOT) if args.action == "check" else build_release(ROOT)
        print(f"三份产物一致：{manifest['releaseId'][:16]}", flush=True)
        if args.action == "deploy":
            subprocess.run(["python3", str(pathlib.Path(__file__).with_name("install-launch-agent.py"))],
                           cwd=ROOT, check=True)
    except (ReleaseError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error)) from error


if __name__ == "__main__":
    main()
