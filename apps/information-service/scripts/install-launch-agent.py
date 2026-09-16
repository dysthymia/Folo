#!/usr/bin/env python3
"""安装本机信息后台；凭据仍由服务按次读取，不写入 LaunchAgent。"""
import os
import pathlib
import plistlib
import re
import shlex
import shutil
import sqlite3
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

package = pathlib.Path(__file__).resolve().parents[1]
node = shutil.which("node")
if not node or not (package / "dist/index.js").is_file():
    raise SystemExit("请先安装 Node 并构建 information-service。")
if not (package.parent / "desktop/out/information-web/index.html").is_file():
    raise SystemExit("请先运行 information-service 的 build:web。")

home = pathlib.Path.home()
# 不在模型或扫描运行中切换构建，避免中断已计费调用或正在提交的页面。
database = pathlib.Path(os.environ.get("FOLO_INFORMATION_DATA_DIR", str(home / ".local/share/folo-information-p0"))) / "information.sqlite"
if database.exists():
    with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as connection:
        if connection.execute("SELECT COUNT(*) FROM jobs WHERE status='running'").fetchone()[0]:
            raise SystemExit("有任务正在运行，请等待完成后再安装。")
        # 新自动化队列同样禁止在模型调用中途切换部署。
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        for table in ("processing_inputs", "processing_schedule_triggers"):
            if table in tables and connection.execute(f"SELECT COUNT(*) FROM {table} WHERE status='running'").fetchone()[0]:
                raise SystemExit("有信息处理任务正在运行，请等待完成后再安装。")
support = home / "Library/Application Support/FoloLocal"
logs = home / "Library/Logs/FoloInformation"
for directory in (support, logs, home / "Library/LaunchAgents"):
    directory.mkdir(parents=True, exist_ok=True)
logs.chmod(0o700)
wrapper = support / "run-information.sh"
# 常驻进程只读内置磁盘上的部署产物，不依赖外置卷挂载与开发目录权限。
runtime = support / "information-runtime"
staging = pathlib.Path(tempfile.mkdtemp(prefix="information-stage-", dir=support))
shutil.copy2(package / "dist/index.js", staging / "index.mjs")
shutil.copytree(package.parent / "desktop/out/information-web", staging / "web")
main_web = package.parent / "desktop/out/web"
if (main_web / "index.html").is_file():
    # 主站也从已构建产物运行，关闭开发服务器不影响 Actions 和聊天。
    shutil.copytree(main_web, staging / "main-web")
wrapper.write_text("\n".join([
    "#!/bin/zsh", "set -eu",
    "# 运行已安装的独立构建，保留用户数据目录中的任务与授权。",
    f"cd {shlex.quote(str(runtime))}",
    f"exec {shlex.quote(node)} --use-env-proxy index.mjs serve", "",
]))
wrapper.chmod(0o700)
environment = {"PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"}
# 只继承已有网络代理和运行路径；不复制 Token、API key 或其他认证环境。
for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "CODEX_HOME", "FOLO_INFORMATION_DATA_DIR", "FOLO_INFORMATION_PORT", "FOLO_INFORMATION_PUBLIC_ORIGIN"):
    if os.environ.get(key):
        environment[key] = os.environ[key]
environment["NO_PROXY"] = ",".join(filter(None, [environment.get("NO_PROXY"), "127.0.0.1", "localhost", "local.folo.is"]))
environment["FOLO_INFORMATION_WEB_ROOT"] = str(runtime / "web")
if (staging / "main-web/index.html").is_file():
    environment["FOLO_INFORMATION_MAIN_WEB_ROOT"] = str(runtime / "main-web")
label = "is.folo.local.information"
plist = home / "Library/LaunchAgents" / (label + ".plist")
config = {
    "Label": label, "ProgramArguments": ["/bin/zsh", str(wrapper)],
    "WorkingDirectory": str(support), "EnvironmentVariables": environment,
    "RunAtLoad": True, "KeepAlive": True, "ThrottleInterval": 15,
    "ExitTimeOut": 30,
    "StandardOutPath": str(logs / "service.log"),
    "StandardErrorPath": str(logs / "service.error.log"),
}
for key in ("StandardOutPath", "StandardErrorPath"):
    pathlib.Path(config[key]).touch(mode=0o600, exist_ok=True)
    pathlib.Path(config[key]).chmod(0o600)
plist.write_bytes(plistlib.dumps(config))
plist.chmod(0o600)
subprocess.run(["/usr/bin/plutil", "-lint", str(plist)], check=True, capture_output=True)
subprocess.run(["/bin/zsh", "-n", str(wrapper)], check=True)
domain = f"gui/{os.getuid()}"
# 仅替换本服务自身的注册，不重启主站、Docker 或其他 LaunchAgent。
registered = subprocess.run(["launchctl", "print", f"{domain}/{label}"], capture_output=True, text=True)
if registered.returncode == 0:
    previous_pid = re.search(r"^\s*pid = (\d+)$", registered.stdout, re.MULTILINE)
    subprocess.run(["launchctl", "bootout", f"{domain}/{label}"], check=True)
    # bootout 返回时旧进程可能还在释放资源，等待退出后才能重新注册同名服务。
    if previous_pid:
        deadline = time.monotonic() + 30
        while True:
            try:
                os.kill(int(previous_pid.group(1)), 0)
            except ProcessLookupError:
                break
            if time.monotonic() >= deadline:
                raise SystemExit("旧服务尚未退出，已保留部署文件，请检查日志。")
            time.sleep(0.2)
# 新产物先准备完整，停服务后再切换；旧版本保留一份以便回滚。
previous = support / "information-runtime-previous"
if runtime.exists():
    if previous.exists():
        shutil.rmtree(previous)
    runtime.rename(previous)
staging.rename(runtime)
subprocess.run(["launchctl", "bootstrap", domain, str(plist)], check=True)
# launchctl 注册是异步的，实际页面可读后才报告安装成功。
ready_url = f"http://127.0.0.1:{environment.get('FOLO_INFORMATION_PORT', '2240')}/information"
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
deadline = time.monotonic() + 30
while True:
    try:
        with opener.open(ready_url, timeout=2) as response:
            if response.status == 200:
                break
    except (urllib.error.URLError, TimeoutError):
        pass
    if time.monotonic() >= deadline:
        raise SystemExit("服务已注册但页面尚未就绪，请检查服务日志。")
    time.sleep(0.2)
print(f"已安装 {label}；日志目录：{logs}")
