#!/usr/bin/env bash
set -euo pipefail

REPO="idcsu/relayguard"
APP="relayguard-agent"
BIN_DIR="/usr/local/bin"
DATA_DIR="/etc/relayguard-agent"
SERVICE="relayguard-agent.service"
PANEL=""
TOKEN=""
SSH_PORTS=""
ALLOW_TCP=""
ALLOW_UDP=""

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
need_root(){ [ "$(id -u)" = "0" ] || { red "请使用 root 用户运行"; exit 1; }; }
arch_name(){ case "$(uname -m)" in x86_64|amd64) echo amd64;; aarch64|arm64) echo arm64;; *) red "暂不支持架构：$(uname -m)"; exit 1;; esac; }

while [ $# -gt 0 ]; do
  case "$1" in
    --panel) PANEL="$2"; shift 2;;
    --token) TOKEN="$2"; shift 2;;
    --ssh-ports) SSH_PORTS="$2"; shift 2;;
    --allow-tcp) ALLOW_TCP="$2"; shift 2;;
    --allow-udp) ALLOW_UDP="$2"; shift 2;;
    *) shift;;
  esac
done

detect_ssh_ports(){
  local ports=""
  if [ -n "${SSH_CONNECTION:-}" ]; then
    # SSH_CONNECTION: client_ip client_port server_ip server_port
    local p; p=$(echo "$SSH_CONNECTION" | awk '{print $4}')
    [ -n "$p" ] && ports="$p"
  fi
  if command -v ss >/dev/null 2>&1; then
    local ss_ports
    ss_ports=$(ss -ltnp 2>/dev/null | awk '/sshd/ {split($4,a,":"); print a[length(a)]}' | sort -n | uniq | paste -sd, - || true)
    [ -n "$ss_ports" ] && ports="${ports:+$ports,}$ss_ports"
  fi
  if [ -f /etc/ssh/sshd_config ]; then
    local cfg_ports
    cfg_ports=$(awk 'tolower($1)=="port" {print $2}' /etc/ssh/sshd_config | sort -n | uniq | paste -sd, - || true)
    [ -n "$cfg_ports" ] && ports="${ports:+$ports,}$cfg_ports"
  fi
  if [ -z "$ports" ]; then ports="22"; fi
  echo "$ports" | tr ',' '\n' | awk '/^[0-9]+$/ && $1>=1 && $1<=65535 {print $1}' | sort -n | uniq | paste -sd, -
}

install_deps(){
  if command -v curl >/dev/null 2>&1; then return; fi
  if command -v apt-get >/dev/null 2>&1; then apt-get update && apt-get install -y curl ca-certificates iptables iproute2; return; fi
  if command -v yum >/dev/null 2>&1; then yum install -y curl ca-certificates iptables iproute; return; fi
  if command -v dnf >/dev/null 2>&1; then dnf install -y curl ca-certificates iptables iproute; return; fi
  red "未找到 curl，请先手动安装 curl 和 ca-certificates"; exit 1
}

download_agent(){
  local arch; arch=$(arch_name)
  local url="https://github.com/${REPO}/releases/latest/download/relayguard-agent-linux-${arch}"
  yellow "正在下载：$url"
  curl -fL "$url" -o "${BIN_DIR}/${APP}"
  chmod +x "${BIN_DIR}/${APP}"
}

install_agent(){
  need_root
  install_deps
  [ -n "$PANEL" ] || read_tty PANEL "请输入面板地址，例如 https://panel.example.com: "
  [ -n "$TOKEN" ] || read_tty TOKEN "请输入节点注册 Token: "
  [ -n "$SSH_PORTS" ] || SSH_PORTS=$(detect_ssh_ports)
  yellow "严格防火墙模式将保留 SSH 端口：${SSH_PORTS}"
  mkdir -p "$DATA_DIR"
  download_agent
  cat >/etc/systemd/system/${SERVICE} <<EOF2
[Unit]
Description=RelayGuard Agent 转发节点
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${BIN_DIR}/${APP} -panel ${PANEL} -token ${TOKEN} -data ${DATA_DIR} -ssh-ports ${SSH_PORTS} ${ALLOW_TCP:+-allow-tcp ${ALLOW_TCP}} ${ALLOW_UDP:+-allow-udp ${ALLOW_UDP}}
Restart=always
RestartSec=3
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF2
  systemctl daemon-reload
  systemctl enable --now ${SERVICE}
  green "Agent 安装完成"
  echo "查看状态：systemctl status ${SERVICE}"
  echo "查看日志：journalctl -u ${SERVICE} -f"
  echo "防火墙救援：${BIN_DIR}/${APP} firewall rescue"
}

uninstall_agent(){
  need_root
  systemctl disable --now ${SERVICE} 2>/dev/null || true
  if [ -x "${BIN_DIR}/${APP}" ]; then
    read_tty fw_confirm "是否清理 RelayGuard 创建的防火墙托管规则？输入 YES 确认: "
    [ "$fw_confirm" = "YES" ] && "${BIN_DIR}/${APP}" firewall rescue || true
  fi
  rm -f /etc/systemd/system/${SERVICE}
  systemctl daemon-reload
  rm -f "${BIN_DIR}/${APP}"
  read_tty confirm "是否删除 Agent 数据目录 ${DATA_DIR}？输入 YES 确认: "
  [ "$confirm" = "YES" ] && rm -rf "$DATA_DIR"
  green "卸载完成"
}

if [ -n "$PANEL" ] && [ -n "$TOKEN" ]; then
  install_agent
  exit 0
fi

clear
cat <<MENU
========================================
      RelayGuard Agent 节点管理脚本
========================================
1. 安装 Agent
2. 更新 Agent
3. 卸载 Agent
4. 查看 Agent 状态
5. 查看 Agent 日志
6. 重启 Agent
7. 测试面板连接
8. 防火墙状态
9. 防火墙救援模式
0. 退出
========================================
MENU
read_tty n "请输入选项: "
case "$n" in
  1) install_agent;;
  2) need_root; download_agent; systemctl restart ${SERVICE}; green "更新完成";;
  3) uninstall_agent;;
  4) systemctl status ${SERVICE} --no-pager;;
  5) journalctl -u ${SERVICE} -f;;
  6) need_root; systemctl restart ${SERVICE}; green "已重启";;
  7) curl -I --max-time 8 "$PANEL" || true;;
  8) ${BIN_DIR}/${APP} firewall status;;
  9) need_root; ${BIN_DIR}/${APP} firewall rescue;;
  0) exit 0;;
  *) red "无效选项";;
esac
