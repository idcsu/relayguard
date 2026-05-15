#!/usr/bin/env bash
set -euo pipefail

REPO="idcsu/relayguard"
APP="relayguard-panel"
BIN_DIR="/usr/local/bin"
DATA_DIR="/etc/relayguard"
SERVICE="relayguard-panel.service"
DEFAULT_BIND_ADDR="127.0.0.1"
DEFAULT_PORT="10026"

red(){ echo -e "\033[31m$*\033[0m"; }
green(){ echo -e "\033[32m$*\033[0m"; }
yellow(){ echo -e "\033[33m$*\033[0m"; }

read_tty(){
  local __var="$1"; shift
  local __prompt="$*"
  if [ -r /dev/tty ]; then
    IFS= read -r -p "$__prompt" "$__var" < /dev/tty
  else
    IFS= read -r -p "$__prompt" "$__var"
  fi
}

read_tty_secret(){
  local __var="$1"; shift
  local __prompt="$*"
  if [ -r /dev/tty ]; then
    IFS= read -r -s -p "$__prompt" "$__var" < /dev/tty
  else
    IFS= read -r -s -p "$__prompt" "$__var"
  fi
  echo
}

need_root(){
  [ "$(id -u)" = "0" ] || { red "请使用 root 用户运行"; exit 1; }
}

arch_name(){
  case "$(uname -m)" in
    x86_64|amd64) echo amd64;;
    *)
      red "当前面板 Release 暂只提供 linux-amd64 二进制，当前架构：$(uname -m)"
      exit 1
      ;;
  esac
}

install_deps(){
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    apt-get install -y curl ca-certificates libsqlite3-0
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y curl ca-certificates sqlite-libs
  elif command -v yum >/dev/null 2>&1; then
    yum install -y curl ca-certificates sqlite
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache curl ca-certificates sqlite-libs
  else
    command -v curl >/dev/null 2>&1 || { red "请先安装 curl"; exit 1; }
  fi
}

verify_sha256(){
  local file="$1"
  local arch
  arch=$(arch_name)
  local sum_url="https://github.com/${REPO}/releases/latest/download/SHA256SUMS"
  local sum_file="/tmp/relayguard-SHA256SUMS"
  yellow "正在下载校验文件..."
  if curl -fL "$sum_url" -o "$sum_file" 2>/dev/null; then
    local expected
    expected=$(grep "relayguard-panel-linux-${arch}" "$sum_file" | awk '{print $1}')
    if [ -n "$expected" ]; then
      local actual
      actual=$(sha256sum "$file" | awk '{print $1}')
      if [ "$actual" != "$expected" ]; then
        red "SHA256 校验失败！文件可能被篡改。"
        red "期望：$expected"
        red "实际：$actual"
        rm -f "$file" "$sum_file"
        exit 1
      fi
      green "SHA256 校验通过"
    else
      yellow "校验文件中未找到对应架构的校验值，跳过验证"
    fi
  else
    yellow "无法下载校验文件，跳过 SHA256 验证"
  fi
  rm -f "$sum_file"
}

download_bin_to(){
  local dest="$1"
  local arch
  arch=$(arch_name)
  local url="https://github.com/${REPO}/releases/latest/download/relayguard-panel-linux-${arch}"
  yellow "正在下载：$url"
  curl -fL "$url" -o "$dest"
  verify_sha256 "$dest"
  chmod +x "$dest"
}

download_bin(){
  mkdir -p "$BIN_DIR"
  download_bin_to "${BIN_DIR}/${APP}"
}

write_service(){
  local bind_addr="$1"
  local port="$2"

  cat >/etc/systemd/system/${SERVICE} <<SERVICE_EOF
[Unit]
Description=RelayGuard 中转卫士面板
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=${DATA_DIR}
ExecStart=${BIN_DIR}/${APP} -addr ${bind_addr}:${port} -data ${DATA_DIR}
Restart=always
RestartSec=3
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
SERVICE_EOF

  systemctl daemon-reload
}

show_panel_hint(){
  local bind_addr="$1"
  local port="$2"

  green "面板监听地址：http://${bind_addr}:${port}"

  if [ "$bind_addr" = "127.0.0.1" ] || [ "$bind_addr" = "localhost" ]; then
    yellow "当前仅监听本机回环地址，公网无法直接访问该端口。"
    yellow "推荐使用 Nginx / Caddy / 1Panel 反向代理到：http://127.0.0.1:${port}"
    yellow "浏览器访问请使用你的 HTTPS 域名，例如：https://panel.example.com"
  else
    yellow "当前监听非回环地址，请确保该地址为内网 IP，并按需限制安全组/防火墙。"
    yellow "如需公网 HTTPS 访问，请反向代理到：http://${bind_addr}:${port}"
  fi
}

current_execstart(){
  systemctl cat ${SERVICE} 2>/dev/null | grep -E '^ExecStart=' | tail -n1 | sed 's/^ExecStart=//'
}

current_bind_addr(){
  local exec
  exec="$(current_execstart || true)"
  if echo "$exec" | grep -q -- ' -addr '; then
    echo "$exec" | sed -nE 's/.* -addr ([^: ]+):([0-9]+).*/\1/p'
  fi
}

current_port(){
  local exec
  exec="$(current_execstart || true)"
  if echo "$exec" | grep -q -- ' -addr '; then
    echo "$exec" | sed -nE 's/.* -addr ([^: ]+):([0-9]+).*/\2/p'
  fi
}

install_panel(){
  need_root
  install_deps

  local bind_addr
  local port

  read_tty bind_addr "请输入面板监听地址 [${DEFAULT_BIND_ADDR}]（反代推荐 127.0.0.1；跨机器反代可填内网 IP）: "
  bind_addr="${bind_addr:-${DEFAULT_BIND_ADDR}}"

  read_tty port "请输入面板监听端口 [${DEFAULT_PORT}]: "
  port="${port:-${DEFAULT_PORT}}"

  mkdir -p "$DATA_DIR"
  download_bin
  write_service "$bind_addr" "$port"

  systemctl enable --now ${SERVICE}

  green "RelayGuard 面板安装完成"
  show_panel_hint "$bind_addr" "$port"
  yellow "如果首次启动未设置 ADMIN_PASSWORD，请查看初始随机密码："
  echo "journalctl -u ${SERVICE} -n 80 --no-pager"
}

update_panel(){
  need_root
  install_deps

  local tmp="/tmp/${APP}.new"
  local backup="${BIN_DIR}/${APP}.bak.$(date +%Y%m%d-%H%M%S)"

  rm -f "$tmp"
  download_bin_to "$tmp"

  yellow "正在停止面板服务..."
  systemctl stop ${SERVICE} 2>/dev/null || true

  sleep 1
  if pgrep -f "${BIN_DIR}/${APP}" >/dev/null 2>&1; then
    yellow "检测到旧进程仍在运行，正在结束..."
    pkill -f "${BIN_DIR}/${APP}" || true
    sleep 2
  fi

  if [ -f "${BIN_DIR}/${APP}" ]; then
    cp -f "${BIN_DIR}/${APP}" "$backup"
    yellow "旧版本已备份：$backup"
  fi

  mv -f "$tmp" "${BIN_DIR}/${APP}"
  chmod +x "${BIN_DIR}/${APP}"

  systemctl daemon-reload
  systemctl start ${SERVICE}

  green "更新完成"
  "${BIN_DIR}/${APP}" -version || true
  systemctl status ${SERVICE} --no-pager || true
}

configure_listen(){
  need_root

  local old_bind old_port bind_addr port
  old_bind="$(current_bind_addr || true)"
  old_port="$(current_port || true)"

  old_bind="${old_bind:-${DEFAULT_BIND_ADDR}}"
  old_port="${old_port:-${DEFAULT_PORT}}"

  read_tty bind_addr "请输入新的面板监听地址 [${old_bind}]（反代同机推荐 127.0.0.1）: "
  bind_addr="${bind_addr:-$old_bind}"

  read_tty port "请输入新的面板监听端口 [${old_port}]: "
  port="${port:-$old_port}"

  mkdir -p "$DATA_DIR"

  if [ ! -x "${BIN_DIR}/${APP}" ]; then
    yellow "未找到面板二进制，正在下载..."
    download_bin
  fi

  write_service "$bind_addr" "$port"
  systemctl enable ${SERVICE} >/dev/null 2>&1 || true
  systemctl restart ${SERVICE}

  green "监听地址已更新"
  show_panel_hint "$bind_addr" "$port"
}

uninstall_panel(){
  need_root
  systemctl stop ${SERVICE} 2>/dev/null || true
  systemctl disable ${SERVICE} 2>/dev/null || true
  rm -f /etc/systemd/system/${SERVICE}
  systemctl daemon-reload

  read_tty confirm "是否删除数据目录 ${DATA_DIR}？输入 YES 确认: "
  [ "$confirm" = "YES" ] && rm -rf "$DATA_DIR"

  rm -f "${BIN_DIR}/${APP}"
  green "卸载完成"
}

reset_password(){
  need_root
  read_tty admin_user "管理员用户名 [admin]: "
  admin_user="${admin_user:-admin}"

  read_tty_secret admin_pass "请输入新密码: "
  [ -n "$admin_pass" ] || { red "密码不能为空"; return; }

  systemctl stop ${SERVICE} 2>/dev/null || true
  ${BIN_DIR}/${APP} -data ${DATA_DIR} -admin-user "$admin_user" -admin-password "$admin_pass" -reset-admin-password
  systemctl start ${SERVICE} 2>/dev/null || true

  green "管理员密码已重置，旧登录会话已失效"
}

backup_panel(){
  need_root
  mkdir -p /root/relayguard-backup

  systemctl stop ${SERVICE} 2>/dev/null || true
  tar czf "/root/relayguard-backup/relayguard-$(date +%F-%H%M%S).tar.gz" "$DATA_DIR" 2>/dev/null || true
  systemctl start ${SERVICE} 2>/dev/null || true

  green "备份已保存到 /root/relayguard-backup/"
}

restore_panel(){
  need_root
  echo "可恢复完整数据包（.tar.gz）或 SQLite 数据库备份（.db）。"
  read_tty backup_file "请输入备份文件完整路径: "
  [ -f "$backup_file" ] || { red "备份文件不存在"; return; }

  read_tty confirm "恢复会覆盖当前数据，脚本会先自动备份当前数据。输入 确认恢复 继续: "
  [ "$confirm" = "确认恢复" ] || { yellow "已取消恢复"; return; }

  mkdir -p /root/relayguard-backup "$DATA_DIR/backups"
  local pre="/root/relayguard-backup/relayguard-pre-restore-$(date +%F-%H%M%S).tar.gz"

  systemctl stop ${SERVICE} 2>/dev/null || true
  tar czf "$pre" "$DATA_DIR" 2>/dev/null || true

  case "$backup_file" in
    *.tar.gz|*.tgz)
      rm -rf "$DATA_DIR"
      tar xzf "$backup_file" -C /
      ;;
    *.db)
      mkdir -p "$DATA_DIR"
      cp -f "$backup_file" "$DATA_DIR/relayguard.db"
      rm -f "$DATA_DIR/relayguard.db-wal" "$DATA_DIR/relayguard.db-shm"
      chmod 600 "$DATA_DIR/relayguard.db"
      ;;
    *)
      systemctl start ${SERVICE} 2>/dev/null || true
      red "仅支持 .tar.gz/.tgz 或 .db 备份文件"
      return
      ;;
  esac

  systemctl start ${SERVICE} 2>/dev/null || true
  green "恢复完成。恢复前备份已保存：$pre"
}

menu(){
  clear 2>/dev/null || true
  echo "========================================"
  echo "        RelayGuard 中转卫士 管理脚本"
  echo "========================================"
  echo "1. 安装面板"
  echo "2. 更新面板"
  echo "3. 卸载面板"
  echo "4. 查看面板状态"
  echo "5. 查看面板日志"
  echo "6. 重启面板"
  echo "7. 备份数据"
  echo "8. 恢复数据"
  echo "9. 重置管理员密码"
  echo "10. 修改监听地址/端口（反向代理推荐）"
  echo "0. 退出"
  echo "========================================"
  read_tty n "请输入选项: "

  case "$n" in
    1) install_panel;;
    2) update_panel;;
    3) uninstall_panel;;
    4) systemctl status ${SERVICE} --no-pager;;
    5) journalctl -u ${SERVICE} -f;;
    6) need_root; systemctl restart ${SERVICE}; green "已重启";;
    7) backup_panel;;
    8) restore_panel;;
    9) reset_password;;
    10) configure_listen;;
    0) exit 0;;
    *) red "无效选项";;
  esac
}

menu
