#!/usr/bin/env bash
set -euo pipefail

REPO="idcsu/relayguard"
APP="relayguard-panel"
BIN_DIR="/usr/local/bin"
DATA_DIR="/etc/relayguard"
SERVICE="relayguard-panel.service"
PORT="7080"

red(){ echo -e "\033[31m$*\033[0m"; }
green(){ echo -e "\033[32m$*\033[0m"; }
yellow(){ echo -e "\033[33m$*\033[0m"; }

# 兼容 `curl ... | bash` 的交互输入。
# 当脚本内容来自管道时，标准输入已经被 bash 用来读取脚本，普通 read 会读到 EOF。
# 所有交互输入都显式从 /dev/tty 读取，保证菜单可以正常选择。
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

need_root(){ [ "$(id -u)" = "0" ] || { red "请使用 root 用户运行"; exit 1; }; }
arch_name(){ case "$(uname -m)" in x86_64|amd64) echo amd64;; aarch64|arm64) echo arm64;; *) red "暂不支持架构：$(uname -m)"; exit 1;; esac; }
install_deps(){
  if command -v apt-get >/dev/null; then
    apt-get update
    apt-get install -y curl ca-certificates libsqlite3-0
  elif command -v dnf >/dev/null; then
    dnf install -y curl ca-certificates sqlite-libs
  elif command -v yum >/dev/null; then
    yum install -y curl ca-certificates sqlite
  elif command -v apk >/dev/null; then
    apk add --no-cache curl ca-certificates sqlite-libs
  else
    command -v curl >/dev/null || { red "请先安装 curl"; exit 1; }
  fi
}

download_bin(){
  local arch; arch=$(arch_name)
  local url="https://github.com/${REPO}/releases/latest/download/relayguard-panel-linux-${arch}"
  yellow "正在下载：$url"
  curl -fL "$url" -o "${BIN_DIR}/${APP}"
  chmod +x "${BIN_DIR}/${APP}"
}

install_panel(){
  need_root; install_deps
  read_tty input_port "请输入面板监听端口 [7080]: "
  PORT="${input_port:-7080}"
  mkdir -p "$DATA_DIR"
  download_bin
  cat >/etc/systemd/system/${SERVICE} <<EOF2
[Unit]
Description=RelayGuard 中转卫士面板
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${BIN_DIR}/${APP} -addr :${PORT} -data ${DATA_DIR}
Restart=always
RestartSec=3
LimitNOFILE=1048576
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF2
  systemctl daemon-reload
  systemctl enable --now ${SERVICE}
  green "安装完成"
  echo "面板地址：http://服务器IP:${PORT}"
  echo "请查看初始密码：journalctl -u ${SERVICE} -n 80 --no-pager"
}

uninstall_panel(){
  need_root
  systemctl disable --now ${SERVICE} 2>/dev/null || true
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
  tar czf "/root/relayguard-backup/relayguard-$(date +%F-%H%M%S).tar.gz" "$DATA_DIR"
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
  echo "0. 退出"
  echo "========================================"
  read_tty n "请输入选项: "
  case "$n" in
    1) install_panel;;
    2) need_root; download_bin; systemctl restart ${SERVICE}; green "更新完成";;
    3) uninstall_panel;;
    4) systemctl status ${SERVICE} --no-pager;;
    5) journalctl -u ${SERVICE} -f;;
    6) need_root; systemctl restart ${SERVICE}; green "已重启";;
    7) backup_panel;;
    8) restore_panel;;
    9) reset_password;;
    0) exit 0;;
    *) red "无效选项";;
  esac
}
menu
