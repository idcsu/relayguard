# RelayGuard / 中转卫士

RelayGuard 是一个适合个人部署使用的多节点端口转发面板。面板负责集中管理节点、用户、转发规则、检测、防火墙托管和备份；节点 Agent 负责在转发服务器上执行规则并主动向面板心跳。

## 推荐部署方式

生产环境推荐：

```text
浏览器 / Agent
    ↓ HTTPS 域名
Nginx / Caddy / 1Panel 反向代理
    ↓ HTTP 内网地址
RelayGuard Panel 127.0.0.1:10026
```

也就是说，RelayGuard 面板本身不需要直接暴露公网端口。推荐让面板只监听：

```text
127.0.0.1:10026
```

然后由 Nginx、Caddy、1Panel、宝塔等工具反向代理到域名，并负责 HTTPS 证书。

这样做的好处：

- 面板管理端口不直接暴露公网
- HTTPS / SSL 交给成熟反向代理处理
- 更容易接入域名、防火墙、WAF、访问日志
- 后续迁移和维护更方便

## 一键安装

```bash
curl -fsSL https://raw.githubusercontent.com/idcsu/relayguard/main/scripts/install.sh | bash
```

菜单说明：

```text
1. 安装面板
2. 更新面板
3. 卸载面板
4. 查看面板状态
5. 查看面板日志
6. 重启面板
7. 备份数据
8. 恢复数据
9. 重置管理员密码
10. 修改监听地址/端口（反向代理推荐）
0. 退出
```

首次安装时，脚本会询问：

```text
面板监听地址：默认 127.0.0.1
面板监听端口：默认 10026
```

如果反向代理和面板在同一台机器上，推荐保持：

```text
127.0.0.1:10026
```

如果反向代理在另一台机器上，可以填写面板服务器的内网 IP，例如：

```text
10.0.0.5:10026
```

这种情况下请务必限制安全组或防火墙，只允许反向代理服务器访问该端口。

## 已安装后改成反向代理模式

运行安装脚本：

```bash
curl -fsSL https://raw.githubusercontent.com/idcsu/relayguard/main/scripts/install.sh | bash
```

选择：

```text
10. 修改监听地址/端口（反向代理推荐）
```

推荐填写：

```text
监听地址：127.0.0.1
监听端口：10026
```

然后确认服务状态：

```bash
systemctl status relayguard-panel --no-pager
ss -lntp | grep relayguard
curl -I http://127.0.0.1:10026/
```

如果看到 `127.0.0.1:10026` 或本机 curl 正常，说明面板已经改为内部访问。

## Nginx 反向代理示例

假设域名是：

```text
panel.example.com
```

RelayGuard 本地监听：

```text
127.0.0.1:10026
```

Nginx 配置示例：

```nginx
server {
    listen 80;
    server_name panel.example.com;

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2;
    server_name panel.example.com;

    ssl_certificate     /etc/letsencrypt/live/panel.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/panel.example.com/privkey.pem;

    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:10026;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

如果你使用 1Panel、宝塔、Nginx Proxy Manager，也只需要把反代目标填成：

```text
http://127.0.0.1:10026
```

## Caddy 反向代理示例

```caddyfile
panel.example.com {
    reverse_proxy 127.0.0.1:10026
}
```

Caddy 会自动申请和续期 HTTPS 证书。

## 安全建议

生产环境建议：

- 面板只监听 `127.0.0.1` 或内网 IP
- 公网只开放 `80` / `443`
- 不要开放面板内部端口 `10026`
- 使用 HTTPS 域名访问面板
- 首次登录后立即修改管理员密码
- 开启两步验证
- 定期备份 `/etc/relayguard`
- 节点服务器防火墙使用宽松托管或严格托管
- 严格托管前确认 SSH 端口安全
- 保存节点救援命令：`relayguard-agent firewall rescue`

## Agent 接入说明

在面板的“节点接入”页面生成一次性 Token。  
如果你通过域名访问面板，生成的安装命令会自动使用当前域名，例如：

```bash
curl -fsSL https://panel.example.com/api/agent/install.sh | bash -s -- --panel https://panel.example.com --token <TOKEN>
```

注意：Agent 必须能访问你的面板域名。  
如果面板只监听 `127.0.0.1`，节点不能直接访问 `127.0.0.1:10026`，必须通过反向代理域名访问。

## 常用命令

查看服务：

```bash
systemctl status relayguard-panel --no-pager
```

查看日志：

```bash
journalctl -u relayguard-panel -n 100 --no-pager
```

查看监听端口：

```bash
ss -lntp | grep relayguard
```

本机测试：

```bash
curl -I http://127.0.0.1:10026/
curl -s http://127.0.0.1:10026/healthz
```

更新面板：

```bash
curl -fsSL https://raw.githubusercontent.com/idcsu/relayguard/main/scripts/install.sh | bash
```

选择：

```text
2. 更新面板
```

备份数据：

```bash
tar czf /root/relayguard-backup-$(date +%F).tar.gz /etc/relayguard
```

## 升级验证

升级后建议执行：

```bash
relayguard-panel -version
curl -s http://127.0.0.1:10026/healthz
systemctl status relayguard-panel --no-pager
```

浏览器使用你的 HTTPS 域名访问面板。

## 排查访问问题

如果浏览器打不开：

1. 本机测试面板是否正常：

```bash
curl -I http://127.0.0.1:10026/
```

2. 检查服务：

```bash
systemctl status relayguard-panel --no-pager
journalctl -u relayguard-panel -n 100 --no-pager
```

3. 检查 Nginx/Caddy 反代目标是否是：

```text
http://127.0.0.1:10026
```

4. 检查域名 DNS 是否解析到反向代理服务器。

5. 检查公网防火墙是否开放 80/443。

如果面板监听的是 `127.0.0.1`，公网访问 `IP:10026` 不通是正常的。
