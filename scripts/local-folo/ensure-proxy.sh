#!/bin/zsh

set -euo pipefail

readonly repo_dir="/Volumes/SSD/Dev/Code/Folo"
readonly base_compose_file="/Volumes/SSD/Dev/Code/docker/docker-compose.yml"
readonly override_compose_file="${repo_dir}/scripts/local-folo/docker-compose.override.yml"
readonly expected_config_mount="/etc/httpd/conf.d/local-folo.conf"
readonly expected_config_mapping="${repo_dir}/output/local-folo.conf->${expected_config_mount}"
readonly docker_info_timeout_seconds=15
readonly docker_open_file_restart_threshold=50000
readonly docker_services_pattern='^/Applications/Docker\.app/Contents/MacOS/com\.docker\.backend services$'
readonly docker_highfd_plist="/Users/yangtao/Library/LaunchAgents/com.local.docker.highfd.plist"
readonly direct_health_url="http://127.0.0.1:2240/"
readonly proxy_health_url="http://local.folo.is/"

docker_is_ready() {
  local info_pid
  local watchdog_pid
  local info_status

  "${docker_bin}" info >/dev/null 2>&1 &
  info_pid=$!

  # macOS 没有内置 timeout；用独立看门狗终止卡住的 Docker 探测。
  (
    sleep "${docker_info_timeout_seconds}"
    kill -TERM "${info_pid}" 2>/dev/null || true
  ) &
  watchdog_pid=$!

  if wait "${info_pid}"; then
    info_status=0
  else
    info_status=$?
  fi

  kill -TERM "${watchdog_pid}" 2>/dev/null || true
  wait "${watchdog_pid}" 2>/dev/null || true
  return "${info_status}"
}

docker_services_open_file_count() {
  local services_pid
  local open_file_count

  services_pid="$(pgrep -f "${docker_services_pattern}" | head -n 1 || true)"
  open_file_count=0
  if [[ -n "${services_pid}" ]]; then
    open_file_count="$(lsof -p "${services_pid}" 2>/dev/null | wc -l | tr -d '[:space:]')"
  fi

  print -r -- "${open_file_count}"
}

restart_docker_backend_for_fd_leak() {
  local open_file_count
  local highfd_service

  # CLOSED 连接泄漏接近上限时，普通 open 无法修复，需重启受 launchd 保活的 Docker 后端。
  open_file_count="$(docker_services_open_file_count)"
  highfd_service="gui/$(id -u)/com.local.docker.highfd"
  if [[ "${open_file_count}" != <-> ]] || (( open_file_count < docker_open_file_restart_threshold )); then
    return 1
  fi

  # 登录后服务可能尚未载入；先补做 bootstrap，避免高描述符保护静默失效。
  if ! launchctl print "${highfd_service}" >/dev/null 2>&1; then
    [[ -f "${docker_highfd_plist}" ]] || return 1
    launchctl bootstrap "gui/$(id -u)" "${docker_highfd_plist}" >/dev/null 2>&1 || true
    launchctl print "${highfd_service}" >/dev/null 2>&1 || return 1
  fi

  if launchctl print "${highfd_service}" >/dev/null 2>&1; then
    print -r -- "Restarting Docker backend after open files reached ${open_file_count}."
    launchctl kickstart -k "${highfd_service}"
    return 0
  fi

  return 1
}

recover_docker() {
  if restart_docker_backend_for_fd_leak; then
    return
  fi
  /usr/bin/open -gja Docker >/dev/null 2>&1 || true
}

# Docker Desktop 可能晚于登录项启动；探测超时后主动唤醒，并让定时任务下一轮继续尝试。
docker_bin="$(command -v docker || true)"
if [[ -z "${docker_bin}" ]]; then
  exit 0
fi

if ! docker_is_ready; then
  recover_docker

  # 重启或唤醒后立即再试一次，避免正常恢复还要额外等待 600 秒。
  if ! docker_is_ready; then
    exit 0
  fi
fi

# 即使代理暂时还能响应，也在描述符达到阈值时提前恢复，避免所有 Docker 本地域名一起中断。
if restart_docker_backend_for_fd_leak; then
  if ! docker_is_ready; then
    exit 0
  fi
fi

container_status="$("${docker_bin}" inspect -f '{{.State.Status}}' jitashe-web 2>/dev/null || true)"
container_mounts="$("${docker_bin}" inspect -f '{{range .Mounts}}{{println .Source "->" .Destination}}{{end}}' jitashe-web 2>/dev/null || true)"

# 容器或持久挂载缺失时先恢复基础代理层。
if [[ "${container_status}" != "running" ]] || ! grep -Fqx "${expected_config_mapping}" <<<"${container_mounts}"; then
  "${docker_bin}" compose \
    -f "${base_compose_file}" \
    -f "${override_compose_file}" \
    up -d web
fi

# Folo 后端由独立 LaunchAgent 保活；后端未就绪时不要误重启 Docker。
if ! /usr/bin/curl -fsS --noproxy '*' -o /dev/null --max-time 8 "${direct_health_url}"; then
  exit 0
fi

# 进程和挂载都存在仍不代表端口转发健康，必须检查真实代理资源链。
if /usr/bin/curl -fsS --noproxy '*' -o /dev/null --max-time 8 "${proxy_health_url}"; then
  exit 0
fi

if restart_docker_backend_for_fd_leak; then
  # 后端重启后立即恢复容器，不额外等待下一个 600 秒周期。
  if docker_is_ready; then
    "${docker_bin}" compose \
      -f "${base_compose_file}" \
      -f "${override_compose_file}" \
      up -d web
  fi
else
  # 描述符正常时优先只重启代理容器，缩小对其他本地服务的影响。
  "${docker_bin}" restart jitashe-web >/dev/null
fi
