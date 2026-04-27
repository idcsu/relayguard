import React, { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { api } from './api';
import type { BackupItem, ConnectivityTest, NodeItem, RuleItem, RuleStatus, SessionItem, User } from './types';
import { cn, firewallStatus, fmtBytes, fmtDate, fmtShortDate, online, pct, protocolText, roleText, statusText } from './utils';

type Page = 'dashboard' | 'nodes' | 'rules' | 'users' | 'tokens' | 'audit' | 'backup' | 'account' | 'security';
type Toast = { id: number; text: string; tone?: 'ok' | 'warn' | 'danger' };

type ModalState =
  | null
  | { kind: 'node'; node: NodeItem }
  | { kind: 'rule'; rule?: RuleItem }
  | { kind: 'rule-detail'; rule: RuleItem }
  | { kind: 'node-detail'; node: NodeItem }
  | { kind: 'token' }
  | { kind: 'user'; user?: User }
  | { kind: 'confirm'; title: string; message: string; danger?: boolean; onConfirm: () => void | Promise<void> }
  | { kind: 'totp' };

const navs: Array<[Page, string, string]> = [
  ['dashboard', '仪表盘', '⌁'],
  ['nodes', '节点管理', '◈'],
  ['rules', '转发规则', '⇄'],
  ['users', '用户管理', '◎'],
  ['tokens', '节点接入', '＋'],
  ['audit', '审计日志', '≡'],
  ['backup', '备份恢复', '◫'],
  ['account', '账号安全', '◉'],
  ['security', '安全说明', '盾']
];

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [version, setVersion] = useState('');
  const [page, setPage] = useState<Page>('dashboard');
  const [nodes, setNodes] = useState<NodeItem[]>([]);
  const [rules, setRules] = useState<RuleItem[]>([]);
  const [statuses, setStatuses] = useState<Record<string, RuleStatus>>({});
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [modal, setModal] = useState<ModalState>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [filters, setFilters] = useState({ nodes: { q: '', status: 'all' }, rules: { q: '', node: 'all', protocol: 'all', state: 'all' } });

  const isAdmin = !!user && ['super_admin', 'admin'].includes(user.role);
  const statusOf = useCallback((id: string) => statuses[id] || {}, [statuses]);
  const nodeName = useCallback((id?: string) => nodes.find(n => n.id === id)?.name || id || '-', [nodes]);
  const ownerName = useCallback((id?: string) => users.find(u => u.id === id)?.username || (id === user?.id ? user.username : id || '-'), [users, user]);

  const toast = useCallback((text: string, tone: Toast['tone'] = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts(t => [...t, { id, text, tone }]);
    window.setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3600);
  }, []);

  const refreshAll = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const base: Array<Promise<any>> = [api('/api/dashboard'), api('/api/nodes'), api('/api/rules')];
      if (isAdmin) base.push(api('/api/users'));
      const [_, nodeRes, ruleRes, userRes] = await Promise.all(base);
      setNodes(nodeRes.items || []);
      setRules(ruleRes.items || []);
      setStatuses(ruleRes.statuses || {});
      if (userRes) setUsers(userRes.items || []);
    } finally {
      if (!silent) setRefreshing(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    (async () => {
      try {
        const me = await api<{ user: User; version: string }>('/api/me');
        setUser(me.user);
        setVersion(me.version || '');
        if (me.user?.must_change) setPage('account');
      } catch {
        setUser(null);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => { if (user) refreshAll(true).catch(e => toast(e.message, 'danger')); }, [user, refreshAll, toast]);

  const filteredNodes = useMemo(() => nodes.filter(n => {
    const q = filters.nodes.q.toLowerCase();
    const hay = `${n.name} ${n.hostname || ''} ${n.public_ip || ''} ${n.os || ''}`.toLowerCase();
    if (q && !hay.includes(q)) return false;
    if (filters.nodes.status !== 'all' && (filters.nodes.status === 'online') !== online(n)) return false;
    return true;
  }), [nodes, filters.nodes]);

  const filteredRules = useMemo(() => rules.filter(r => {
    const st = statusOf(r.id);
    const q = filters.rules.q.toLowerCase();
    const hay = `${r.name} ${r.listen_port} ${r.target_host} ${r.target_port} ${nodeName(r.node_id)} ${ownerName(r.user_id)} ${r.description || ''}`.toLowerCase();
    if (q && !hay.includes(q)) return false;
    if (filters.rules.node !== 'all' && r.node_id !== filters.rules.node) return false;
    if (filters.rules.protocol !== 'all' && r.protocol !== filters.rules.protocol) return false;
    if (filters.rules.state !== 'all') {
      const key = r.enabled ? (st.state || 'enabled') : 'disabled';
      if (filters.rules.state === 'enabled' && !r.enabled) return false;
      if (filters.rules.state !== 'enabled' && key !== filters.rules.state) return false;
    }
    return true;
  }), [rules, filters.rules, statusOf, nodeName, ownerName]);

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setUser(null);
  }

  if (loading) return <LoadingScreen />;
  if (!user) return <LoginPage onLogin={(u, v) => { setUser(u); setVersion(v || version); if (u.must_change) setPage('account'); }} toast={toast} />;

  const visibleNavs = navs.filter(([id]) => isAdmin || !['users', 'tokens', 'audit', 'backup'].includes(id));

  return <div className="min-h-screen">
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-72 border-r border-slate-200/70 bg-slate-950 text-white shadow-soft lg:block">
      <div className="p-6">
        <div className="rounded-3xl bg-white/10 p-4 ring-1 ring-white/10">
          <div className="text-2xl font-black">RelayGuard</div>
          <div className="mt-1 text-sm text-slate-300">中转卫士 · {version || 'v0.12'}</div>
        </div>
        <nav className="mt-6 grid gap-1">
          {visibleNavs.map(([id, name, icon]) => <button key={id} onClick={() => setPage(id)} className={cn('flex items-center gap-3 rounded-2xl px-4 py-3 text-left text-sm font-bold transition', page === id ? 'bg-white text-slate-950 shadow-lg' : 'text-slate-300 hover:bg-white/10 hover:text-white')}>
            <span className="grid h-8 w-8 place-items-center rounded-xl bg-white/10">{icon}</span>{name}
          </button>)}
        </nav>
      </div>
      <div className="absolute bottom-0 left-0 right-0 border-t border-white/10 p-5">
        <div className="text-sm font-bold">{user.username}</div>
        <div className="text-xs text-slate-400">{roleText(user.role)}</div>
        <button className="btn mt-4 w-full" onClick={logout}>退出登录</button>
      </div>
    </aside>

    <main className="lg:pl-72">
      <header className="sticky top-0 z-20 border-b border-slate-200/70 bg-white/70 px-5 py-4 backdrop-blur-xl lg:px-8">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-950">{pageTitle(page)}</h1>
            <p className="mt-1 text-sm text-slate-500">{pageSubtitle(page)}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn" onClick={() => refreshAll().then(() => toast('已刷新')).catch(e => toast(e.message, 'danger'))}>{refreshing ? '刷新中...' : '刷新'}</button>
            <button className="btn lg:hidden" onClick={() => setPage('dashboard')}>菜单</button>
          </div>
        </div>
      </header>

      <section className="p-5 lg:p-8 animate-fade-in">
        {page === 'dashboard' && <Dashboard nodes={nodes} rules={rules} statusOf={statusOf} />}
        {page === 'nodes' && <NodesPage nodes={filteredNodes} filters={filters.nodes} setFilters={setFilters} isAdmin={isAdmin} onDetail={n => setModal({ kind: 'node-detail', node: n })} onEdit={n => setModal({ kind: 'node', node: n })} onConfirm={n => setModal({ kind: 'confirm', title: '确认严格模式', message: '确认该节点严格防火墙模式工作正常？确认后将长期保持严格模式。', danger: true, onConfirm: async () => { await updateNode(n.id, { name: n.name, port_range_start: n.port_range_start, port_range_end: n.port_range_end, firewall_mode: 'strict', max_rules: n.max_rules || 0 }); toast('已确认严格模式，等待 Agent 下一次心跳同步状态'); await refreshAll(true); } })} onDelete={n => setModal({ kind: 'confirm', title: '删除节点', message: '删除节点会同时删除该节点规则，确认？', danger: true, onConfirm: async () => { await api(`/api/nodes/${n.id}`, { method: 'DELETE' }); toast('节点已删除'); await refreshAll(true); } })} />}
        {page === 'rules' && <RulesPage rules={filteredRules} nodes={nodes} users={users} filters={filters.rules} setFilters={setFilters} statusOf={statusOf} nodeName={nodeName} ownerName={ownerName} isAdmin={isAdmin} onNew={() => setModal({ kind: 'rule' })} onDetail={r => setModal({ kind: 'rule-detail', rule: r })} onEdit={r => setModal({ kind: 'rule', rule: r })} onTest={async r => { const d = await api<{ item: ConnectivityTest; message?: string }>(`/api/rules/${r.id}/test`, { method: 'POST' }); toast(d.message || '已提交检测'); setModal({ kind: 'rule-detail', rule: r }); }} onToggle={async r => { await api(`/api/rules/${r.id}/toggle`, { method: 'POST', body: JSON.stringify({ enabled: !r.enabled }) }); await refreshAll(true); }} onDelete={r => setModal({ kind: 'confirm', title: '删除规则', message: '确认删除该规则？', danger: true, onConfirm: async () => { await api(`/api/rules/${r.id}`, { method: 'DELETE' }); toast('规则已删除'); await refreshAll(true); } })} />}
        {page === 'users' && <UsersPage users={users} nodes={nodes} onNew={() => setModal({ kind: 'user' })} onEdit={u => setModal({ kind: 'user', user: u })} onDelete={u => setModal({ kind: 'confirm', title: '删除用户', message: '确认删除该用户？该用户规则会被停用。', danger: true, onConfirm: async () => { await api(`/api/users/${u.id}`, { method: 'DELETE' }); toast('用户已删除'); await refreshAll(true); } })} />}
        {page === 'tokens' && <TokensPage onCreate={() => setModal({ kind: 'token' })} />}
        {page === 'audit' && <AuditPage />}
        {page === 'backup' && <BackupPage toast={toast} confirm={(title, message, onConfirm) => setModal({ kind: 'confirm', title, message, danger: true, onConfirm })} />}
        {page === 'account' && <AccountPage user={user} setUser={setUser} toast={toast} openTotp={() => setModal({ kind: 'totp' })} />}
        {page === 'security' && <SecurityPage />}
      </section>
    </main>

    <ToastStack items={toasts} />
    <ModalHost modal={modal} setModal={setModal} nodes={nodes} users={users} currentUser={user} refreshAll={refreshAll} toast={toast} />
  </div>;

  async function updateNode(id: string, payload: any) { await api(`/api/nodes/${id}`, { method: 'PUT', body: JSON.stringify(payload) }); }
}

function pageTitle(page: Page) {
  return ({ dashboard: '仪表盘', nodes: '节点管理', rules: '转发规则', users: '用户管理', tokens: '节点接入', audit: '审计日志', backup: '备份恢复', account: '账号安全', security: '安全说明' } as Record<Page, string>)[page];
}
function pageSubtitle(page: Page) {
  return ({ dashboard: '查看节点、规则、流量与风险概览', nodes: '管理转发节点、端口范围和防火墙托管', rules: '创建、检测、启停和查看转发规则', users: '配置用户权限、配额、节点和端口范围', tokens: '生成节点 Agent 一次性接入命令', audit: '查看重要操作记录', backup: '创建和恢复 SQLite 数据库备份', account: '修改密码、两步验证和会话管理', security: '了解节点接入、防火墙托管和救援策略' } as Record<Page, string>)[page];
}

function LoadingScreen() { return <div className="grid min-h-screen place-items-center"><div className="card p-8 text-center"><div className="mx-auto mb-4 h-10 w-10 animate-pulse-soft rounded-full bg-blue-600" /><div className="font-black">RelayGuard 正在加载...</div></div></div>; }

function LoginPage({ onLogin, toast }: { onLogin: (u: User, v?: string) => void; toast: (m: string, t?: Toast['tone']) => void }) {
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true);
    try {
      const fd = Object.fromEntries(new FormData(e.currentTarget));
      const d = await api<{ user: User; version?: string }>('/api/auth/login', { method: 'POST', body: JSON.stringify(fd) });
      onLogin(d.user, d.version);
    } catch (err: any) { toast(err.message, 'danger'); } finally { setBusy(false); }
  }
  return <div className="grid min-h-screen place-items-center p-6">
    <div className="grid w-full max-w-5xl overflow-hidden rounded-[2rem] bg-white shadow-soft md:grid-cols-2">
      <div className="bg-slate-950 p-10 text-white">
        <div className="text-3xl font-black">RelayGuard</div><div className="mt-2 text-slate-300">中转卫士 · 安全可控的多节点端口转发面板</div>
        <div className="mt-10 grid gap-4 text-sm text-slate-300"><p>无 CDN、无远程脚本，前端构建产物内嵌到 Go 二进制。</p><p>Agent 主动心跳，节点密钥签名，防火墙严格模式支持确认回滚。</p></div>
      </div>
      <form onSubmit={submit} className="grid gap-4 p-10">
        <h1 className="text-2xl font-black">登录面板</h1>
        <label className="label">用户名<input className="input" name="username" autoComplete="username" required /></label>
        <label className="label">密码<input className="input" type="password" name="password" autoComplete="current-password" required /></label>
        <label className="label">两步验证码（未启用可留空）<input className="input" name="totp_code" inputMode="numeric" placeholder="6 位数字" /></label>
        <button className="btn btn-primary mt-2" disabled={busy}>{busy ? '登录中...' : '登录'}</button>
      </form>
    </div>
  </div>;
}

function Dashboard({ nodes, rules, statusOf }: { nodes: NodeItem[]; rules: RuleItem[]; statusOf: (id: string) => RuleStatus }) {
  const traffic = rules.reduce((s, r) => s + Number(r.traffic_used || 0), 0);
  const running = rules.filter(r => statusOf(r.id).state === 'running').length;
  const errors = rules.filter(r => statusOf(r.id).state === 'error').length;
  return <div className="grid gap-6">
    <div className="rounded-[2rem] bg-gradient-to-br from-slate-950 via-blue-950 to-indigo-900 p-8 text-white shadow-soft">
      <div className="text-sm font-bold text-blue-200">RelayGuard Console</div>
      <h2 className="mt-3 text-3xl font-black">运行状态一目了然</h2>
      <p className="mt-2 max-w-2xl text-slate-300">集中管理节点、转发规则、流量和防火墙托管。所有前端资源均来自本地构建产物。</p>
    </div>
    <div className="grid gap-4 md:grid-cols-4"><Stat title="在线节点" value={`${nodes.filter(online).length}/${nodes.length}`} /><Stat title="运行规则" value={`${running}/${rules.length}`} /><Stat title="累计流量" value={fmtBytes(traffic)} /><Stat title="异常规则" value={String(errors)} danger={errors > 0} /></div>
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="card p-5"><h3 className="font-black">节点概览</h3><div className="mt-4 grid gap-3">{nodes.slice(0, 6).map(n => <div key={n.id} className="flex items-center justify-between rounded-2xl bg-slate-50 p-3"><div><b>{n.name}</b><div className="muted">{n.public_ip || '-'} · {n.os || '-'}</div></div><Badge tone={online(n) ? 'ok' : 'muted'}>{online(n) ? '在线' : '离线'}</Badge></div>)}</div></div>
      <div className="card p-5"><h3 className="font-black">流量 Top 规则</h3><div className="mt-4 grid gap-3">{[...rules].sort((a,b)=>Number(b.traffic_used||0)-Number(a.traffic_used||0)).slice(0,6).map(r => <div key={r.id} className="rounded-2xl bg-slate-50 p-3"><div className="flex justify-between"><b>{r.name}</b><span>{fmtBytes(r.traffic_used)}</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200"><i className="block h-full rounded-full bg-blue-500" style={{ width: `${Math.min(100, (Number(r.traffic_used || 0) / Math.max(1, Number(r.traffic_limit || r.traffic_used || 1))) * 100)}%` }} /></div></div>)}</div></div>
    </div>
  </div>;
}
function Stat({ title, value, danger }: { title: string; value: string; danger?: boolean }) { return <div className="card p-5"><div className="muted">{title}</div><div className={cn('mt-2 text-3xl font-black', danger && 'text-rose-600')}>{value}</div></div>; }
function Badge({ tone, children }: { tone: 'ok' | 'warn' | 'danger' | 'muted'; children: React.ReactNode }) { return <span className={cn('badge', tone === 'ok' && 'badge-ok', tone === 'warn' && 'badge-warn', tone === 'danger' && 'badge-danger', tone === 'muted' && 'badge-muted')}>{children}</span>; }

function NodesPage(props: { nodes: NodeItem[]; filters: any; setFilters: any; isAdmin: boolean; onDetail: (n: NodeItem)=>void; onEdit: (n: NodeItem)=>void; onConfirm: (n: NodeItem)=>void; onDelete: (n: NodeItem)=>void }) {
  return <div className="grid gap-5"><Toolbar><input className="input" placeholder="搜索节点 / IP / 系统" value={props.filters.q} onChange={e => props.setFilters((f: any)=>({ ...f, nodes: { ...f.nodes, q: e.target.value } }))} /><select className="input" value={props.filters.status} onChange={e => props.setFilters((f: any)=>({ ...f, nodes: { ...f.nodes, status: e.target.value } }))}><option value="all">全部状态</option><option value="online">在线</option><option value="offline">离线</option></select></Toolbar><div className="table-wrap"><table className="table"><thead><tr><th>节点</th><th>状态</th><th>防火墙</th><th>资源</th><th>端口范围</th><th>最近心跳</th><th>操作</th></tr></thead><tbody>{props.nodes.map(n => { const fw = firewallStatus(n); const m = n.last_metrics || {}; return <tr key={n.id}><td><b>{n.name}</b><div className="muted">{n.hostname || '-'} · {n.os || '-'}/{n.arch || '-'}</div><div className="muted">公网：{n.public_ip || '-'}</div></td><td><Badge tone={online(n) ? 'ok' : 'muted'}>{online(n) ? '在线' : '离线'}</Badge></td><td><Badge tone={fw.tone}>{fw.text}</Badge>{fw.note && <div className="mt-2 text-xs text-amber-700">{fw.note}</div>}{n.firewall_error && <div className="mt-2 text-xs text-rose-600">{n.firewall_error}</div>}</td><td><div className="muted">CPU {Math.round(m.cpu_percent || 0)}%</div><div className="muted">内存 {fmtBytes(m.memory_used)} / {fmtBytes(m.memory_total)}</div><div className="mt-2 h-2 rounded-full bg-slate-100"><i className="block h-full rounded-full bg-blue-500" style={{ width: `${pct(m.memory_used, m.memory_total)}%` }} /></div></td><td>{n.port_range_start || '-'} - {n.port_range_end || '-'}</td><td>{fmtDate(n.last_seen_at)}</td><td><RowActions><button className="btn" onClick={()=>props.onDetail(n)}>详情</button>{props.isAdmin && <><button className="btn" onClick={()=>props.onEdit(n)}>设置</button>{n.firewall_mode==='strict-pending' && <button className="btn btn-primary" onClick={()=>props.onConfirm(n)}>确认严格</button>}<button className="btn btn-danger" onClick={()=>props.onDelete(n)}>删除</button></>}</RowActions></td></tr>; })}</tbody></table></div></div>;
}

function RulesPage(props: any) {
  return <div className="grid gap-5"><Toolbar><button className="btn btn-primary" onClick={props.onNew}>新增规则</button><input className="input" placeholder="搜索规则 / 端口 / 目标" value={props.filters.q} onChange={e => props.setFilters((f: any)=>({ ...f, rules: { ...f.rules, q: e.target.value } }))} /><select className="input" value={props.filters.node} onChange={e => props.setFilters((f: any)=>({ ...f, rules: { ...f.rules, node: e.target.value } }))}><option value="all">全部节点</option>{props.nodes.map((n: NodeItem)=><option key={n.id} value={n.id}>{n.name}</option>)}</select><select className="input" value={props.filters.protocol} onChange={e => props.setFilters((f: any)=>({ ...f, rules: { ...f.rules, protocol: e.target.value } }))}><option value="all">全部协议</option><option value="tcp">TCP</option><option value="udp">UDP</option><option value="both">TCP + UDP</option></select></Toolbar><div className="table-wrap"><table className="table"><thead><tr><th>规则</th><th>节点 / 用户</th><th>监听</th><th>目标</th><th>状态</th><th>流量</th><th>操作</th></tr></thead><tbody>{props.rules.map((r: RuleItem)=>{ const st = props.statusOf(r.id); const s = statusText(st); return <tr key={r.id}><td><b>{r.name}</b><div className="muted">{r.description || '无备注'}</div></td><td>{props.nodeName(r.node_id)}<div className="muted">{props.ownerName(r.user_id)}</div></td><td><Badge tone="muted">{protocolText(r.protocol)}</Badge><div className="mt-2 font-mono">:{r.listen_port}</div></td><td className="font-mono">{r.target_host}:{r.target_port}</td><td>{r.enabled ? <Badge tone={s.tone}>{s.text}</Badge> : <Badge tone="muted">已停用</Badge>}{st.last_error && <div className="mt-2 text-xs text-rose-600">{st.last_error}</div>}</td><td>{fmtBytes(r.traffic_used)}{r.traffic_limit ? <div className="muted">上限 {fmtBytes(r.traffic_limit)}</div> : null}</td><td><RowActions><button className="btn" onClick={()=>props.onDetail(r)}>详情</button><button className="btn" onClick={()=>props.onTest(r)}>检测</button><button className="btn" onClick={()=>props.onEdit(r)}>编辑</button><button className="btn" onClick={()=>props.onToggle(r)}>{r.enabled ? '停用' : '启用'}</button><button className="btn btn-danger" onClick={()=>props.onDelete(r)}>删除</button></RowActions></td></tr>;})}</tbody></table></div></div>;
}

function TokensPage({ onCreate }: { onCreate: () => void }) { return <div className="card p-6"><h2 className="text-xl font-black">节点接入</h2><p className="mt-2 text-slate-500">生成一次性 Token 后，在转发节点服务器上执行安装命令。Token 注册成功后会改用节点密钥签名心跳。</p><button className="btn btn-primary mt-5" onClick={onCreate}>生成接入 Token</button><div className="mt-5 rounded-2xl bg-amber-50 p-4 text-sm text-amber-800">严格防火墙模式会保留 SSH 端口；如需救援，在节点执行 <code>relayguard-agent firewall rescue</code>。</div></div>; }
function UsersPage({ users, nodes, onNew, onEdit, onDelete }: any) { return <div className="grid gap-5"><button className="btn btn-primary w-fit" onClick={onNew}>新增用户</button><div className="table-wrap"><table className="table"><thead><tr><th>用户</th><th>角色</th><th>规则额度</th><th>流量额度</th><th>端口范围</th><th>状态</th><th>操作</th></tr></thead><tbody>{users.map((u: User)=><tr key={u.id}><td><b>{u.username}</b><div className="muted">{u.id}</div></td><td>{roleText(u.role)}</td><td>{u.rule_limit || '不限'}</td><td>{fmtBytes(u.traffic_used)}{u.traffic_limit ? ` / ${fmtBytes(u.traffic_limit)}` : ' / 不限'}</td><td>{u.port_range_start || '-'} - {u.port_range_end || '-'}</td><td>{u.disabled ? <Badge tone="danger">禁用</Badge> : <Badge tone="ok">正常</Badge>} {u.must_change && <Badge tone="warn">需改密</Badge>}</td><td><RowActions><button className="btn" onClick={()=>onEdit(u)}>编辑</button><button className="btn btn-danger" onClick={()=>onDelete(u)}>删除</button></RowActions></td></tr>)}</tbody></table></div><div className="muted">当前节点数：{nodes.length}</div></div>; }

function AuditPage() { const [items, setItems] = useState<any[]>([]); const [err, setErr] = useState(''); useEffect(()=>{ api<{items:any[]}>('/api/audit-logs?limit=100').then(d=>setItems(d.items||[])).catch(e=>setErr(e.message)); }, []); return <div className="table-wrap"><table className="table"><thead><tr><th>时间</th><th>用户</th><th>动作</th><th>目标</th><th>IP</th><th>详情</th></tr></thead><tbody>{err ? <tr><td colSpan={6} className="text-rose-600">{err}</td></tr> : items.map((x,i)=><tr key={i}><td>{fmtDate(x.created_at)}</td><td>{x.user_id}</td><td>{x.action}</td><td>{x.target}</td><td>{x.ip}</td><td>{x.detail}</td></tr>)}</tbody></table></div>; }
function BackupPage({ toast, confirm }: any) { const [items, setItems] = useState<BackupItem[]>([]); const load = () => api<{items:BackupItem[]}>('/api/backups').then(d=>setItems(d.items||[])).catch((e: any)=>toast(e.message,'danger')); useEffect(() => { load(); }, []); async function create(){ await api('/api/backups',{method:'POST'}); toast('备份已创建'); load(); } return <div className="grid gap-5"><Toolbar><button className="btn btn-primary" onClick={create}>立即备份</button><button className="btn" onClick={load}>刷新</button></Toolbar><div className="table-wrap"><table className="table"><thead><tr><th>文件</th><th>大小</th><th>创建时间</th><th>操作</th></tr></thead><tbody>{items.map(b=><tr key={b.name}><td className="font-mono">{b.name}</td><td>{fmtBytes(b.size)}</td><td>{fmtDate(b.created_at)}</td><td><button className="btn btn-danger" onClick={()=>confirm('恢复备份', `恢复 ${b.name} 会覆盖当前数据库，恢复前会自动备份当前数据。`, async()=>{ await api(`/api/backups/${encodeURIComponent(b.name)}/restore`, { method:'POST' }); toast('恢复完成'); })}>恢复</button></td></tr>)}</tbody></table></div></div>; }
function AccountPage({ user, setUser, toast, openTotp }: any) { const [sessions, setSessions] = useState<SessionItem[]>([]); const loadSessions = () => api<{items:SessionItem[]}>('/api/account/sessions').then(d=>setSessions(d.items||[])).catch((e:any)=>toast(e.message,'danger')); useEffect(() => { loadSessions(); }, []); async function changePassword(e: React.FormEvent<HTMLFormElement>){ e.preventDefault(); const data = Object.fromEntries(new FormData(e.currentTarget)); const d = await api<{user:User}>('/api/account/password', { method:'POST', body: JSON.stringify(data) }); setUser(d.user); toast('密码已修改'); } return <div className="grid gap-5 lg:grid-cols-2"><form onSubmit={changePassword} className="card grid gap-4 p-5"><h2 className="text-xl font-black">修改密码</h2><label className="label">当前密码<input className="input" type="password" name="old_password" required /></label><label className="label">新密码<input className="input" type="password" name="new_password" required /></label><button className="btn btn-primary">保存新密码</button></form><div className="card p-5"><h2 className="text-xl font-black">两步验证</h2><p className="muted mt-2">当前状态：{user.totp_enabled ? '已启用' : '未启用'}</p><button className="btn mt-4" onClick={openTotp}>{user.totp_enabled ? '管理两步验证' : '启用两步验证'}</button></div><div className="card p-5 lg:col-span-2"><div className="flex justify-between"><h2 className="text-xl font-black">登录会话</h2><button className="btn" onClick={loadSessions}>刷新</button></div><div className="mt-4 grid gap-2">{sessions.map(s=><div key={s.id} className="rounded-2xl bg-slate-50 p-3"><b>{s.ip || '-'}</b><div className="muted">{s.user_agent || '-'}</div><div className="muted">创建：{fmtDate(s.created_at)} · 过期：{fmtDate(s.expires_at)}</div></div>)}</div></div></div>; }
function SecurityPage(){ return <div className="card p-6 leading-8 text-slate-700"><h2 className="text-xl font-black text-slate-950">安全说明</h2><p>RelayGuard 前端不使用 CDN，不加载远程字体或第三方统计脚本。所有资源均通过本地 npm 构建并内嵌到 Go 面板。</p><p>Agent 默认主动连接面板，节点注册使用一次性 Token，后续心跳使用节点密钥签名。</p><p>严格防火墙模式会先进入 60 秒待确认窗口；确认后才长期保持，未确认则自动回滚。</p></div>; }

function ModalHost({ modal, setModal, nodes, users, currentUser, refreshAll, toast }: any) {
  if (!modal) return null;
  const close = () => setModal(null);
  return <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/40 p-4 backdrop-blur-sm animate-fade-in" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
    {modal.kind === 'confirm' && <div className="card w-full max-w-md p-6 animate-slide-up"><h2 className="text-xl font-black">{modal.title}</h2><p className="mt-3 text-slate-600">{modal.message}</p><div className="mt-6 flex justify-end gap-2"><button className="btn" onClick={close}>取消</button><button className={cn('btn', modal.danger ? 'btn-danger' : 'btn-primary')} onClick={async()=>{ await modal.onConfirm(); close(); }}>确认</button></div></div>}
    {modal.kind === 'token' && <TokenModal close={close} toast={toast} refreshAll={refreshAll} />}
    {modal.kind === 'node' && <NodeModal node={modal.node} close={close} toast={toast} refreshAll={refreshAll} confirm={(m:string, cb:()=>void)=>setModal({ kind:'confirm', title:'启用严格防火墙托管', message:m, danger:true, onConfirm: cb })} />}
    {modal.kind === 'rule' && <RuleModal rule={modal.rule} nodes={nodes} users={users} currentUser={currentUser} close={close} toast={toast} refreshAll={refreshAll} />}
    {modal.kind === 'node-detail' && <Drawer title={`节点详情：${modal.node.name}`} close={close}><NodeDetail node={modal.node} /></Drawer>}
    {modal.kind === 'rule-detail' && <Drawer title={`规则详情：${modal.rule.name}`} close={close}><RuleDetail rule={modal.rule} nodes={nodes} users={users} /></Drawer>}
    {modal.kind === 'user' && <UserModal user={modal.user} nodes={nodes} close={close} toast={toast} refreshAll={refreshAll} />}
    {modal.kind === 'totp' && <TotpModal close={close} toast={toast} />}
  </div>;
}

function Drawer({ title, close, children }: { title:string; close:()=>void; children:React.ReactNode }) { return <div className="ml-auto h-full w-full max-w-2xl overflow-auto rounded-l-[2rem] bg-white p-6 shadow-soft animate-drawer-in"><div className="mb-5 flex items-start justify-between"><h2 className="text-xl font-black">{title}</h2><button className="btn" onClick={close}>关闭</button></div>{children}</div>; }
function Toolbar({ children }: { children: React.ReactNode }) { return <div className="card grid gap-3 p-4 md:flex md:items-center">{children}</div>; }
function RowActions({ children }: { children: React.ReactNode }) { return <div className="flex flex-wrap gap-2">{children}</div>; }
function ToastStack({ items }: { items: Toast[] }) { return <div className="fixed bottom-5 right-5 z-[60] grid gap-2">{items.map(t=><div key={t.id} className={cn('rounded-2xl px-4 py-3 text-sm font-bold text-white shadow-soft animate-slide-up', t.tone === 'danger' ? 'bg-rose-600' : t.tone === 'warn' ? 'bg-amber-600' : 'bg-slate-950')}>{t.text}</div>)}</div>; }

function NodeModal({ node, close, toast, refreshAll, confirm }: any) { async function submit(e: React.FormEvent<HTMLFormElement>){ e.preventDefault(); const fd = Object.fromEntries(new FormData(e.currentTarget)); const payload:any = { name: fd.name, port_range_start:+String(fd.port_range_start||0), port_range_end:+String(fd.port_range_end||0), max_rules:+String(fd.max_rules||0), firewall_mode: fd.firewall_mode };
    const run = async () => { if (payload.firewall_mode === 'strict' && node.firewall_mode !== 'strict') payload.firewall_mode = 'strict-pending'; await api(`/api/nodes/${node.id}`, { method:'PUT', body: JSON.stringify(payload) }); toast('节点设置已保存'); close(); await refreshAll(true); };
    if (payload.firewall_mode === 'strict' && node.firewall_mode !== 'strict') return confirm('严格托管会丢弃未授权入站流量。保存后会进入 60 秒待确认，确认期间请保持当前 SSH 可用。是否继续？', run);
    await run();
  }
  return <div className="card w-full max-w-2xl p-6 animate-slide-up"><div className="flex justify-between"><h2 className="text-xl font-black">节点设置</h2><button className="btn" onClick={close}>关闭</button></div><form onSubmit={submit} className="field-grid mt-5"><label className="label">节点名称<input className="input" name="name" defaultValue={node.name} required /></label><label className="label">最大规则数（0 不限）<input className="input" name="max_rules" type="number" defaultValue={node.max_rules || 0} /></label><label className="label">端口范围开始<input className="input" name="port_range_start" type="number" defaultValue={node.port_range_start || 0} /></label><label className="label">端口范围结束<input className="input" name="port_range_end" type="number" defaultValue={node.port_range_end || 0} /></label><label className="label md:col-span-2">防火墙托管模式<select className="input" name="firewall_mode" defaultValue={node.firewall_mode || 'loose'}><option value="off">关闭托管</option><option value="loose">宽松托管</option><option value="strict">严格托管：先进入 60 秒待确认</option></select></label><div className="rounded-2xl bg-amber-50 p-4 text-sm text-amber-800 md:col-span-2">严格模式会先进入“严格待确认”，请在节点列表点击“确认严格”。60 秒内未确认时 Agent 会自动回滚。</div><button className="btn btn-primary md:col-span-2">保存</button></form></div> }

function TokenModal({ close, toast, refreshAll }: any) { const [result, setResult] = useState<{token:string;cmd:string}|null>(null); async function submit(e: React.FormEvent<HTMLFormElement>){ e.preventDefault(); const fd = Object.fromEntries(new FormData(e.currentTarget)); const d = await api<any>('/api/node-tokens', { method:'POST', body: JSON.stringify({ name: fd.name || '新转发节点', hours: Number(fd.hours || 24) }) }); const token = d.item.plain_token; const origin = location.origin; setResult({ token, cmd: `curl -fsSL ${origin}/api/agent/install.sh | bash -s -- --panel ${origin} --token ${token}` }); toast('Token 已生成'); await refreshAll(true); }
  return <div className="card w-full max-w-2xl p-6 animate-slide-up"><div className="flex justify-between"><div><h2 className="text-xl font-black">生成节点接入 Token</h2><p className="muted mt-1">生成后只显示一次，请立即复制。</p></div><button className="btn" onClick={close}>关闭</button></div><form onSubmit={submit} className="field-grid mt-5"><label className="label">节点名称<input className="input" name="name" defaultValue="新转发节点" required /></label><label className="label">有效期<select className="input" name="hours" defaultValue="24"><option value="1">1 小时</option><option value="6">6 小时</option><option value="24">24 小时</option><option value="72">3 天</option><option value="168">7 天</option></select></label><button className="btn btn-primary md:col-span-2">生成 Token</button></form>{result && <div className="mt-5 grid gap-4"><CopyBox title="一次性 Token" value={result.token}/><CopyBox title="节点安装命令" value={result.cmd}/></div>}</div> }
function CopyBox({title,value}:{title:string;value:string}){ return <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4"><div className="mb-2 font-bold">{title}</div><textarea className="input min-h-24 font-mono" readOnly value={value} onFocus={e=>e.currentTarget.select()} /></div> }

function RuleModal({ rule, nodes, users, currentUser, close, toast, refreshAll }: any) { async function submit(e: React.FormEvent<HTMLFormElement>){ e.preventDefault(); const fd = Object.fromEntries(new FormData(e.currentTarget)); let exp = null; if (fd.expire_at) { const d = new Date(String(fd.expire_at)); d.setHours(23,59,59,999); exp = d.toISOString(); } const payload:any = { ...rule, ...fd, user_id: users.length ? fd.user_id : (rule?.user_id || currentUser?.id), listen_port:+String(fd.listen_port), target_port:+String(fd.target_port), speed_limit_mbps:+String(fd.speed_limit_mbps||0), max_connections:+String(fd.max_connections||0), traffic_limit:Math.round((+String(fd.traffic_limit_gb||0))*1024*1024*1024), expire_at:exp, enabled:fd.enabled === 'true', firewall_managed:true, source_cidrs: String(fd.source_cidrs || '').split(',').map(x=>x.trim()).filter(Boolean) }; delete payload.traffic_limit_gb; await api(rule?.id ? `/api/rules/${rule.id}` : '/api/rules', { method: rule?.id ? 'PUT':'POST', body: JSON.stringify(payload) }); toast('规则已保存'); close(); await refreshAll(true); }
  return <div className="card max-h-[90vh] w-full max-w-3xl overflow-auto p-6 animate-slide-up"><div className="flex justify-between"><h2 className="text-xl font-black">{rule?.id?'编辑':'新增'}转发规则</h2><button className="btn" onClick={close}>关闭</button></div><form onSubmit={submit} className="field-grid mt-5"><label className="label">规则名称<input className="input" name="name" defaultValue={rule?.name || ''} required /></label><label className="label">节点<select className="input" name="node_id" defaultValue={rule?.node_id || nodes[0]?.id}>{nodes.map((n:NodeItem)=><option key={n.id} value={n.id}>{n.name}</option>)}</select></label>{users.length>0 && <label className="label">所属用户<select className="input" name="user_id" defaultValue={rule?.user_id || users[0]?.id}>{users.map((u:User)=><option key={u.id} value={u.id}>{u.username}（{roleText(u.role)}）</option>)}</select></label>}<label className="label">协议<select className="input" name="protocol" defaultValue={rule?.protocol || 'tcp'}><option value="tcp">TCP</option><option value="udp">UDP</option><option value="both">TCP + UDP</option></select></label><label className="label">监听端口<input className="input" type="number" name="listen_port" defaultValue={rule?.listen_port || ''} required /></label><label className="label">目标端口<input className="input" type="number" name="target_port" defaultValue={rule?.target_port || ''} required /></label><label className="label md:col-span-2">目标地址<input className="input" name="target_host" defaultValue={rule?.target_host || ''} required /></label><label className="label">限速 Mbps<input className="input" name="speed_limit_mbps" type="number" defaultValue={rule?.speed_limit_mbps || 0} /></label><label className="label">最大连接数<input className="input" name="max_connections" type="number" defaultValue={rule?.max_connections || 0} /></label><label className="label">状态<select className="input" name="enabled" defaultValue={String(rule?.enabled ?? true)}><option value="true">启用</option><option value="false">停用</option></select></label><label className="label">规则流量上限 GB<input className="input" name="traffic_limit_gb" type="number" defaultValue={rule?.traffic_limit ? Math.round(Number(rule.traffic_limit)/1024/1024/1024) : 0} /></label><label className="label">到期日期<input className="input" name="expire_at" type="date" defaultValue={(rule?.expire_at || '').slice(0,10)} /></label><label className="label md:col-span-2">来源 IP/CIDR 白名单<input className="input" name="source_cidrs" defaultValue={(rule?.source_cidrs || []).join(', ')} /></label><label className="label md:col-span-2">备注<textarea className="input" name="description" defaultValue={rule?.description || ''} /></label><button className="btn btn-primary md:col-span-2">保存</button></form></div> }

function UserModal({ user, nodes, close, toast, refreshAll }: any) { async function submit(e:React.FormEvent<HTMLFormElement>){ e.preventDefault(); const fd = new FormData(e.currentTarget); const payload:any = { id:user?.id, username:fd.get('username'), password:fd.get('password') || '', role:fd.get('role'), rule_limit:+String(fd.get('rule_limit')||0), traffic_limit:Math.round((+String(fd.get('traffic_limit_gb')||0))*1024*1024*1024), port_range_start:+String(fd.get('port_range_start')||0), port_range_end:+String(fd.get('port_range_end')||0), expires_at:fd.get('expires_at') || '', disabled:fd.get('disabled')==='true', must_change:fd.get('must_change')==='true', allowed_node_ids:fd.getAll('allowed_node_ids') }; await api(user?.id ? `/api/users/${user.id}` : '/api/users', { method: user?.id ? 'PUT':'POST', body: JSON.stringify(payload) }); toast('用户已保存'); close(); await refreshAll(true); }
  const allowed = new Set(user?.allowed_node_ids || []); return <div className="card max-h-[90vh] w-full max-w-3xl overflow-auto p-6 animate-slide-up"><div className="flex justify-between"><h2 className="text-xl font-black">{user?.id?'编辑':'新增'}用户</h2><button className="btn" onClick={close}>关闭</button></div><form onSubmit={submit} className="field-grid mt-5"><label className="label">用户名<input className="input" name="username" defaultValue={user?.username||''} required /></label><label className="label">角色<select className="input" name="role" defaultValue={user?.role||'user'}><option value="user">普通用户</option><option value="admin">管理员</option><option value="super_admin">超级管理员</option></select></label><label className="label md:col-span-2">密码{user?.id?'（留空不修改）':''}<input className="input" type="password" name="password" /></label><label className="label">规则数量上限<input className="input" type="number" name="rule_limit" defaultValue={user?.rule_limit||0} /></label><label className="label">总流量额度 GB<input className="input" type="number" name="traffic_limit_gb" defaultValue={user?.traffic_limit ? Math.round(Number(user.traffic_limit)/1024/1024/1024) : 0} /></label><label className="label">端口范围开始<input className="input" type="number" name="port_range_start" defaultValue={user?.port_range_start||0} /></label><label className="label">端口范围结束<input className="input" type="number" name="port_range_end" defaultValue={user?.port_range_end||0} /></label><label className="label">到期日期<input className="input" type="date" name="expires_at" defaultValue={(user?.expires_at||'').slice(0,10)} /></label><label className="label">账号状态<select className="input" name="disabled" defaultValue={String(user?.disabled||false)}><option value="false">正常</option><option value="true">禁用</option></select></label><label className="label md:col-span-2"><span>允许使用的节点（全不选表示不限制）</span><div className="grid gap-2 rounded-2xl bg-slate-50 p-4">{nodes.map((n:NodeItem)=><label key={n.id} className="flex gap-2 text-sm"><input type="checkbox" name="allowed_node_ids" value={n.id} defaultChecked={allowed.has(n.id)} />{n.name}</label>)}</div></label><label className="flex gap-2 text-sm md:col-span-2"><input type="checkbox" name="must_change" value="true" defaultChecked={user?.must_change} />下次登录必须修改密码</label><button className="btn btn-primary md:col-span-2">保存</button></form></div> }
function NodeDetail({ node }: { node: NodeItem }) { const fw = firewallStatus(node); const m = node.last_metrics || {}; return <div className="grid gap-4"><Info title="状态" value={online(node)?'在线':'离线'} /><Info title="公网 IP" value={node.public_ip||'-'} /><Info title="系统" value={`${node.os||'-'} / ${node.arch||'-'}`} /><Info title="Agent" value={node.agent_version||'-'} /><Info title="最近心跳" value={fmtDate(node.last_seen_at)} /><Info title="防火墙" value={`${fw.text}${fw.note ? ' · ' + fw.note : ''}`} /><Info title="端口范围" value={`${node.port_range_start || '-'} - ${node.port_range_end || '-'}`} /><Info title="内存" value={`${fmtBytes(m.memory_used)} / ${fmtBytes(m.memory_total)}`} /></div>; }
function RuleDetail({ rule, nodes, users }: any) { const [tests, setTests] = useState<ConnectivityTest[]>([]); useEffect(()=>{ api<{items:ConnectivityTest[]}>(`/api/connectivity-tests?rule_id=${encodeURIComponent(rule.id)}&limit=20`).then(d=>setTests(d.items||[])).catch(()=>{}); }, [rule.id]); const nodeName = nodes.find((n:NodeItem)=>n.id===rule.node_id)?.name || rule.node_id; const owner = users.find((u:User)=>u.id===rule.user_id)?.username || rule.user_id; return <div className="grid gap-4"><Info title="协议" value={protocolText(rule.protocol)} /><Info title="监听" value={`${nodeName} :${rule.listen_port}`} /><Info title="目标" value={`${rule.target_host}:${rule.target_port}`} /><Info title="来源白名单" value={(rule.source_cidrs||[]).join(', ') || '不限'} /><Info title="规则流量" value={`${fmtBytes(rule.traffic_used)}${rule.traffic_limit ? ' / ' + fmtBytes(rule.traffic_limit) : ' / 不限'}`} /><Info title="归属用户" value={owner} /><h3 className="mt-3 font-black">检测历史</h3>{tests.map(t=><div key={t.id} className="rounded-2xl bg-slate-50 p-3"><b>{t.status}</b><div className="muted">{fmtDate(t.created_at)} · TCP {t.target_tcp_ok?'正常':'-'} · UDP {t.target_udp_ok?'已发送':'-'} · Ping {t.ping_ok ? `${t.ping_latency_ms||0} ms` : '-'}</div>{t.error && <div className="text-rose-600">{t.error}</div>}</div>)}</div>; }
function Info({ title, value }: { title:string; value:React.ReactNode }) { return <div className="rounded-2xl bg-slate-50 p-4"><div className="text-xs font-bold uppercase tracking-wider text-slate-400">{title}</div><div className="mt-1 font-semibold text-slate-800">{value}</div></div>; }
function TotpModal({ close, toast }: any){ return <div className="card w-full max-w-xl p-6 animate-slide-up"><div className="flex justify-between"><h2 className="text-xl font-black">两步验证</h2><button className="btn" onClick={close}>关闭</button></div><p className="muted mt-3">TOTP 启用/关闭功能仍沿用后端 API。后续可继续增强二维码展示。</p><button className="btn mt-4" onClick={()=>{toast('请在账号安全页启用两步验证流程'); close();}}>知道了</button></div> }

createRoot(document.getElementById('root')!).render(<App />);
