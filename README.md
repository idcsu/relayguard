# RelayGuard 中转卫士

RelayGuard 是一个面向个人部署的轻量级多节点端口转发管理面板。

它的目标是：在一台低配置 VPS 上运行中心面板，通过 Agent 管理多台转发节点服务器，实现 TCP / UDP 端口转发、节点心跳、流量统计、SQLite 持久化、审计日志、数据库备份和节点防火墙托管。

> 当前版本：v0.10.0。已跑通中心面板 + Agent + TCP/UDP 转发 + 基础流量统计 + 节点防火墙托管 + SQLite 存储 + 用户管理与配额；新增登录失败限速、TOTP 两步验证、会话管理、首次密码强制修改，面板内安全备份恢复，Agent 连通性检测，以及节点/规则详情页、检测历史、筛选搜索和 UI 美化增强。

## 功能状态

已实现：

- 中心面板登录
- 首次启动随机管理员密码
- 管理员密码本地重置命令
- 简体中文 Web UI
- SQLite 数据库存储，默认文件 `relayguard.db`
- 从旧版 `relayguard.json` 自动迁移到 SQLite
- 审计日志 API 和页面
- 数据库备份 API 和页面
- 面板内一键恢复备份
- 恢复前自动备份和失败回滚
- 面板一键发起连通性检测
- Agent 执行节点本地监听、目标 TCP/UDP、Ping 检测并回传结果
- 用户管理页面
- 管理员 / 普通用户角色
- 用户规则数量上限
- 用户总流量额度
- 用户到期时间
- 用户允许节点范围
- 用户允许端口范围
- 普通用户只能管理自己的转发规则
- 用户过期、禁用或流量用尽后 Agent 不再下发其启用规则
- 节点一次性 Token 注册
- Agent 主动心跳
- Agent HMAC-SHA256 签名认证
- 节点在线 / 离线状态
- TCP 转发
- UDP 转发
- TCP+UDP 规则
- 来源 IP / CIDR 白名单
- 最大连接数限制
- 简单 Mbps 限速
- 规则启用 / 停用 / 删除
- 规则级流量统计
- 节点端口范围校验
- 节点最大规则数校验
- Agent 断线后保留最后成功规则
- 节点防火墙托管链 `RELAYGUARD-INPUT`
- 防火墙宽松托管模式
- 防火墙严格托管模式
- 严格防火墙 60 秒待确认与自动回滚
- 面板确认严格防火墙按钮
- 防火墙本地救援命令
- 节点安装脚本自动识别 SSH 端口
- systemd 安装脚本
- Dockerfile / docker-compose 草案
- 节点详情页和规则详情页
- 转发规则检测历史
- 节点 / 规则搜索与筛选
- 仪表盘概览与现代化 UI 增强

计划增强：

- realm / nftables / iptables DNAT 引擎
- IPv6 转发增强
- 面板 HTTPS 自动配置向导

## 架构

```text
RelayGuard Panel
├─ Go 后端
├─ 内置中文 Web UI
├─ SQLite 数据库
├─ 节点 Token 管理
├─ Agent 心跳 API
├─ 防火墙策略下发
├─ 转发规则下发
├─ 审计日志
└─ 数据库备份

RelayGuard Agent
├─ Go 单二进制
├─ systemd 常驻
├─ 主动连接面板
├─ 拉取转发规则
├─ 执行 TCP / UDP 转发
├─ 管理节点防火墙托管链
├─ 执行连通性检测
└─ 上报流量、防火墙状态、检测结果和运行状态
```

## 界面体验增强

v0.10.0 起，Web UI 增强了长期使用体验：

- 节点列表支持按关键词和在线状态筛选
- 转发规则支持按关键词、节点、协议和运行状态筛选
- 节点详情页展示系统信息、资源占用、防火墙状态、端口范围和节点规则
- 规则详情页展示转发配置、运行状态、限额策略、归属信息和检测历史
- 仪表盘展示在线节点、运行规则、累计流量、异常规则、节点概览和流量 Top 规则
- 前端事件改为统一事件委托，减少 CSP 下内联事件处理的兼容风险

## 用户与配额

v0.4.0 起新增用户管理和基础配额系统。

管理员可以为每个用户设置：

- 角色：超级管理员 / 管理员 / 普通用户
- 规则数量上限
- 总流量额度
- 到期日期
- 允许使用的节点
- 允许使用的端口范围
- 是否禁用

普通用户登录后只能看到和操作自己的转发规则。创建和编辑规则时，面板会校验节点权限、端口范围、规则数量、流量额度和到期状态。

Agent 拉取规则时也会再次过滤：如果所属用户被禁用、过期或流量用尽，面板不会继续把这些规则下发给节点。

## 连通性检测

v0.9.0 起，转发规则列表提供“检测”按钮。检测任务由面板创建，对应节点 Agent 通过心跳领取并在节点本地执行：

- 检测转发规则的本地监听端口
- 测试目标 TCP 端口连通性
- 对 UDP 目标发送基础探测包
- 对目标地址执行 Ping 延迟检测
- 将最近检测状态、错误原因和明细回传面板

UDP 本身无法像 TCP 一样保证对端业务响应，所以 UDP 检测结果表示“探测包已成功发出”，不等同于业务协议一定可用。

## 防火墙托管模式

RelayGuard Agent 使用 iptables 创建独立链：

```text
RELAYGUARD-INPUT
```

Agent 只管理 RelayGuard 自己创建的链和入口跳转，不主动清空用户原有防火墙规则。

### 关闭托管

Agent 不管理防火墙。

### 宽松托管

Agent 自动放行已启用转发规则的监听端口，然后 `RETURN` 给系统原有防火墙规则处理其他流量。

适合作为默认模式，风险低。

### 严格托管

从 v0.6.0 开始，严格模式会先进入“严格待确认”：Agent 应用严格规则后保留 60 秒确认窗口，面板点击“确认严格”后才长期保持；如果没有确认，Agent 会自动移除 RelayGuard 托管链并回滚，降低误封 SSH 的风险。

Agent 在托管链中放行：

- 已建立连接
- 回环接口
- ICMP
- Agent 安装时识别到的 SSH 端口
- 用户额外指定的保留端口
- 已启用转发规则的监听端口

未命中的入站流量会被 `DROP`。

严格模式启用前请确认 SSH 端口正确，避免误封。如果 60 秒内没有确认，Agent 会自动回滚。节点本地救援命令：

```bash
relayguard-agent firewall rescue
```

查看托管链状态：

```bash
relayguard-agent firewall status
```

## 数据存储

v0.3.0 起，面板默认使用 SQLite：

```text
/etc/relayguard/relayguard.db
```

如果数据目录里存在旧版 `relayguard.json`，首次启动 v0.3.0 或更高版本会自动迁移到 `relayguard.db`，并把旧文件重命名为：

```text
relayguard.json.migrated
```

SQLite 使用 WAL 模式，适合个人部署和 1G VPS 长期运行。安装脚本会安装 SQLite 运行库。

## 一键安装面板

```bash
curl -fsSL https://raw.githubusercontent.com/idcsu/relayguard/main/scripts/install.sh | bash
```

脚本菜单：

```text
1. 安装面板
2. 更新面板
3. 卸载面板
4. 查看面板状态
5. 查看面板日志
6. 重启面板
7. 备份数据
8. 重置管理员密码
0. 退出
```

安装完成后查看初始密码：

```bash
journalctl -u relayguard-panel.service -n 80 --no-pager
```

## 本地开发运行

要求：

- Go 1.22+
- Linux 面板构建需要 `libsqlite3-dev` / `sqlite-devel`

Debian / Ubuntu：

```bash
apt-get update
apt-get install -y gcc libsqlite3-dev
```

运行面板：

```bash
ADMIN_PASSWORD='请改成强密码' \
go run ./cmd/relayguard-panel -addr :7080 -data ./data
```

访问：

```text
http://服务器IP:7080
```

启动节点 Agent：

```bash
go run ./cmd/relayguard-agent \
  -panel http://面板IP:7080 \
  -token 面板生成的节点Token \
  -data ./agent-data
```

## 管理员密码重置

如果忘记管理员密码，可以在服务器本地执行：

```bash
systemctl stop relayguard-panel
relayguard-panel -data /etc/relayguard \
  -admin-user admin \
  -admin-password '新的强密码' \
  -reset-admin-password
systemctl start relayguard-panel
```

该操作会清空已有登录会话。

## GitHub Release 构建说明

当前面板使用 SQLite CGO 构建，因此 Release 工作流默认构建：

- `relayguard-panel-linux-amd64`
- `relayguard-agent-linux-amd64`
- `relayguard-agent-linux-arm64`

后续如果改为纯 Go SQLite 驱动，可以恢复面板 arm64 交叉构建。

## 上传仓库

```bash
git init
git add .
git commit -m "init relayguard"
git branch -M main
git remote add origin https://github.com/idcsu/relayguard.git
git push -u origin main
```

发布 v0.10.0：

```bash
git tag v0.10.0
git push origin v0.10.0
```
