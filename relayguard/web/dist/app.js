const app = document.getElementById('app');

const state = {
  user: null,
  version: '',
  page: 'dashboard',
  dashboard: {},
  nodes: [],
  rules: [],
  statuses: {},
  users: [],
  sessions: [],
  filters: {
    nodes: { q: '', status: 'all' },
    rules: { q: '', node: 'all', protocol: 'all', state: 'all' }
  },
  ui: { busy: false, filterTimer: null, lastRefreshAt: null }
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const res = await fetch(path, { credentials: 'same-origin', ...options, headers });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data.error || data.message || `请求失败：${res.status}`);
  return data;
}

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
}
function fmtDate(v) { if (!v) return '-'; const d = new Date(v); return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString('zh-CN', { hour12: false }); }
function fmtShortDate(v) { if (!v) return '-'; const d = new Date(v); return Number.isNaN(d.getTime()) ? '-' : d.toLocaleDateString('zh-CN'); }
function fmtBytes(n) { n = Number(n || 0); const u = ['B','KB','MB','GB','TB','PB']; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return `${n.toFixed(i ? 2 : 0)} ${u[i]}`; }
function fmtCount(n) { return Number(n || 0).toLocaleString('zh-CN'); }
function pct(used, total) { if (!total) return 0; return Math.min(100, Math.round((Number(used || 0) / Number(total || 1)) * 100)); }
function roleText(r) { return ({ super_admin:'超级管理员', admin:'管理员', user:'普通用户' }[r] || r || '-'); }
function protocolText(p) { return ({ tcp:'TCP', udp:'UDP', both:'TCP + UDP' }[p] || String(p || '-').toUpperCase()); }
function isAdmin() { return ['super_admin','admin'].includes(state.user?.role); }
function byID(items, id) { return items.find(x => x.id === id); }
function statusOf(ruleID) { return state.statuses?.[ruleID] || {}; }
function ownerName(id) { return byID(state.users, id)?.username || (id === state.user?.id ? state.user.username : id || '-'); }
function nodeName(id) { return byID(state.nodes, id)?.name || id || '-'; }
function online(n) { return n.status === 'online'; }
function badge(cls, text) { return `<span class="badge ${cls}">${esc(text)}</span>`; }
function statusBadge(st) {
  if (!st || !st.state) return badge('off', '未上报');
  const map = { running: ['ok','运行中'], stopped: ['off','已停止'], error: ['err','异常'], unsupported: ['warn','不支持'] };
  const [cls, text] = map[st.state] || ['off', st.state];
  return badge(cls, text);
}
function nodeBadge(n) { return online(n) ? badge('ok','在线') : badge('off','离线'); }
function firewallText(n) {
  const mode = n.firewall_mode || 'loose';
  const runtime = n.firewall_state || '';

  let text = '宽松托管';
  let cls = 'off';

  if (mode === 'off') {
    text = '未托管';
    cls = 'off';
  } else if (mode === 'loose') {
    text = runtime === 'unsupported' ? '不支持' : '宽松托管';
    cls = runtime === 'unsupported' ? 'warn' : 'off';
  } else if (mode === 'strict-pending') {
    text = '严格待确认';
    cls = 'warn';
  } else if (mode === 'strict') {
    if (runtime === 'strict-pending') {
      text = '严格确认中';
      cls = 'warn';
    } else if (runtime === 'rollback') {
      text = '已自动回滚';
      cls = 'warn';
    } else if (runtime === 'unsupported') {
      text = '不支持';
      cls = 'warn';
    } else if (runtime === 'error') {
      text = '异常';
      cls = 'err';
    } else {
      text = '严格托管';
      cls = 'ok';
    }
  } else if (runtime === 'rollback') {
    text = '已自动回滚';
    cls = 'warn';
  } else if (runtime === 'error') {
    text = '异常';
    cls = 'err';
  } else if (runtime === 'unsupported') {
    text = '不支持';
    cls = 'warn';
  }

  if (n.firewall_error) cls = 'err';
  return badge(cls, text);
}


function toast(msg, type = 'info') {
  let stack = $('#toastStack');
  if (!stack) { stack = document.createElement('div'); stack.id = 'toastStack'; stack.className = 'toast-stack'; document.body.appendChild(stack); }
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<span class="toast-dot"></span><span>${esc(msg)}</span>`;
  stack.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 220); }, 3600);
}
function setBusy(v) {
  state.ui.busy = !!v;
  document.body.classList.toggle('is-busy', !!v);
  $$('[data-action="refresh"]').forEach(b => { b.disabled = !!v; b.textContent = v ? '刷新中…' : '刷新'; });
}

async function init() {
  try {
    const me = await api('/api/me');
    state.user = me.user; state.version = me.version || '';
    if (state.user?.must_change) state.page = 'account';
    await refreshAll(); render();
  } catch { renderLogin(); }
}

async function refreshAll() {
  const base = [api('/api/dashboard'), api('/api/nodes'), api('/api/rules')];
  if (isAdmin()) base.push(api('/api/users'));
  const [dash, nodes, rules, users] = await Promise.all(base);
  state.dashboard = dash || {};
  state.nodes = nodes.items || [];
  state.rules = rules.items || [];
  state.statuses = rules.statuses || {};
  if (users) state.users = users.items || [];
}
async function refreshClick() {
  try {
    setBusy(true);
    await refreshAll();
    state.ui.lastRefreshAt = new Date();
    renderContent();
    toast('已刷新', 'success');
  } catch (e) { toast(e.message, 'error'); }
  finally { setBusy(false); }
}

function renderLogin() {
  app.innerHTML = `<div class="login-wrap"><div class="login-bg one"></div><div class="login-bg two"></div><div class="login-card"><div class="logo"><div class="logo-mark pulse"></div><div><div class="brand-title">RelayGuard 中转卫士</div><div class="muted">轻量、安全的多节点端口转发面板</div></div></div><h1>欢迎回来</h1><p class="muted">登录中心面板，统一管理节点、转发规则和防火墙策略。</p><form id="loginForm"><div class="field"><label>用户名</label><input class="input" name="username" value="admin" autocomplete="username"></div><div class="field"><label>密码</label><input class="input" name="password" type="password" autocomplete="current-password"></div><div class="field"><label>两步验证码</label><input class="input" name="totp_code" inputmode="numeric" autocomplete="one-time-code" placeholder="未启用可留空"></div><button class="btn primary big" style="width:100%"><span>登录面板</span></button></form><div class="login-foot">Agent 主动心跳 · HMAC 签名 · 防火墙托管</div></div></div>`;
  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    try {
      setBusy(true);
      const d = await api('/api/auth/login', { method:'POST', body: JSON.stringify(fd) });
      state.user = d.user;
      if (state.user?.must_change) { state.page = 'account'; render(); return; }
      await refreshAll(); render();
      toast('登录成功', 'success');
    } catch (err) { toast(err.message, 'error'); }
    finally { setBusy(false); }
  });
}

function navItems() {
  const items = [ ['dashboard','仪表盘','📊'], ['nodes','节点管理','🖧'], ['rules','转发规则','⇄'] ];
  if (isAdmin()) items.push(['users','用户管理','👥'], ['tokens','节点接入','＋'], ['audit','审计日志','☰'], ['backup','备份恢复','◫']);
  items.push(['account','账号安全','🔐'], ['security','安全说明','🛡']);
  return items;
}
function shell() {
  const nav = navItems().map(([id, name, icon]) => `<button data-page="${id}" class="${state.page===id?'active':''}"><span class="nav-icon">${icon}</span><span>${name}</span></button>`).join('');
  const onlineNodes = state.nodes.filter(online).length;
  const runningRules = state.rules.filter(r => statusOf(r.id).state === 'running').length;
  const refreshed = state.ui.lastRefreshAt ? fmtDate(state.ui.lastRefreshAt) : '刚刚';
  return `<div class="layout"><aside class="sidebar"><div class="brand"><div class="logo-mark pulse"></div><div><div class="brand-title">RelayGuard</div><div class="muted">中转卫士 · ${esc(state.version || 'v0.11')}</div></div></div><nav class="nav">${nav}</nav><div class="sidebar-foot"><div class="mini-status"><span>在线节点 <b>${onlineNodes}</b></span><span>运行规则 <b>${runningRules}</b></span></div><div class="user-chip"><b>${esc(state.user?.username)}</b><span>${roleText(state.user?.role)}</span></div><button class="btn ghost" data-action="logout">退出登录</button></div></aside><main class="main"><div class="topbar"><div><div class="kicker">RelayGuard Console</div><div class="page-title">${pageTitle()}</div><div class="muted">${pageSubTitle()}</div></div><div class="top-actions"><div class="refresh-note">最近刷新：${esc(refreshed)}</div><button class="btn" data-action="refresh">刷新</button></div></div><div id="content" class="content-enter"></div></main></div>`;
}
function pageTitle() { return ({dashboard:'仪表盘',nodes:'节点管理',rules:'转发规则',users:'用户管理',tokens:'节点接入',audit:'审计日志',backup:'备份恢复',account:'账号安全',security:'安全说明'}[state.page] || 'RelayGuard'); }
function pageSubTitle() { return ({dashboard:'查看节点、规则、流量与风险概览',nodes:'管理转发节点、端口范围和防火墙托管',rules:'创建、检测、启停和查看转发规则',users:'配置用户权限、配额、节点和端口范围',tokens:'生成节点 Agent 一次性接入命令',audit:'查看重要操作记录',backup:'创建和恢复 SQLite 数据库备份',account:'修改密码、两步验证和会话管理',security:'了解节点接入、防火墙托管和救援策略'}[state.page] || ''); }
function render() { app.innerHTML = shell(); renderContent(); }
function renderContent() {
  const c = $('#content'); if (!c) return;
  c.classList.remove('content-enter'); void c.offsetWidth; c.classList.add('content-enter');
  if (state.page === 'dashboard') c.innerHTML = dashboardPage();
  if (state.page === 'nodes') c.innerHTML = nodesPage();
  if (state.page === 'rules') c.innerHTML = rulesPage();
  if (state.page === 'users') c.innerHTML = usersPage();
  if (state.page === 'tokens') c.innerHTML = tokensPage();
  if (state.page === 'audit') auditPage();
  if (state.page === 'backup') backupPage();
  if (state.page === 'account') accountPage();
  if (state.page === 'security') c.innerHTML = securityPage();
}

function dashboardPage() {
  const d = state.dashboard || {};
  const onlineNodes = state.nodes.filter(online).length;
  const runningRules = state.rules.filter(r => statusOf(r.id).state === 'running').length;
  const errRules = state.rules.filter(r => statusOf(r.id).state === 'error').length;
  const traffic = state.rules.reduce((sum, r) => sum + Number(r.traffic_used || 0), 0);
  const topRules = [...state.rules].sort((a,b)=>Number(b.traffic_used||0)-Number(a.traffic_used||0)).slice(0,5);
  const nodeRows = state.nodes.slice(0,6).map(n => `<tr><td><b>${esc(n.name)}</b><div class="muted">${esc(n.public_ip || n.hostname || '-')}</div></td><td>${nodeBadge(n)}</td><td>${firewallText(n)}</td><td>${fmtDate(n.last_seen_at)}</td></tr>`).join('');
  const topRuleRows = topRules.map(r => `<tr><td><b>${esc(r.name)}</b><div class="muted">${protocolText(r.protocol)} :${r.listen_port} → ${esc(r.target_host)}:${r.target_port}</div></td><td>${fmtBytes(r.traffic_used)}</td><td>${statusBadge(statusOf(r.id))}</td></tr>`).join('');
  return `<div class="hero"><div><div class="kicker">Overview</div><h1>运行概览</h1><p>快速查看节点在线、规则运行、流量使用和异常风险。</p></div><div class="hero-pill">${nodeBadge({status: onlineNodes ? 'online' : 'offline'})} <span>${fmtCount(onlineNodes)} 个节点在线</span></div></div><div class="cards"><div class="card metric-card accent-blue"><h3>节点</h3><div class="metric">${fmtCount(onlineNodes)} / ${fmtCount(state.nodes.length)}</div><p class="muted">在线 / 总数</p></div><div class="card metric-card accent-purple"><h3>转发规则</h3><div class="metric">${fmtCount(runningRules)} / ${fmtCount(state.rules.length)}</div><p class="muted">运行中 / 总数</p></div><div class="card metric-card accent-green"><h3>累计流量</h3><div class="metric">${fmtBytes(d.total_traffic || traffic)}</div><p class="muted">规则级统计</p></div><div class="card metric-card accent-red"><h3>风险项</h3><div class="metric">${fmtCount(errRules)}</div><p class="muted">异常规则数量</p></div></div><div class="grid2 section"><div class="card"><div class="section-head"><h2>节点概览</h2><button class="btn" data-page="nodes">查看全部</button></div>${nodeRows?`<table class="table compact"><tbody>${nodeRows}</tbody></table>`:'<div class="empty">暂无节点。</div>'}</div><div class="card"><div class="section-head"><h2>流量 Top 规则</h2><button class="btn" data-page="rules">查看全部</button></div>${topRuleRows?`<table class="table compact"><tbody>${topRuleRows}</tbody></table>`:'<div class="empty">暂无规则。</div>'}</div></div><div class="card section"><h2>部署提示</h2><div class="tips"><div><b>Agent 主动心跳</b><p>面板无需保存节点 SSH 密钥，节点通过 Token 注册后使用 HMAC 签名。</p></div><div><b>防火墙托管</b><p>宽松模式只开放转发端口；严格模式带 60 秒确认和自动回滚。</p></div><div><b>低配适配</b><p>中心面板使用 Go + SQLite，适合 1G VPS 长期运行。</p></div></div></div>`;
}

function filteredNodes() {
  const f = state.filters.nodes;
  return state.nodes.filter(n => {
    const hay = `${n.name} ${n.hostname} ${n.public_ip} ${(n.private_ips||[]).join(' ')} ${n.os} ${n.arch}`.toLowerCase();
    if (f.q && !hay.includes(f.q.toLowerCase())) return false;
    if (f.status !== 'all' && (online(n) ? 'online' : 'offline') !== f.status) return false;
    return true;
  });
}
function nodesPage() {
  const nodes = filteredNodes();
  return `<div class="section card"><div class="section-head"><div><h2>节点列表</h2><p class="muted">共 ${fmtCount(nodes.length)} 个匹配节点，在线 ${fmtCount(nodes.filter(online).length)} 个</p></div><button class="btn primary" data-page="tokens">添加节点</button></div><div class="toolbar"><input class="input" data-filter="nodes.q" placeholder="搜索节点名称 / IP / 主机名" value="${esc(state.filters.nodes.q)}"><select data-filter="nodes.status"><option value="all" ${state.filters.nodes.status==='all'?'selected':''}>全部状态</option><option value="online" ${state.filters.nodes.status==='online'?'selected':''}>在线</option><option value="offline" ${state.filters.nodes.status==='offline'?'selected':''}>离线</option></select></div>${nodeTable(nodes)}</div>`;
}
function nodeTable(nodes) {
  if (!nodes.length) return '<div class="empty">暂无匹配节点。</div>';
  return `<table class="table"><thead><tr><th>节点</th><th>状态</th><th>防火墙</th><th>资源</th><th>端口范围</th><th>最近心跳</th><th>操作</th></tr></thead><tbody>${nodes.map(n => {
    const m = n.last_metrics || {};
    return `<tr><td><b>${esc(n.name)}</b><div class="muted">${esc(n.hostname || '-')} · ${esc(n.os || '-')}/${esc(n.arch || '-')}</div><div class="muted">公网：${esc(n.public_ip || '-')}</div></td><td>${nodeBadge(n)}</td><td>${firewallText(n)}${n.firewall_error?`<div class="danger-text">${esc(n.firewall_error)}</div>`:''}</td><td><div class="mini">CPU ${Math.round(m.cpu_percent||0)}% · 内存 ${fmtBytes(m.memory_used)} / ${fmtBytes(m.memory_total)}</div><div class="bar"><i style="width:${pct(m.memory_used,m.memory_total)}%"></i></div></td><td>${n.port_range_start || '-'} - ${n.port_range_end || '-'}</td><td>${fmtDate(n.last_seen_at)}</td><td><div class="row-actions"><button class="btn" data-node-detail="${esc(n.id)}">详情</button>${isAdmin()?`<button class="btn" data-node-edit="${esc(n.id)}">设置</button>${n.firewall_mode==='strict-pending'?`<button class="btn primary" data-node-confirm="${esc(n.id)}">确认严格</button>`:''}<button class="btn danger" data-node-delete="${esc(n.id)}">删除</button>`:''}</div></td></tr>`;
  }).join('')}</tbody></table>`;
}

function filteredRules() {
  const f = state.filters.rules;
  return state.rules.filter(r => {
    const st = statusOf(r.id);
    const hay = `${r.name} ${r.listen_port} ${r.target_host} ${r.target_port} ${nodeName(r.node_id)} ${ownerName(r.user_id)} ${r.description}`.toLowerCase();
    if (f.q && !hay.includes(f.q.toLowerCase())) return false;
    if (f.node !== 'all' && r.node_id !== f.node) return false;
    if (f.protocol !== 'all' && r.protocol !== f.protocol) return false;
    if (f.state !== 'all') {
      const key = r.enabled ? (st.state || 'enabled') : 'disabled';
      if (f.state === 'enabled' && !r.enabled) return false;
      else if (f.state !== 'enabled' && key !== f.state) return false;
    }
    return true;
  });
}
function rulesPage() {
  const nodeOpts = state.nodes.map(n => `<option value="${esc(n.id)}" ${state.filters.rules.node===n.id?'selected':''}>${esc(n.name)}</option>`).join('');
  const rows = filteredRules();
  return `<div class="section card"><div class="section-head"><div><h2>转发规则</h2><p class="muted">共 ${fmtCount(rows.length)} 条匹配规则，运行中 ${fmtCount(rows.filter(r=>statusOf(r.id).state==='running').length)} 条</p></div><button class="btn primary" data-rule-new>新增规则</button></div><div class="toolbar toolbar4"><input class="input" data-filter="rules.q" placeholder="搜索名称 / 端口 / 目标 / 节点" value="${esc(state.filters.rules.q)}"><select data-filter="rules.node"><option value="all">全部节点</option>${nodeOpts}</select><select data-filter="rules.protocol"><option value="all" ${state.filters.rules.protocol==='all'?'selected':''}>全部协议</option><option value="tcp" ${state.filters.rules.protocol==='tcp'?'selected':''}>TCP</option><option value="udp" ${state.filters.rules.protocol==='udp'?'selected':''}>UDP</option><option value="both" ${state.filters.rules.protocol==='both'?'selected':''}>TCP + UDP</option></select><select data-filter="rules.state"><option value="all" ${state.filters.rules.state==='all'?'selected':''}>全部运行状态</option><option value="enabled" ${state.filters.rules.state==='enabled'?'selected':''}>已启用</option><option value="running" ${state.filters.rules.state==='running'?'selected':''}>运行中</option><option value="stopped" ${state.filters.rules.state==='stopped'?'selected':''}>已停止</option><option value="error" ${state.filters.rules.state==='error'?'selected':''}>异常</option><option value="disabled" ${state.filters.rules.state==='disabled'?'selected':''}>已停用</option></select></div>${ruleTable(rows)}</div>`;
}
function ruleTable(rules) {
  if (!rules.length) return '<div class="empty">暂无匹配规则。</div>';
  return `<table class="table"><thead><tr><th>规则</th><th>节点 / 用户</th><th>监听</th><th>目标</th><th>状态</th><th>流量</th><th>操作</th></tr></thead><tbody>${rules.map(r => {
    const st = statusOf(r.id);
    return `<tr><td><b>${esc(r.name)}</b><div class="muted">${esc(r.description || '无备注')}</div></td><td>${esc(nodeName(r.node_id))}<div class="muted">${esc(ownerName(r.user_id))}</div></td><td>${protocolText(r.protocol)} <b>:${r.listen_port}</b></td><td>${esc(r.target_host)}:${r.target_port}</td><td>${r.enabled ? statusBadge(st) : badge('off','已停用')}${st.last_error?`<div class="danger-text">${esc(st.last_error)}</div>`:''}</td><td><b>${fmtBytes(r.traffic_used)}</b>${r.traffic_limit?`<div class="muted">上限 ${fmtBytes(r.traffic_limit)}</div><div class="bar"><i style="width:${pct(r.traffic_used,r.traffic_limit)}%"></i></div>`:''}</td><td><div class="row-actions"><button class="btn" data-rule-detail="${esc(r.id)}">详情</button><button class="btn" data-rule-test="${esc(r.id)}">检测</button><button class="btn" data-rule-edit="${esc(r.id)}">编辑</button><button class="btn ${r.enabled?'danger':'primary'}" data-rule-toggle="${esc(r.id)}" data-enabled="${!r.enabled}">${r.enabled?'停用':'启用'}</button><button class="btn danger" data-rule-delete="${esc(r.id)}">删除</button></div></td></tr>`;
  }).join('')}</tbody></table>`;
}

function tokensPage() {
  if (!isAdmin()) return `<div class="card empty">需要管理员权限。</div>`;
  return `<div class="section card"><div class="section-head"><h2>节点接入</h2><button class="btn primary" data-action="create-token">生成接入 Token</button></div><p class="muted">生成 Token 后，在转发节点服务器上执行安装命令。Token 默认 24 小时内有效且只能使用一次。</p><p class="muted">Agent 安装脚本会自动识别当前 SSH 端口，并在严格防火墙模式下保留该端口。救援命令：<code>relayguard-agent firewall rescue</code></p><div id="tokenBox"></div></div>`;
}
async function createToken() {
  modal(`
    <div class="modal-head">
      <div>
        <h2>生成节点接入 Token</h2>
        <p>生成后只显示一次，请立即复制到节点服务器执行。</p>
      </div>
      <button class="ghost" data-action="close-modal">关闭</button>
    </div>

    <form id="tokenForm" class="form-grid">
      <label>节点名称
        <input name="name" value="新转发节点" placeholder="例如：香港-01 / 洛杉矶-01" required>
      </label>

      <label>有效期
        <select name="hours">
          <option value="1">1 小时</option>
          <option value="6">6 小时</option>
          <option value="24" selected>24 小时</option>
          <option value="72">3 天</option>
          <option value="168">7 天</option>
        </select>
      </label>

      <div class="hint full">
        Token 只能使用一次。Agent 注册成功后会改用节点密钥进行签名心跳。
      </div>

      <div class="actions full">
        <button type="submit">生成 Token</button>
        <button type="button" class="ghost" data-action="close-modal">取消</button>
      </div>
    </form>

    <div id="tokenResult" class="token-result"></div>
  `);

  $('#tokenForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    const name = (fd.name || '新转发节点').trim();
    const hours = Number(fd.hours || 24);

    try {
      const d = await api('/api/node-tokens', {
        method: 'POST',
        body: JSON.stringify({ name, hours })
      });

      const origin = location.origin;
      const token = d.item.plain_token;
      const cmd = `curl -fsSL ${origin}/api/agent/install.sh | bash -s -- --panel ${origin} --token ${token}`;

      $('#tokenResult').innerHTML = `
        <div class="result-card">
          <div class="result-title">一次性 Token</div>
          <textarea readonly onclick="this.select()">${esc(token)}</textarea>
        </div>

        <div class="result-card">
          <div class="result-title">节点安装命令</div>
          <textarea readonly onclick="this.select()">${esc(cmd)}</textarea>
        </div>

        <div class="hint">
          点击文本框即可全选。Token 只显示一次，请妥善保存。
        </div>
      `;

      toast('Token 已生成');
      await refreshAll();
    } catch (err) {
      toast(err.message);
    }
  });
}



function usersPage() {
  if (!isAdmin()) return `<div class="card empty">需要管理员权限。</div>`;
  return `<div class="section card"><div class="section-head"><h2>用户管理</h2><button class="btn primary" data-user-new>新增用户</button></div>${userTable()}</div>`;
}
function userTable() {
  if (!state.users.length) return '<div class="empty">暂无用户。</div>';
  return `<table class="table"><thead><tr><th>用户</th><th>角色</th><th>规则额度</th><th>流量额度</th><th>端口范围</th><th>到期</th><th>状态</th><th>操作</th></tr></thead><tbody>${state.users.map(u => `<tr><td><b>${esc(u.username)}</b><div class="muted">${esc(u.id)}</div></td><td>${roleText(u.role)}</td><td>${u.rule_limit || '不限'}</td><td>${fmtBytes(u.traffic_used)}${u.traffic_limit?` / ${fmtBytes(u.traffic_limit)}`:' / 不限'}${u.traffic_limit?`<div class="bar"><i style="width:${pct(u.traffic_used,u.traffic_limit)}%"></i></div>`:''}</td><td>${u.port_range_start || '-'} - ${u.port_range_end || '-'}</td><td>${fmtShortDate(u.expires_at)}</td><td>${u.disabled?badge('err','禁用'):badge('ok','正常')}${u.must_change?badge('warn','需改密'):''}</td><td><div class="row-actions"><button class="btn" data-user-edit="${esc(u.id)}">编辑</button>${u.id!==state.user?.id?`<button class="btn danger" data-user-delete="${esc(u.id)}">删除</button>`:''}</div></td></tr>`).join('')}</tbody></table>`;
}

function auditPage() {
  const c = $('#content');
  c.innerHTML = `<div class="section card"><div class="section-head"><h2>审计日志</h2><button class="btn" data-action="load-audit">刷新日志</button></div><div id="auditBox" class="empty">正在加载...</div></div>`;
  loadAudit();
}
async function loadAudit() {
  try {
    const d = await api('/api/audit-logs?limit=100');
    const items = d.items || [];
    $('#auditBox').innerHTML = items.length ? `<table class="table"><thead><tr><th>时间</th><th>用户</th><th>动作</th><th>目标</th><th>IP</th><th>详情</th></tr></thead><tbody>${items.map(x => `<tr><td>${fmtDate(x.created_at)}</td><td>${esc(x.user_id)}</td><td>${esc(x.action)}</td><td>${esc(x.target)}</td><td>${esc(x.ip)}</td><td>${esc(x.detail)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">暂无审计日志。</div>';
  } catch(e) { $('#auditBox').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

function backupPage() {
  const c = $('#content');
  c.innerHTML = `<div class="section card"><div class="section-head"><h2>备份恢复</h2><div class="row-actions"><button class="btn primary" data-action="create-backup">立即备份</button><button class="btn" data-action="load-backups">刷新</button></div></div><p class="muted">当前版本使用 SQLite 数据库存储。恢复会先校验备份，再自动生成“恢复前备份”，如果替换数据库失败会尝试回滚。</p><div class="card warn-card"><b>恢复提醒：</b> 恢复数据库可能导致当前登录会话失效，恢复成功后如被退出，请重新登录。</div><div id="backupBox" class="empty">正在加载...</div></div>`;
  loadBackups();
}
async function loadBackups() {
  try {
    const d = await api('/api/backups');
    const items = d.items || [];
    $('#backupBox').innerHTML = items.length ? `<table class="table"><thead><tr><th>文件名</th><th>大小</th><th>时间</th><th>操作</th></tr></thead><tbody>${items.map(x => `<tr><td><b>${esc(x.name)}</b></td><td>${fmtBytes(x.size)}</td><td>${fmtDate(x.mod_time || x.created_at)}</td><td><button class="btn danger" data-backup-restore="${esc(x.name)}">恢复</button></td></tr>`).join('')}</tbody></table>` : '<div class="empty">暂无备份。</div>';
  } catch(e) { $('#backupBox').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
async function createBackup() { try { await api('/api/backups', { method:'POST' }); toast('备份已创建', 'success'); await loadBackups(); } catch(e) { toast(e.message, 'error'); } }
async function restoreBackup(name) {
  const confirmText = prompt(`恢复备份 ${name} 会覆盖当前数据库。请输入：确认恢复`);
  if (confirmText !== '确认恢复') { toast('已取消恢复'); return; }
  try { const d = await api(`/api/backups/${encodeURIComponent(name)}/restore`, { method:'POST' }); toast(d.message || '恢复完成'); await refreshAll(); render(); } catch(e) { toast(e.message, 'error'); }
}

function accountPage() {
  const c = $('#content');
  c.innerHTML = `${state.user?.must_change?'<div class="card warn-card"><b>必须修改初始密码：</b> 当前账号使用首次随机密码，修改后才能继续使用面板。</div>':''}<div class="grid2"><div class="card"><h2>修改密码</h2><form id="passwordForm"><div class="field"><label>当前密码</label><input class="input" type="password" name="old_password" autocomplete="current-password" required></div><div class="field"><label>新密码</label><input class="input" type="password" name="new_password" autocomplete="new-password" minlength="8" required></div><button class="btn primary">保存新密码</button></form></div><div class="card"><h2>两步验证</h2><p>当前状态：${state.user?.totp_enabled?badge('ok','已启用'):badge('off','未启用')}</p><p class="muted">使用 1Password、Bitwarden、Microsoft Authenticator、Google Authenticator 等应用添加 TOTP。</p><div class="row-actions">${state.user?.totp_enabled?'<button class="btn danger" data-action="disable-totp">关闭两步验证</button>':'<button class="btn primary" data-action="setup-totp">设置两步验证</button>'}</div><div id="totpBox"></div></div></div><div class="section card"><div class="section-head"><h2>登录会话</h2><div class="row-actions"><button class="btn" data-action="load-sessions">刷新</button><button class="btn danger" data-action="logout-others">退出其他会话</button></div></div><div id="sessionsBox" class="empty">正在加载...</div></div>`;
  bindPasswordForm(); loadSessions();
}
function bindPasswordForm() {
  $('#passwordForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    try { const d = await api('/api/account/password', { method:'POST', body: JSON.stringify(body) }); state.user = d.user; toast('密码已修改', 'success'); await refreshAll(); render(); } catch(err) { toast(err.message, 'error'); }
  });
}
async function setupTOTP() {
  try {
    const d = await api('/api/account/totp/setup', { method:'POST' });
    $('#totpBox').innerHTML = `<div class="field"><label>TOTP 密钥</label><div class="codebox">${esc(d.secret)}</div></div><div class="field"><label>otpauth URI</label><div class="codebox">${esc(d.uri)}</div></div><form id="totpEnableForm"><div class="field"><label>输入认证器中的 6 位验证码</label><input class="input" name="code" inputmode="numeric" required></div><button class="btn primary">确认启用</button></form>`;
    $('#totpEnableForm').addEventListener('submit', async e => {
      e.preventDefault();
      const code = new FormData(e.target).get('code');
      try { const out = await api('/api/account/totp/enable', { method:'POST', body: JSON.stringify({ secret: d.secret, code }) }); state.user = out.user; toast('两步验证已启用', 'success'); accountPage(); } catch(err) { toast(err.message, 'error'); }
    });
  } catch(e) { toast(e.message, 'error'); }
}
async function disableTOTP() {
  const password = prompt('请输入当前密码以关闭两步验证'); if (password === null) return;
  const code = prompt('请输入当前 6 位动态验证码'); if (code === null) return;
  try { const d = await api('/api/account/totp/disable', { method:'POST', body: JSON.stringify({ password, code }) }); state.user = d.user; toast('两步验证已关闭', 'success'); accountPage(); } catch(e) { toast(e.message, 'error'); }
}
async function loadSessions() {
  try { const d = await api('/api/account/sessions'); state.sessions = d.items || []; $('#sessionsBox').innerHTML = sessionTable(); } catch(e) { $('#sessionsBox').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
function sessionTable() {
  if (!state.sessions.length) return '<div class="empty">暂无会话。</div>';
  return `<table class="table"><thead><tr><th>来源 IP</th><th>浏览器</th><th>创建时间</th><th>过期时间</th></tr></thead><tbody>${state.sessions.map(x => `<tr><td>${esc(x.ip || '-')}</td><td>${esc(x.user_agent || '-')}</td><td>${fmtDate(x.created_at)}</td><td>${fmtDate(x.expires_at)}</td></tr>`).join('')}</tbody></table>`;
}
async function logoutOthers() { if (!confirm('确认退出当前账号的其他登录会话？')) return; try { await api('/api/account/sessions/logout-others', { method:'POST' }); toast('其他会话已退出', 'success'); await loadSessions(); } catch(e) { toast(e.message, 'error'); } }

function securityPage() {
  return `<div class="grid2"><div class="card"><h2>安全设计说明</h2><p>RelayGuard Agent 默认使用主动心跳模式，不需要面板保存节点 SSH 密钥。节点注册使用一次性 Token，注册后使用节点密钥进行 HMAC 签名。</p><p>面板支持登录失败限速、TOTP 两步验证、会话管理、SQLite 备份恢复和审计日志。</p></div><div class="card"><h2>防火墙托管说明</h2><p><b>宽松模式</b>只自动放行启用中的转发端口；<b>严格待确认</b>会先按严格策略应用 60 秒，面板确认后才长期保持；未确认会由 Agent 自动回滚。</p><p>节点本地救援命令：<code>relayguard-agent firewall rescue</code></p></div></div>`;
}

function showNodeDetail(id) {
  const n = byID(state.nodes, id); if (!n) return;
  const rules = state.rules.filter(r => r.node_id === id);
  const m = n.last_metrics || {};
  modal(`<div class="modal-head"><div><div class="kicker">Node Detail</div><h2>节点详情：${esc(n.name)}</h2></div><button class="btn ghost" data-action="close-modal">关闭</button></div><div class="detail-grid"><div class="card soft"><h3>基础信息</h3><p>状态：${nodeBadge(n)}</p><p>公网 IP：${esc(n.public_ip || '-')}</p><p>主机名：${esc(n.hostname || '-')}</p><p>系统：${esc(n.os || '-')} / ${esc(n.arch || '-')}</p><p>Agent：${esc(n.agent_version || '-')}</p><p>最近心跳：${fmtDate(n.last_seen_at)}</p></div><div class="card soft"><h3>资源状态</h3><p>CPU：${Math.round(m.cpu_percent || 0)}%</p><div class="bar"><i style="width:${Math.min(100, Math.round(m.cpu_percent || 0))}%"></i></div><p>内存：${fmtBytes(m.memory_used)} / ${fmtBytes(m.memory_total)}</p><div class="bar"><i style="width:${pct(m.memory_used,m.memory_total)}%"></i></div><p>磁盘：${fmtBytes(m.disk_used)} / ${fmtBytes(m.disk_total)}</p><div class="bar"><i style="width:${pct(m.disk_used,m.disk_total)}%"></i></div></div><div class="card soft"><h3>网络与防火墙</h3><p>防火墙：${firewallText(n)}</p><p>模式：${esc(n.firewall_mode || 'loose')}</p><p>端口范围：${n.port_range_start || '-'} - ${n.port_range_end || '-'}</p><p>私网 IP：${esc((n.private_ips || []).join(', ') || '-')}</p>${n.firewall_error?`<p class="danger-text">${esc(n.firewall_error)}</p>`:''}${n.last_error?`<p class="danger-text">${esc(n.last_error)}</p>`:''}</div><div class="card soft"><h3>节点规则</h3><p>规则数：${rules.length}</p><p>运行中：${rules.filter(r=>statusOf(r.id).state==='running').length}</p><p>累计流量：${fmtBytes(rules.reduce((s,r)=>s+Number(r.traffic_used||0),0))}</p></div></div><h3>该节点转发规则</h3>${ruleTable(rules)}`, 'drawer');
}
async function showRuleDetail(id) {
  const r = byID(state.rules, id); if (!r) return;
  const st = statusOf(id);
  modal(`<div class="modal-head"><div><div class="kicker">Rule Detail</div><h2>规则详情：${esc(r.name)}</h2></div><button class="btn ghost" data-action="close-modal">关闭</button></div><div class="detail-grid"><div class="card soft"><h3>转发信息</h3><p>协议：${protocolText(r.protocol)}</p><p>监听：${esc(nodeName(r.node_id))} :${r.listen_port}</p><p>目标：${esc(r.target_host)}:${r.target_port}</p><p>来源白名单：${esc((r.source_cidrs || []).join(', ') || '不限')}</p></div><div class="card soft"><h3>运行状态</h3><p>${r.enabled ? statusBadge(st) : badge('off','已停用')}</p><p>活跃连接：${fmtCount(st.active_connections)}</p><p>最近更新：${fmtDate(st.updated_at)}</p>${st.last_error?`<p class="danger-text">${esc(st.last_error)}</p>`:''}</div><div class="card soft"><h3>限额策略</h3><p>规则流量：${fmtBytes(r.traffic_used)}${r.traffic_limit?` / ${fmtBytes(r.traffic_limit)}`:' / 不限'}</p>${r.traffic_limit?`<div class="bar"><i style="width:${pct(r.traffic_used,r.traffic_limit)}%"></i></div>`:''}<p>限速：${r.speed_limit_mbps || 0} Mbps</p><p>最大连接：${r.max_connections || '不限'}</p><p>到期：${fmtShortDate(r.expire_at)}</p></div><div class="card soft"><h3>归属</h3><p>用户：${esc(ownerName(r.user_id))}</p><p>节点：${esc(nodeName(r.node_id))}</p><p>防火墙自动开放：${r.firewall_managed===false?'否':'是'}</p><p>创建：${fmtDate(r.created_at)}</p></div></div><div class="section-head"><h3>检测历史</h3><button class="btn" data-rule-test="${esc(r.id)}">立即检测</button></div><div id="ruleTestHistory" class="empty">正在加载检测历史...</div>`, 'drawer');
  loadRuleTestHistory(id);
}
async function loadRuleTestHistory(id) {
  const box = $('#ruleTestHistory'); if (!box) return;
  try {
    const d = await api(`/api/connectivity-tests?rule_id=${encodeURIComponent(id)}&limit=20`);
    const items = d.items || [];
    box.innerHTML = items.length ? `<table class="table compact"><thead><tr><th>时间</th><th>状态</th><th>本地监听</th><th>目标 TCP</th><th>UDP</th><th>Ping</th><th>错误</th></tr></thead><tbody>${items.map(x => `<tr><td>${fmtDate(x.created_at)}</td><td>${testStatusBadge(x)}</td><td>${x.local_listen_ok?'正常':'-'}</td><td>${x.target_tcp_ok?'正常':'-'}</td><td>${x.target_udp_ok?'已发送':'-'}</td><td>${x.ping_ok?`${x.ping_latency_ms||0} ms`:'-'}</td><td>${esc(x.error || '')}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">暂无检测历史。</div>';
  } catch(e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

function ruleModal(r = {}) {
  const nodes = state.nodes.map(n => `<option value="${esc(n.id)}" ${r.node_id===n.id?'selected':''}>${esc(n.name)}</option>`).join('');
  const ownerOptions = isAdmin() ? `<div class="field"><label>所属用户</label><select name="user_id">${state.users.map(u => `<option value="${esc(u.id)}" ${(r.user_id || state.user?.id) === u.id ? 'selected' : ''}>${esc(u.username)}（${roleText(u.role)}）</option>`).join('')}</select></div>` : '';
  modal(`<div class="modal-head"><h2>${r.id?'编辑':'新增'}转发规则</h2><button class="btn ghost" data-action="close-modal">关闭</button></div><form id="ruleForm"><div class="grid2"><div class="field"><label>规则名称</label><input class="input" name="name" value="${esc(r.name || '')}" required></div><div class="field"><label>节点</label><select name="node_id" required>${nodes}</select></div></div>${ownerOptions}<div class="grid3"><div class="field"><label>协议</label><select name="protocol"><option value="tcp" ${r.protocol==='tcp'?'selected':''}>TCP</option><option value="udp" ${r.protocol==='udp'?'selected':''}>UDP</option><option value="both" ${r.protocol==='both'?'selected':''}>TCP + UDP</option></select></div><div class="field"><label>监听端口</label><input class="input" name="listen_port" type="number" value="${r.listen_port || 20000}" required></div><div class="field"><label>目标端口</label><input class="input" name="target_port" type="number" value="${r.target_port || 80}" required></div></div><div class="field"><label>目标地址</label><input class="input" name="target_host" value="${esc(r.target_host || '')}" placeholder="例如 1.2.3.4 或 example.com" required></div><div class="grid3"><div class="field"><label>限速 Mbps（0 不限制）</label><input class="input" name="speed_limit_mbps" type="number" value="${r.speed_limit_mbps || 0}"></div><div class="field"><label>最大连接数（0 不限制）</label><input class="input" name="max_connections" type="number" value="${r.max_connections || 0}"></div><div class="field"><label>启用</label><select name="enabled"><option value="true" ${r.enabled?'selected':''}>启用</option><option value="false" ${!r.enabled?'selected':''}>停用</option></select></div></div><div class="grid2"><div class="field"><label>规则流量上限 GB（0 不限）</label><input class="input" name="traffic_limit_gb" type="number" step="0.1" value="${r.traffic_limit ? r.traffic_limit / 1024 / 1024 / 1024 : 0}"></div><div class="field"><label>到期日期</label><input class="input" name="expire_at" type="date" value="${r.expire_at ? new Date(r.expire_at).toISOString().slice(0,10) : ''}"></div></div><div class="field"><label>来源 IP/CIDR 白名单（逗号分隔，可留空）</label><input class="input" name="source_cidrs" value="${esc((r.source_cidrs || []).join(','))}"></div><div class="field"><label>备注</label><textarea name="description">${esc(r.description || '')}</textarea></div><button class="btn primary">保存</button></form>`);
  $('#ruleForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    let exp = null;
    if (fd.expire_at) { const d = new Date(fd.expire_at); d.setHours(23,59,59,999); exp = d.toISOString(); }
    const payload = { ...r, ...fd, user_id: isAdmin() ? fd.user_id : (r.user_id || state.user?.id), listen_port:+fd.listen_port, target_port:+fd.target_port, speed_limit_mbps:+fd.speed_limit_mbps, max_connections:+fd.max_connections, traffic_limit:Math.round((+fd.traffic_limit_gb || 0) * 1024 * 1024 * 1024), expire_at:exp, enabled:fd.enabled === 'true', firewall_managed:true, source_cidrs:fd.source_cidrs ? fd.source_cidrs.split(',').map(x=>x.trim()).filter(Boolean) : [] };
    delete payload.traffic_limit_gb;
    try { await api(r.id ? `/api/rules/${r.id}` : '/api/rules', { method: r.id ? 'PUT' : 'POST', body: JSON.stringify(payload) }); closeModal(); await refreshClick(); } catch(err) { toast(err.message, 'error'); }
  });
}
function editNode(n) {
  modal(`<div class="modal-head"><h2>节点设置</h2><button class="btn ghost" data-action="close-modal">关闭</button></div><form id="nodeForm"><div class="field"><label>节点名称</label><input class="input" name="name" value="${esc(n.name || '')}"></div><div class="grid3"><div class="field"><label>端口范围开始</label><input class="input" name="port_range_start" type="number" value="${n.port_range_start || 20000}"></div><div class="field"><label>端口范围结束</label><input class="input" name="port_range_end" type="number" value="${n.port_range_end || 50000}"></div><div class="field"><label>最大规则数（0 不限）</label><input class="input" name="max_rules" type="number" value="${n.max_rules || 0}"></div></div><div class="field"><label>防火墙托管模式</label><select name="firewall_mode"><option value="off" ${n.firewall_mode==='off'?'selected':''}>关闭托管：Agent 不管理防火墙</option><option value="loose" ${(n.firewall_mode || 'loose') === 'loose' ? 'selected' : ''}>宽松托管：自动放行转发端口</option><option value="strict" ${n.firewall_mode==='strict'?'selected':''}>严格托管：先进入 60 秒待确认</option></select><p class="muted">严格模式会先进入“严格待确认”，请在节点列表点击“确认严格”。60 秒内未确认时 Agent 会自动回滚；本地救援命令：relayguard-agent firewall rescue</p></div><button class="btn primary">保存</button></form>`);
  $('#nodeForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target)); fd.port_range_start=+fd.port_range_start; fd.port_range_end=+fd.port_range_end; fd.max_rules=+fd.max_rules;
    if (fd.firewall_mode === 'strict' && n.firewall_mode !== 'strict' && !confirm('严格托管会丢弃未授权入站流量。保存后会进入 60 秒待确认，确认期间请保持当前 SSH 可用。是否继续？')) return;
    if (fd.firewall_mode === 'strict' && n.firewall_mode !== 'strict') fd.firewall_mode = 'strict-pending';
    try { await api(`/api/nodes/${n.id}`, { method:'PUT', body: JSON.stringify(fd) }); closeModal(); await refreshClick(); } catch(err) { toast(err.message, 'error'); }
  });
}
async function confirmStrict(n) {
  if (!confirm('确认该节点严格防火墙模式工作正常？确认后将长期保持严格模式。')) return;
  const payload = { name:n.name, port_range_start:n.port_range_start, port_range_end:n.port_range_end, firewall_mode:'strict', max_rules:n.max_rules || 0 };
  try { await api(`/api/nodes/${n.id}`, { method:'PUT', body: JSON.stringify(payload) }); await refreshClick(); toast('已确认严格模式', 'success'); } catch(e) { toast(e.message, 'error'); }
}
function userModal(u = {}) {
  const allowed = new Set(u.allowed_node_ids || []);
  const nodeChecks = state.nodes.map(n => `<label class="check"><input type="checkbox" name="allowed_node_ids" value="${esc(n.id)}" ${allowed.has(n.id)?'checked':''}>${esc(n.name)}</label>`).join('') || '<div class="muted">暂无节点，可留空表示不限制。</div>';
  modal(`<div class="modal-head"><h2>${u.id?'编辑':'新增'}用户</h2><button class="btn ghost" data-action="close-modal">关闭</button></div><form id="userForm"><div class="grid2"><div class="field"><label>用户名</label><input class="input" name="username" value="${esc(u.username || '')}" required></div><div class="field"><label>角色</label><select name="role"><option value="user" ${u.role==='user'?'selected':''}>普通用户</option><option value="admin" ${u.role==='admin'?'selected':''}>管理员</option><option value="super_admin" ${u.role==='super_admin'?'selected':''}>超级管理员</option></select></div></div><div class="field"><label>密码${u.id?'（留空不修改）':''}</label><input class="input" name="password" type="password" ${u.id?'':'required'} minlength="8"></div><div class="grid3"><div class="field"><label>规则数量上限（0 不限）</label><input class="input" name="rule_limit" type="number" value="${u.rule_limit || 0}"></div><div class="field"><label>总流量额度 GB（0 不限）</label><input class="input" name="traffic_limit_gb" type="number" step="0.1" value="${u.traffic_limit ? u.traffic_limit/1024/1024/1024 : 0}"></div><div class="field"><label>到期日期</label><input class="input" name="expires_at" type="date" value="${u.expires_at ? new Date(u.expires_at).toISOString().slice(0,10) : ''}"></div></div><div class="grid3"><div class="field"><label>端口范围开始（0 不限）</label><input class="input" name="port_range_start" type="number" value="${u.port_range_start || 0}"></div><div class="field"><label>端口范围结束（0 不限）</label><input class="input" name="port_range_end" type="number" value="${u.port_range_end || 0}"></div><div class="field"><label>账号状态</label><select name="disabled"><option value="false" ${!u.disabled?'selected':''}>正常</option><option value="true" ${u.disabled?'selected':''}>禁用</option></select></div></div><div class="field"><label>允许使用的节点（全不选表示不限制）</label><div class="check-grid">${nodeChecks}</div></div><label class="check"><input type="checkbox" name="must_change" value="true" ${u.must_change?'checked':''}> 下次登录必须修改密码</label><button class="btn primary">保存</button></form>`);
  $('#userForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = { id:u.id, username:fd.get('username'), password:fd.get('password') || '', role:fd.get('role'), rule_limit:+fd.get('rule_limit'), traffic_limit:Math.round((+fd.get('traffic_limit_gb') || 0) * 1024 * 1024 * 1024), port_range_start:+fd.get('port_range_start'), port_range_end:+fd.get('port_range_end'), expires_at:fd.get('expires_at') || '', disabled:fd.get('disabled') === 'true', must_change:fd.get('must_change') === 'true', allowed_node_ids:fd.getAll('allowed_node_ids') };
    try { await api(u.id ? `/api/users/${u.id}` : '/api/users', { method: u.id ? 'PUT' : 'POST', body: JSON.stringify(payload) }); closeModal(); await refreshClick(); } catch(err) { toast(err.message, 'error'); }
  });
}

function testStatusBadge(x) { if (!x) return ''; const cls = x.status === 'success' ? 'ok' : x.status === 'failed' ? 'err' : x.status === 'running' ? 'warn' : 'off'; const txt = { queued:'排队中', running:'检测中', success:'通过', failed:'失败' }[x.status] || x.status; return badge(cls, txt); }
function testResultHTML(x) {
  if (!x) return `<div class="empty">等待检测结果...</div>`;
  const details = (x.details || []).map(d => `<li>${esc(d)}</li>`).join('');
  return `<div class="card soft"><h3>检测状态：${testStatusBadge(x)}</h3><p class="muted">规则：${esc(x.rule_id)} · 节点：${esc(x.node_id)}</p><div class="grid2"><div>本地监听：${x.local_listen_ok?'正常':'未确认'}</div><div>目标 TCP：${x.target_tcp_ok?'正常':'未确认'}</div><div>目标 UDP：${x.target_udp_ok?'已发送':'未确认'}</div><div>Ping：${x.ping_ok ? `${x.ping_latency_ms || 0} ms` : '未通过或不可用'}</div></div>${x.error?`<p class="danger-text">${esc(x.error)}</p>`:''}<ul>${details}</ul><p class="muted">创建：${fmtDate(x.created_at)} · 完成：${fmtDate(x.finished_at)}</p></div>`;
}
async function testRule(id) {
  try {
    const d = await api(`/api/rules/${id}/test`, { method:'POST' });
    modal(`<div class="modal-head"><h2>连通性检测</h2><button class="btn ghost" data-action="close-modal">关闭</button></div><div id="testResultBox">${testResultHTML(d.item)}</div><p class="muted">检测由对应节点 Agent 执行，通常需要等待 1-2 次心跳周期。</p>`);
    pollConnectivityTest(d.item.id, 0);
    toast(d.message || '已提交检测');
  } catch(e) { toast(e.message, 'error'); }
}
async function pollConnectivityTest(id, count) {
  if (count > 20) return;
  try {
    const d = await api(`/api/connectivity-tests?id=${encodeURIComponent(id)}&limit=1`);
    const item = (d.items || [])[0];
    const box = $('#testResultBox'); if (box) box.innerHTML = testResultHTML(item);
    if (item && ['queued','running'].includes(item.status)) setTimeout(() => pollConnectivityTest(id, count + 1), 3000);
  } catch(e) { const box = $('#testResultBox'); if (box) box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
async function toggleRule(id, enabled) { try { await api(`/api/rules/${id}/toggle`, { method:'POST', body: JSON.stringify({ enabled }) }); await refreshClick(); } catch(e) { toast(e.message, 'error'); } }
async function deleteRule(id) { if (!confirm('确认删除该规则？')) return; try { await api(`/api/rules/${id}`, { method:'DELETE' }); await refreshClick(); } catch(e) { toast(e.message, 'error'); } }
async function deleteNode(id) { if (!confirm('删除节点会同时删除该节点规则，确认？')) return; try { await api(`/api/nodes/${id}`, { method:'DELETE' }); await refreshClick(); } catch(e) { toast(e.message, 'error'); } }
async function deleteUser(id) { if (!confirm('确认删除该用户？该用户规则会被停用。')) return; try { await api(`/api/users/${id}`, { method:'DELETE' }); await refreshClick(); } catch(e) { toast(e.message, 'error'); } }
async function logout() { await api('/api/auth/logout', { method:'POST' }).catch(()=>{}); state.user = null; renderLogin(); }
function modal(html, type = 'modal') {
  closeModal();
  const m = document.createElement('div');
  m.className = `modal-mask ${type === 'drawer' ? 'drawer-mask' : ''}`;
  m.id = 'modalMask';
  m.innerHTML = `<div class="${type === 'drawer' ? 'drawer' : 'modal'}">${html}</div>`;
  document.body.appendChild(m);
  requestAnimationFrame(() => m.classList.add('show'));
}

function closeModal() {
  const m = $('#modalMask');
  if (!m) return;
  m.classList.remove('show');
  setTimeout(() => m.remove(), 180);
}


document.addEventListener('click', async e => {
  const el = e.target.closest('button, [data-page], [data-action], [data-rule-detail], [data-node-detail], [data-backup-restore]');
  if (!el) return;
  if (el.dataset.page) { state.page = el.dataset.page; render(); return; }
  const action = el.dataset.action;
  if (action === 'refresh') return refreshClick();
  if (action === 'logout') return logout();
  if (action === 'close-modal') return closeModal();
  if (action === 'create-token') return createToken();
  if (action === 'load-audit') return loadAudit();
  if (action === 'create-backup') return createBackup();
  if (action === 'load-backups') return loadBackups();
  if (action === 'setup-totp') return setupTOTP();
  if (action === 'disable-totp') return disableTOTP();
  if (action === 'load-sessions') return loadSessions();
  if (action === 'logout-others') return logoutOthers();
  if (el.dataset.ruleNew !== undefined) return ruleModal();
  if (el.dataset.ruleDetail) return showRuleDetail(el.dataset.ruleDetail);
  if (el.dataset.ruleTest) return testRule(el.dataset.ruleTest);
  if (el.dataset.ruleEdit) return ruleModal(byID(state.rules, el.dataset.ruleEdit));
  if (el.dataset.ruleToggle) return toggleRule(el.dataset.ruleToggle, el.dataset.enabled === 'true');
  if (el.dataset.ruleDelete) return deleteRule(el.dataset.ruleDelete);
  if (el.dataset.nodeDetail) return showNodeDetail(el.dataset.nodeDetail);
  if (el.dataset.nodeEdit) return editNode(byID(state.nodes, el.dataset.nodeEdit));
  if (el.dataset.nodeConfirm) return confirmStrict(byID(state.nodes, el.dataset.nodeConfirm));
  if (el.dataset.nodeDelete) return deleteNode(el.dataset.nodeDelete);
  if (el.dataset.userNew !== undefined) return userModal();
  if (el.dataset.userEdit) return userModal(byID(state.users, el.dataset.userEdit));
  if (el.dataset.userDelete) return deleteUser(el.dataset.userDelete);
  if (el.dataset.backupRestore) return restoreBackup(el.dataset.backupRestore);
});

document.addEventListener('input', e => {
  const key = e.target.dataset?.filter; if (!key) return;
  const [group, name] = key.split('.');
  state.filters[group][name] = e.target.value;
  clearTimeout(state.ui.filterTimer);
  state.ui.filterTimer = setTimeout(renderContent, 140);
});
document.addEventListener('change', e => {
  const key = e.target.dataset?.filter; if (!key) return;
  const [group, name] = key.split('.'); state.filters[group][name] = e.target.value; renderContent();
});
document.addEventListener('click', e => { if (e.target?.id === 'modalMask') closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

init();
