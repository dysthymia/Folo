#!/usr/bin/env python3
"""安装独立的网页服务与规则执行器，发布时保留正在进行的后台调用。"""
import argparse
from contextlib import closing
import hashlib
import json
import os
import pathlib
import plistlib
import re
import shlex
import shutil
import signal
import sqlite3
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

from local_release import ReleaseError, release_lock, validate_release, validate_runtime

WEB_LABEL = "is.folo.local.information"
WORKER_LABEL = WEB_LABEL + ".worker"


def registered(domain, label):
    return subprocess.run(["launchctl", "print", f"{domain}/{label}"], capture_output=True, text=True)


def checkpoint_triggers(connection):
    # 只有单篇队列有运行标志的阶段允许交接；去重/综述调用不得仅凭输入队列空闲判断。
    rows = connection.execute("SELECT t.id,r.body FROM processing_schedule_triggers t LEFT JOIN processing_trigger_reports r ON r.trigger_id=t.id WHERE t.status='running'").fetchall()
    for trigger_id, body in rows:
        if not body or json.loads(body).get("phase") not in ("sources", "material", "exact", "entries"):
            raise SystemExit("首次拆分需等待安全处理检查点；当前阶段可能有未结束的模型调用。")
    return [row[0] for row in rows]


def check_running(database, split, checkpoint=False):
    if not database.exists():
        return
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as connection:
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        # 首次从旧的单进程迁移时仍需空闲；拆分后安装不操作持锁执行器。
        if not split:
            for table in (("jobs", "processing_inputs") if checkpoint else ("jobs", "processing_inputs", "processing_schedule_triggers")):
                if table in tables and connection.execute(f"SELECT COUNT(*) FROM {table} WHERE status='running'").fetchone()[0]:
                    raise SystemExit("首次拆分服务需等待当前规则或扫描任务完成；之后更新不再中断执行器。")
            if checkpoint and "processing_schedule_triggers" in tables:
                checkpoint_triggers(connection)
        # 手工选材研究仍由网页进程执行，继续保护其正在进行的模型调用。
        if "research_records" in tables and connection.execute(
            "SELECT COUNT(*) FROM research_records WHERE json_extract(body, '$.target.kind')='selection' AND json_extract(body, '$.status')='running'"
        ).fetchone()[0]:
            raise SystemExit("有选材研究正在运行，请等待完成后再安装。")


def stop_web(domain, database, split, checkpoint=False):
    state = registered(domain, WEB_LABEL)
    if state.returncode != 0:
        if not split:
            check_running(database, False)
        return
    previous_pid = re.search(r"^\s*pid = (\d+)$", state.stdout, re.MULTILINE)
    pid = int(previous_pid.group(1)) if previous_pid else None
    handoff = []
    if not pid and not split:
        check_running(database, False)
    if pid and not split:
        # 旧版不支持协作式交接，先暂停领取任务，再核对空闲状态，消除检查与停止之间的竞争。
        os.kill(pid, signal.SIGSTOP)
        stopped = False
        try:
            if checkpoint:
                check_running(database, False, True)
                # 冻结主进程后再次核验子进程；正在运行的 Codex 调用继续完成，不能被安装回收。
                processes = subprocess.run(["ps", "-axo", "pid=,ppid="], check=True, capture_output=True, text=True)
                children = {int(parts[0]): int(parts[1]) for line in processes.stdout.splitlines() if len(parts := line.split()) == 2}
                if pid in children.values():
                    raise SystemExit("首次拆分需等待模型子进程完成，已保留旧服务。")
                with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as connection:
                    handoff = checkpoint_triggers(connection)
            else:
                check_running(database, False)
            subprocess.run(["launchctl", "bootout", f"{domain}/{WEB_LABEL}"], check=True)
            # 已确认没有运行中的调用且已取消常驻注册，终止暂停的空闲进程，不让它再领取任务。
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            stopped = True
        finally:
            if not stopped:
                try:
                    os.kill(pid, signal.SIGCONT)
                except ProcessLookupError:
                    pass
    else:
        subprocess.run(["launchctl", "bootout", f"{domain}/{WEB_LABEL}"], check=True)
    # 只停止网页进程；规则执行器从不接收部署发出的终止信号。
    if previous_pid:
        deadline = time.monotonic() + 30
        while True:
            try:
                os.kill(int(previous_pid.group(1)), 0)
            except ProcessLookupError:
                # 旧执行器确认退出后才释放原批次租约；已成功输入和模型缓存完全保留。
                if handoff:
                    with closing(sqlite3.connect(database)) as connection, connection:
                        connection.executemany("UPDATE processing_schedule_triggers SET status='pending',lease_token=NULL,lease_until=NULL WHERE id=? AND status='running'", [(trigger_id,) for trigger_id in handoff])
                return
            if time.monotonic() >= deadline:
                raise SystemExit("旧网页服务尚未退出，已保留部署文件，请检查日志。")
            time.sleep(0.2)


def replace_link(link, target):
    temporary = link.with_name(link.name + ".next")
    temporary.unlink(missing_ok=True)
    temporary.symlink_to(target, target_is_directory=True)
    temporary.replace(link)


def activate_release(support, release):
    runtime = support / "information-runtime"
    previous = support / "information-runtime-previous"
    releases = support / "information-releases"
    # 旧安装使用实体目录，首次迁移将它保留下来；以后仅原子切换符号链接。
    if runtime.exists():
        old = runtime.resolve()
        if not runtime.is_symlink():
            old = releases / f"legacy-{time.time_ns()}"
            runtime.rename(old)
        if previous.exists() and not previous.is_symlink():
            previous.rename(releases / f"legacy-{time.time_ns()}")
        replace_link(previous, old)
    replace_link(runtime, release)
    return runtime


def prepare_agent(home, support, logs, node, environment, worker):
    label = WORKER_LABEL if worker else WEB_LABEL
    wrapper = support / ("run-information-worker.sh" if worker else "run-information.sh")
    # 每次启动解析当前发布到实体目录，已运行的执行器始终使用自己的完整旧版本。
    pending_wrapper = wrapper.with_suffix(".sh.next")
    pending_wrapper.write_text("\n".join([
        "#!/bin/zsh", "set -eu",
        "# 发布指针变化不会改写已运行进程的代码或中断当前模型调用。",
        f"cd -P {shlex.quote(str(support / 'information-runtime'))}",
        *(['export FOLO_INFORMATION_WORKER_RUNTIME="$PWD"'] if worker else []),
        f"exec {shlex.quote(node)} --use-env-proxy index.mjs {'worker' if worker else 'serve-web'}", "",
    ]))
    pending_wrapper.chmod(0o700)
    config = {
        "Label": label, "ProgramArguments": ["/bin/zsh", str(wrapper)],
        "WorkingDirectory": str(support), "EnvironmentVariables": environment,
        "RunAtLoad": True, "KeepAlive": True, "ThrottleInterval": 1,
        "ExitTimeOut": 30,
        "StandardOutPath": str(logs / ("worker.log" if worker else "service.log")),
        "StandardErrorPath": str(logs / ("worker.error.log" if worker else "service.error.log")),
    }
    for key in ("StandardOutPath", "StandardErrorPath"):
        pathlib.Path(config[key]).touch(mode=0o600, exist_ok=True)
        pathlib.Path(config[key]).chmod(0o600)
    plist = home / "Library/LaunchAgents" / (label + ".plist")
    temporary = plist.with_suffix(".next")
    temporary.write_bytes(plistlib.dumps(config))
    temporary.chmod(0o600)
    subprocess.run(["/usr/bin/plutil", "-lint", str(temporary)], check=True, capture_output=True)
    subprocess.run(["/bin/zsh", "-n", str(pending_wrapper)], check=True)
    # 准备阶段不改写旧进程的启动配置，安全交接失败时旧服务仍能按原方式重启。
    return plist, ((pending_wrapper, wrapper), (temporary, plist))


def install(manifest, package=None, home=None, checkpoint=False):
    package = package or pathlib.Path(__file__).resolve().parents[1]
    home = home or pathlib.Path.home()
    node = shutil.which("node")
    if not node:
        raise SystemExit("请先安装 Node。")
    support = home / "Library/Application Support/FoloLocal"
    logs = home / "Library/Logs/FoloInformation"
    domain = f"gui/{os.getuid()}"
    web_plist = home / "Library/LaunchAgents" / (WEB_LABEL + ".plist")
    existing = plistlib.loads(web_plist.read_bytes()) if web_plist.exists() else {}
    worker_registered = registered(domain, WORKER_LABEL).returncode == 0
    worker_plist_path = home / "Library/LaunchAgents" / (WORKER_LABEL + ".plist")
    worker_existing = plistlib.loads(worker_plist_path.read_bytes()) if worker_plist_path.exists() else {}
    # 已安装的拆分服务即使暂时停止注册，也不是首次从单进程迁移；仍保护网页中的选材调用。
    worker_installed = worker_existing.get("EnvironmentVariables", {}).get("FOLO_INFORMATION_PROCESS_ROLE") == "worker"
    split = existing.get("EnvironmentVariables", {}).get("FOLO_INFORMATION_PROCESS_ROLE") == "web" and (worker_registered or worker_installed)
    database = pathlib.Path(os.environ.get("FOLO_INFORMATION_DATA_DIR", str(home / ".local/share/folo-information-p0"))) / "information.sqlite"
    # 首次检查点交接先准备产物，冻结后的复核才决定能否停止；准备耗时不能错过空闲窗口。
    if not checkpoint or split:
        check_running(database, split)
    for directory in (support, logs, home / "Library/LaunchAgents", support / "information-releases"):
        directory.mkdir(parents=True, exist_ok=True)
    logs.chmod(0o700)
    staging = pathlib.Path(tempfile.mkdtemp(prefix="information-stage-", dir=support))
    try:
        shutil.copy2(package / "dist/index.js", staging / "index.mjs")
        shutil.copytree(package.parent / "desktop/out/information-web", staging / "web")
        shutil.copytree(package.parent / "desktop/out/web", staging / "main-web")
        validate_runtime(staging, manifest)
        (staging / "local-release.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
        # 再次验证源码、完整产物和迁移条件，均通过后才操作现有网页服务。
        validate_release(package.parents[1])
        validate_runtime(staging, manifest)
        if not checkpoint or split:
            check_running(database, split)
        # 构建文件摘要区分相同源码的重复构建，避免覆盖仍由旧执行器使用的目录。
        build = hashlib.sha256(json.dumps(manifest["files"], sort_keys=True).encode()).hexdigest()[:12]
        release = support / "information-releases" / (manifest["releaseId"] + "-" + build)
        if release.exists():
            validate_runtime(release, manifest)
        else:
            staging.rename(release)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    environment = {"PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"}
    # 只继承网络代理和运行路径，不复制 Token、API key 或其他认证环境。
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "CODEX_HOME", "FOLO_INFORMATION_DATA_DIR", "FOLO_INFORMATION_PORT", "FOLO_INFORMATION_PUBLIC_ORIGIN"):
        if os.environ.get(key):
            environment[key] = os.environ[key]
    environment["NO_PROXY"] = ",".join(filter(None, [environment.get("NO_PROXY"), "127.0.0.1", "localhost", "local.folo.is"]))
    runtime = support / "information-runtime"
    worker_environment = {**environment, "FOLO_INFORMATION_PROCESS_ROLE": "worker", "FOLO_INFORMATION_RUNTIME_POINTER": str(runtime)}
    web_environment = {
        **environment, "FOLO_INFORMATION_PROCESS_ROLE": "web",
        "FOLO_INFORMATION_RELEASE_ID": manifest["releaseId"],
        "FOLO_INFORMATION_WEB_ROOT": str(release / "web"),
        "FOLO_INFORMATION_MAIN_WEB_ROOT": str(release / "main-web"),
    }
    web_plist, pending = prepare_agent(home, support, logs, node, web_environment, False)
    worker_plist = None
    if not worker_registered:
        worker_plist, worker_pending = prepare_agent(home, support, logs, node, worker_environment, True)
        pending += worker_pending
    # 首次检查点交接先准备产物，冻结后的复核才决定能否停止；准备耗时不能错过空闲窗口。
    if not checkpoint or split:
        check_running(database, split)
    deadline = time.monotonic() + 300
    while True:
        try:
            stop_web(domain, database, split, checkpoint)
            break
        except SystemExit as error:
            # 每次失败都会恢复旧进程；等待期间不会重新复制产物或重启模型。
            if not checkpoint or split or not str(error).startswith(("首次拆分", "有选材研究")) or time.monotonic() >= deadline:
                raise
            time.sleep(1)
    activate_release(support, release)
    for source, target in pending:
        source.replace(target)
    subprocess.run(["launchctl", "bootstrap", domain, str(web_plist)], check=True)
    # 已注册的 worker 保持原 PID；当前批次结束后自行退出，由 KeepAlive 启动新版。
    if worker_plist:
        subprocess.run(["launchctl", "bootstrap", domain, str(worker_plist)], check=True)
    ready_url = f"http://127.0.0.1:{environment.get('FOLO_INFORMATION_PORT', '2240')}/information"
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.monotonic() + 30
    while True:
        try:
            with opener.open(ready_url, timeout=2) as response:
                if response.status == 200 and response.headers.get("X-Folo-Local-Release") == manifest["releaseId"]:
                    break
        except (urllib.error.URLError, TimeoutError):
            pass
        if time.monotonic() >= deadline:
            raise SystemExit("网页服务已注册但页面尚未就绪，请检查服务日志。")
        time.sleep(0.2)
    validate_runtime(runtime, manifest)
    print(f"已安装网页 {manifest['releaseId'][:16]}；后台代码变化时，规则执行器完成当前批次后自动切换；日志目录：{logs}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="只核对源码和三份构建，不操作服务")
    parser.add_argument("--handoff-at-checkpoint", action="store_true", help="首次拆分时仅在无运行模型的检查点保存原范围并交接")
    args = parser.parse_args()
    root = pathlib.Path(__file__).resolve().parents[3]
    try:
        with release_lock(root):
            manifest = validate_release(root)
            if args.check:
                print(f"发布校验通过：{manifest['releaseId'][:16]}")
                return
            install(manifest, checkpoint=args.handoff_at_checkpoint)
    except ReleaseError as error:
        raise SystemExit(str(error)) from error


if __name__ == "__main__":
    main()
