import React, { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { api } from './api';
import type { BackupItem, ConnectivityTest, NodeItem, RuleItem, RuleStatus, SessionItem, TrafficPoint, User } from './types';
import { cn, firewallStatus, fmtBytes, fmtDate, fmtShortDate, online, pct, protocolText, roleText, statusText } from './utils';

type Page = 'dashboard' | 'nodes' | 'rules' | 'users' | 'tokens' | 'audit' | 'backup' | 'account' | 'security' | 'settings';
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
  ['settings', '系统设置', '⚙'],
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
  const [filters, setFilters] = useState({ nodes: { q: '', status: 'all' }, rules: { q: '', node: 'all', protocol: 'all', state: 'all', tags: '' } });

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

  const visibleNavs = navs.filter(([id]) => isAdmin || !['users', 'tokens', 'audit', 'backup', 'settings'].includes(id));

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
        {page === 'nodes' && <NodesPage nodes={filteredNodes} filters={filters.nodes} setFilters={setFilters} isAdmin={isAdmin} onDetail={n => setModal({ kind: 'node-detail', node: n })} onEdit={n => setModal({ kind: 'node', node: n })} onConfirm={n => setModal({ kind: 'confirm', title: '确认严格模式', message: '确认该节点 SSH 和转发服务均正常？确认后将保持严格防火墙模式。', danger: true, onConfirm: async () => { await updateNode(n.id, { name: n.name, port_range_start: n.port_range_start, port_range_end: n.port_range_end, firewall_mode: 'strict', max_rules: n.max_rules || 0 }); toast('已提交确认，等待节点同步严格防火墙状态'); await refreshAll(true); } })} onDelete={n => setModal({ kind: 'confirm', title: '删除节点', message: '删除节点会同时删除该节点规则，确认？', danger: true, onConfirm: async () => { await api(`/api/nodes/${n.id}`, { method: 'DELETE' }); toast('节点已删除'); await refreshAll(true); } })} />}
{page === 'rules' && <RulesPage rules={filteredRules} nodes={nodes} users={users} filters={filters.rules} setFilters={setFilters} statusOf={statusOf} nodeName={nodeName} ownerName={ownerName} isAdmin={isAdmin} onNew={() => setModal({ kind: 'rule' })} onDetail={r => setModal({ kind: 'rule-detail', rule: r })} onEdit={r => setModal({ kind: 'rule', rule: r })} onTest={async r => { const d = await api<{ item: ConnectivityTest; message?: string }>(`/api/rules/${r.id}/test`, { method: 'POST' }); toast(d.message || '已提交检测'); setModal({ kind: 'rule-detail', rule: r }); }} onToggle={async r => { await api(`/api/rules/${r.id}/toggle`, { method: 'POST', body: JSON.stringify({ enabled: !r.enabled }) }); await refreshAll(true); }} onClone={async r => { await api(`/api/rules/${r.id}/clone`, { method: 'POST' }); toast('规则已克隆'); await refreshAll(true); }} onResetTraffic={async r => { await api(`/api/rules/reset-traffic/${r.id}`, { method: 'POST' }); toast('流量已重置'); await refreshAll(true); }} onDelete={r => setModal({ kind: 'confirm', title: '删除规则', message: '确认删除该规则？', danger: true, onConfirm: async () => { await api(`/api/rules/${r.id}`, { method: 'DELETE' }); toast('规则已删除'); await refreshAll(true); } })} toast={toast} />}
        {page === 'users' && <UsersPage users={users} nodes={nodes} onNew={() => setModal({ kind: 'user' })} onEdit={u => setModal({ kind: 'user', user: u })} onDelete={u => setModal({ kind: 'confirm', title: '删除用户', message: '确认删除该用户？该用户规则会被停用。', danger: true, onConfirm: async () => { await api(`/api/users/${u.id}`, { method: 'DELETE' }); toast('用户已删除'); await refreshAll(true); } })} />}
        {page === 'tokens' && <TokensPage onCreate={() => setModal({ kind: 'token' })} />}
        {page === 'audit' && <AuditPage />}
        {page === 'backup' && <BackupPage toast={toast} confirm={(title, message, onConfirm) => setModal({ kind: 'confirm', title, message, danger: true, onConfirm })} />}
        {page === 'account' && <AccountPage user={user} setUser={setUser} toast={toast} openTotp={() => setModal({ kind: 'totp' })} />}
        {page === 'settings' && <SettingsPage toast={toast} />}
        {page === 'security' && <SecurityPage />}
      </section>
    </main>

    <ToastStack items={toasts} />
    <ModalHost modal={modal} setModal={setModal} nodes={nodes} users={users} currentUser={user} setUser={setUser} refreshAll={refreshAll} toast={toast} />
  </div>;

  async function updateNode(id: string, payload: any) { await api(`/api/nodes/${id}`, { method: 'PUT', body: JSON.stringify(payload) }); }
}

function pageTitle(page: Page) {
  return ({ dashboard: '仪表盘', nodes: '节点管理', rules: '转发规则', users: '用户管理', tokens: '节点接入', audit: '审计日志', backup: '备份恢复', settings: '系统设置', account: '账号安全', security: '安全说明' } as Record<Page, string>)[page];
}
function pageSubtitle(page: Page) {
  return ({ dashboard: '查看节点、规则、服务端流量趋势和异常状态', nodes: '管理转发节点、端口范围和防火墙托管', rules: '管理转发规则，复制监听地址和目标地址', users: '配置用户权限、配额、节点和端口范围', tokens: '生成一次性接入命令并添加转发节点', audit: '查看重要操作记录', backup: '创建和恢复 SQLite 数据库备份', settings: '配置站点名称、心跳间隔、会话时长和 Webhook', account: '修改密码、两步验证和会话管理', security: '查看部署、接入和防火墙托管注意事项' } as Record<Page, string>)[page];
}

function LoadingScreen() { return <div className="grid min-h-screen place-items-center"><div className="card p-8 text-center"><div className="mx-auto mb-4 h-10 w-10 animate-pulse-soft rounded-full bg-blue-600" /><div className="font-black">RelayGuard 正在加载...</div></div></div>; }

function LoginPage({ onLogin, toast }: { onLogin: (u: User, v?: string) => void; toast: (m: string, t?: Toast['tone']) => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;

    setBusy(true);
    setMessage('正在登录...');

    try {
      const fd = Object.fromEntries(new FormData(e.currentTarget));
      const d = await api<{ user: User; version?: string }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify(fd)
      });
      setMessage('登录成功，正在进入面板...');
      onLogin(d.user, d.version);
    } catch (err: any) {
      const msg = err?.message || '登录失败，请检查用户名、密码或网络连接。';
      setMessage(msg);
      toast(msg, 'danger');
    } finally {
      setBusy(false);
    }
  }

  return <div className="grid min-h-screen place-items-center p-6">
    <div className="grid w-full max-w-4xl overflow-hidden rounded-[2rem] bg-white shadow-soft md:grid-cols-[.9fr_1.1fr]">
      <div className="login-brand-panel p-10 text-white">
        <div className="text-4xl font-black tracking-tight">RelayGuard</div>
        <div className="mt-8 h-1 w-16 rounded-full bg-white/60" />
        <p className="mt-6 text-sm text-white/72">请登录管理面板</p>
      </div>

      <form onSubmit={submit} className="grid gap-4 p-8 sm:p-10">
        <h1 className="text-2xl font-black text-slate-950">登录</h1>

        {message && <div className={cn(
          'rounded-2xl px-4 py-3 text-sm font-semibold',
          message.includes('成功') || message.includes('正在登录') ? 'bg-teal-50 text-teal-700' : 'bg-rose-50 text-rose-700'
        )}>{message}</div>}

        <label className="label">用户名
          <input className="input" name="username" autoComplete="username" required disabled={busy} />
        </label>

        <label className="label">密码
          <input className="input" type="password" name="password" autoComplete="current-password" required disabled={busy} />
        </label>

        <label className="label">两步验证码
          <input className="input" name="totp_code" inputMode="numeric" placeholder="未启用可留空" disabled={busy} />
        </label>

        <button className="btn btn-primary mt-2" disabled={busy}>
          {busy ? '登录中...' : '登录'}
        </button>
      </form>
    </div>
  </div>;
}

type TrendPoint = { ts: number; total: number };

function useTrafficTrend(total: number) {
  const [points, setPoints] = useState<TrendPoint[]>([]);

  useEffect(() => {
    const key = 'relayguard:traffic-trend:v1';
    const now = Date.now();
    let arr: TrendPoint[] = [];

    try {
      arr = JSON.parse(localStorage.getItem(key) || '[]');
    } catch {
      arr = [];
    }

    const cutoff = now - 24 * 60 * 60 * 1000;
    arr = arr.filter(p => p && typeof p.ts === 'number' && typeof p.total === 'number' && p.ts >= cutoff);

    const last = arr[arr.length - 1];
    const changed = !last || Math.abs(Number(last.total || 0) - Number(total || 0)) >= 1024;
    const stale = !last || now - last.ts >= 5 * 60 * 1000;

    if (!last || changed || stale) {
      arr.push({ ts: now, total: Number(total || 0) });
    }

    arr = arr.slice(-96);
    localStorage.setItem(key, JSON.stringify(arr));
    setPoints(arr);
  }, [total]);

  return points;
}

function TrafficTrend({ points, range, setRange }: { points: TrafficPoint[]; range: string; setRange: (v: string) => void }) {
  const width = 720;
  const height = 220;
  const padX = 28;
  const padY = 24;
  const values = points.length ? points.map(p => Number(p.total || 0)) : [0];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(1, max - min);
  const safePoints = points.length ? points : [{ time: new Date().toISOString(), total: 0, delta: 0 }];

  const coords = safePoints.map((p, i) => {
    const x = safePoints.length <= 1 ? padX : padX + i * ((width - padX * 2) / (safePoints.length - 1));
    const y = height - padY - ((Number(p.total || 0) - min) / span) * (height - padY * 2);
    return { x, y };
  });

  const line = coords.map(p => `${p.x},${p.y}`).join(' ');
  const area = coords.length ? `${padX},${height - padY} ${line} ${width - padX},${height - padY}` : '';
  const latest = safePoints[safePoints.length - 1];
  const first = safePoints[0];
  const growth = Math.max(0, Number(latest?.total || 0) - Number(first?.total || 0));

  return <div className="card traffic-card p-5">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h3 className="text-lg font-black text-slate-900">服务端流量趋势</h3>
        <p className="muted mt-1">面板每 5 分钟采样一次规则累计流量。趋势用于观察变化，不代表实时带宽。</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {['24h', '7d', '30d'].map(item => <button key={item} className={cn('btn', range === item && 'btn-primary')} onClick={() => setRange(item)}>
          {item === '24h' ? '24 小时' : item === '7d' ? '7 天' : '30 天'}
        </button>)}
      </div>
    </div>

    <div className="mt-4 grid gap-3 sm:grid-cols-3">
      <div className="rounded-2xl bg-slate-50 px-4 py-3">
        <div className="text-xs font-bold text-slate-500">当前累计</div>
        <div className="mt-1 text-xl font-black text-slate-900">{fmtBytes(latest?.total || 0)}</div>
      </div>
      <div className="rounded-2xl bg-emerald-50 px-4 py-3">
        <div className="text-xs font-bold text-emerald-700">区间增量</div>
        <div className="mt-1 text-xl font-black text-emerald-800">{fmtBytes(growth)}</div>
      </div>
      <div className="rounded-2xl bg-blue-50 px-4 py-3">
        <div className="text-xs font-bold text-blue-700">采样点</div>
        <div className="mt-1 text-xl font-black text-blue-800">{safePoints.length}</div>
      </div>
    </div>

    <div className="mt-5 overflow-hidden rounded-3xl border border-slate-200/70 bg-gradient-to-b from-white to-slate-50 p-3">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-56 w-full" role="img" aria-label="服务端流量趋势图">
        <defs>
          <linearGradient id="trafficLine" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="#0f766e" />
            <stop offset="100%" stopColor="#2563eb" />
          </linearGradient>
          <linearGradient id="trafficArea" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#14b8a6" stopOpacity=".18" />
            <stop offset="100%" stopColor="#2563eb" stopOpacity=".02" />
          </linearGradient>
        </defs>

        {[0, 1, 2, 3].map(i => {
          const y = padY + i * ((height - padY * 2) / 3);
          return <line key={i} x1={padX} x2={width - padX} y1={y} y2={y} stroke="#e2e8f0" strokeDasharray="5 8" />;
        })}

        {coords.length > 1 && <polygon points={area} fill="url(#trafficArea)" />}
        <polyline points={line} fill="none" stroke="url(#trafficLine)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
        {coords.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={i === coords.length - 1 ? 5 : 3} fill={i === coords.length - 1 ? '#0f766e' : '#94a3b8'} />)}
      </svg>
    </div>

    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
      <span>最近采样：{latest?.time ? fmtDate(latest.time) : '-'}</span>
      <span>数据范围：{range === '24h' ? '最近 24 小时' : range === '7d' ? '最近 7 天' : '最近 30 天'}</span>
    </div>
  </div>;
}

function Dashboard({ nodes, rules, statusOf }: { nodes: NodeItem[]; rules: RuleItem[]; statusOf: (id: string) => RuleStatus }) {
  const traffic = rules.reduce((sum, rule) => sum + Number(rule.traffic_used || 0), 0);
  const running = rules.filter(rule => statusOf(rule.id).state === 'running').length;
  const errors = rules.filter(rule => statusOf(rule.id).state === 'error').length;
  const [range, setRange] = useState('24h');
  const [points, setPoints] = useState<TrafficPoint[]>([]);
  const [trendError, setTrendError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api<{ items: TrafficPoint[] }>(`/api/traffic/timeseries?range=${encodeURIComponent(range)}`)
      .then(d => {
        if (!cancelled) {
          setPoints(d.items || []);
          setTrendError('');
        }
      })
      .catch((err: any) => {
        if (!cancelled) setTrendError(err.message || '读取流量趋势失败');
      });
    return () => { cancelled = true; };
  }, [range, traffic]);

  return <div className="grid gap-6">
    <div className="hero-card rounded-[2rem] p-8 text-white shadow-soft">
      <div className="text-sm font-bold text-teal-100">RelayGuard Console</div>
      <h2 className="mt-3 text-3xl font-black">运行状态</h2>
      <p className="mt-2 max-w-2xl text-slate-100/90">查看节点、转发规则、流量趋势和异常状态。</p>
    </div>

    <div className="grid gap-4 md:grid-cols-4">
      <Stat title="在线节点" value={`${nodes.filter(online).length}/${nodes.length}`} />
      <Stat title="运行规则" value={`${running}/${rules.length}`} />
      <Stat title="累计流量" value={fmtBytes(traffic)} />
      <Stat title="异常规则" value={String(errors)} danger={errors > 0} />
    </div>

    {trendError ? <div className="rounded-2xl bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-700">{trendError}</div> : null}
    <TrafficTrend points={points} range={range} setRange={setRange} />

    <div className="grid gap-4 lg:grid-cols-2">
      <div className="card p-5">
        <h3 className="font-black text-slate-900">节点概览</h3>
        <div className="mt-4 grid gap-3">
          {nodes.slice(0, 6).map(n => <div key={n.id} className="flex items-center justify-between rounded-2xl bg-slate-50/80 p-3">
            <div>
              <b>{n.name}</b>
              <div className="muted">{n.public_ip || '-'} · {n.os || '-'}</div>
            </div>
            <Badge tone={online(n) ? 'ok' : 'muted'}>{online(n) ? '在线' : '离线'}</Badge>
          </div>)}
        </div>
      </div>

      <div className="card p-5">
        <h3 className="font-black text-slate-900">流量 Top 规则</h3>
        <div className="mt-4 grid gap-3">
          {[...rules].sort((a, b) => Number(b.traffic_used || 0) - Number(a.traffic_used || 0)).slice(0, 6).map(r => <div key={r.id} className="rounded-2xl bg-slate-50/80 p-3">
            <div className="flex justify-between gap-4">
              <b className="truncate">{r.name}</b>
              <span className="font-semibold text-slate-700">{fmtBytes(r.traffic_used)}</span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200">
              <i className="block h-full rounded-full bg-gradient-to-r from-teal-500 to-blue-500" style={{ width: `${Math.min(100, (Number(r.traffic_used || 0) / Math.max(1, Number(r.traffic_limit || r.traffic_used || 1))) * 100)}%` }} />
            </div>
          </div>)}
        </div>
      </div>
    </div>
  </div>;
}

function Stat({ title, value, danger }: { title: string; value: string; danger?: boolean }) { return <div className="card p-5"><div className="muted">{title}</div><div className={cn('mt-2 text-3xl font-black', danger && 'text-rose-600')}>{value}</div></div>; }
function Badge({ tone, children }: { tone: 'ok' | 'warn' | 'danger' | 'muted'; children: React.ReactNode }) { return <span className={cn('badge', tone === 'ok' && 'badge-ok', tone === 'warn' && 'badge-warn', tone === 'danger' && 'badge-danger', tone === 'muted' && 'badge-muted')}>{children}</span>; }

function NodesPage(props: { nodes: NodeItem[]; filters: any; setFilters: any; isAdmin: boolean; onDetail: (n: NodeItem)=>void; onEdit: (n: NodeItem)=>void; onConfirm: (n: NodeItem)=>void; onDelete: (n: NodeItem)=>void }) {
  return <div className="grid gap-5"><Toolbar><input className="input" placeholder="搜索节点 / IP / 系统" value={props.filters.q} onChange={e => props.setFilters((f: any)=>({ ...f, nodes: { ...f.nodes, q: e.target.value } }))} /><select className="input" value={props.filters.status} onChange={e => props.setFilters((f: any)=>({ ...f, nodes: { ...f.nodes, status: e.target.value } }))}><option value="all">全部状态</option><option value="online">在线</option><option value="offline">离线</option></select></Toolbar><div className="table-wrap"><table className="table"><thead><tr><th>节点</th><th>状态</th><th>防火墙</th><th>资源</th><th>端口范围</th><th>最近心跳</th><th>操作</th></tr></thead><tbody>{props.nodes.map(n => { const fw = firewallStatus(n); const m = n.last_metrics || {}; return <tr key={n.id}><td><b>{n.name}</b><div className="muted">{n.hostname || '-'} · {n.os || '-'}/{n.arch || '-'}</div><div className="muted">公网：{n.public_ip || '-'}</div></td><td><Badge tone={online(n) ? 'ok' : 'muted'}>{online(n) ? '在线' : '离线'}</Badge></td><td><Badge tone={fw.tone}>{fw.text}</Badge>{fw.note && <div className="mt-2 text-xs text-amber-700">{fw.note}</div>}{n.firewall_error && <div className="mt-2 text-xs text-rose-600">{n.firewall_error}</div>}</td><td><div className="muted">CPU {Math.round(m.cpu_percent || 0)}%</div><div className="muted">内存 {fmtBytes(m.memory_used)} / {fmtBytes(m.memory_total)}</div><div className="mt-2 h-2 rounded-full bg-slate-100"><i className="block h-full rounded-full bg-blue-500" style={{ width: `${pct(m.memory_used, m.memory_total)}%` }} /></div></td><td>{n.port_range_start || '-'} - {n.port_range_end || '-'}</td><td>{fmtDate(n.last_seen_at)}</td><td><RowActions><button className="btn" onClick={()=>props.onDetail(n)}>详情</button>{props.isAdmin && <><button className="btn" onClick={()=>props.onEdit(n)}>设置</button>{n.firewall_mode==='strict-pending' && <button className="btn btn-primary" onClick={()=>props.onConfirm(n)}>确认严格</button>}<button className="btn btn-danger" onClick={()=>props.onDelete(n)}>删除</button></>}</RowActions></td></tr>; })}</tbody></table></div></div>;
}

async function copyText(value: string, toast?: (m: string, t?: Toast['tone']) => void) {
  try {
    await navigator.clipboard.writeText(value);
    toast?.('已复制到剪贴板');
  } catch {
    toast?.('复制失败，请手动选择复制', 'warn');
  }
}

function CopyPill({ label, value, toast }: { label: string; value: string; toast?: (m: string, t?: Toast['tone']) => void }) {
  return <div className="copy-pill">
    <div className="min-w-0">
      <div className="text-[11px] font-bold text-slate-500">{label}</div>
      <div className="truncate font-mono text-xs text-slate-800">{value}</div>
    </div>
    <button className="btn btn-xs" onClick={() => copyText(value, toast)}>复制</button>
  </div>;
}

function Actions({ children }: any) {
  return <div className="flex flex-wrap gap-2">{children}</div>;
}

function RulesPage(props: any) {
  const [tagFilter, setTagFilter] = useState('');
  const [tagRules, setTagRules] = useState<RuleItem[] | null>(null);
  const displayRules = tagRules !== null ? tagRules : props.rules;

  function applyTagFilter() {
    const tags = tagFilter.trim();
    if (!tags) { setTagRules(null); return; }
    api<{ items: RuleItem[] }>(`/api/rules/tags?tags=${encodeURIComponent(tags)}`)
      .then(d => { setTagRules(d.items || []); props.toast(`标签筛选：${d.items?.length || 0} 条规则`); })
      .catch((e: any) => { props.toast(e.message || '标签筛选失败', 'danger'); });
  }

  return <div className="grid gap-5">
    <div className="toolbar-card card p-4">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <h2 className="text-lg font-black text-slate-900">转发规则</h2>
          <p className="muted mt-1">管理监听端口、目标地址、状态检测和流量限制。</p>
        </div>
        <button className="btn btn-primary toolbar-primary" onClick={props.onNew}>
          <span className="text-lg leading-none">＋</span>
          新增规则
        </button>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <input className="input" placeholder="搜索规则、端口、目标或节点" value={props.filters.q} onChange={e => props.setFilters((f: any) => ({ ...f, rules: { ...f.rules, q: e.target.value } }))} />

        <select className="input" value={props.filters.node} onChange={e => props.setFilters((f: any) => ({ ...f, rules: { ...f.rules, node: e.target.value } }))}>
          <option value="all">全部节点</option>
          {props.nodes.map((n: NodeItem) => <option key={n.id} value={n.id}>{n.name}</option>)}
        </select>

        <select className="input" value={props.filters.protocol} onChange={e => props.setFilters((f: any) => ({ ...f, rules: { ...f.rules, protocol: e.target.value } }))}>
          <option value="all">全部协议</option>
          <option value="tcp">TCP</option>
          <option value="udp">UDP</option>
          <option value="both">TCP + UDP</option>
        </select>

        <select className="input" value={props.filters.state} onChange={e => props.setFilters((f: any) => ({ ...f, rules: { ...f.rules, state: e.target.value } }))}>
          <option value="all">全部状态</option>
          <option value="enabled">已启用</option>
          <option value="running">运行中</option>
          <option value="stopped">已停止</option>
          <option value="error">异常</option>
          <option value="disabled">已停用</option>
        </select>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <input className="input max-w-xs" placeholder="标签筛选（逗号分隔）" value={tagFilter} onChange={e => setTagFilter(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); applyTagFilter(); } }} />
        <button className="btn" onClick={applyTagFilter}>筛选标签</button>
        {tagRules !== null && <button className="btn" onClick={() => { setTagFilter(''); setTagRules(null); }}>清除标签筛选</button>}
      </div>
    </div>

    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>规则</th>
            <th>节点 / 用户</th>
            <th>监听 / 目标</th>
            <th>状态</th>
            <th>流量</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {displayRules.length === 0 && <tr><td colSpan={6} className="text-center text-slate-500">暂无规则</td></tr>}

          {displayRules.map((r: RuleItem) => {
            const st = props.statusOf(r.id);
            const state = statusText(st);
            const node = props.nodes.find((n: NodeItem) => n.id === r.node_id);
            const listenHost = node?.public_ip || node?.hostname || '节点公网 IP 未上报';
            const listenValue = `${listenHost}:${r.listen_port}`;
            const targetValue = `${r.target_host}:${r.target_port}`;

            return <tr key={r.id}>
              <td>
                <b>{r.name}</b>
                <div className="muted">{r.description || '无备注'}</div>
                {r.tags && r.tags.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{r.tags.map((t: string) => <span key={t} className="rounded-lg bg-blue-50 px-2 py-0.5 text-xs font-semibold text-blue-700">{t}</span>)}</div>}
              </td>
              <td>
                {props.nodeName(r.node_id)}
                <div className="muted">{props.ownerName(r.user_id)}</div>
              </td>
              <td>
                <div className="grid gap-2">
                  <div className="flex flex-wrap gap-2">
                    <Badge tone="muted">{protocolText(r.protocol)}</Badge>
                    <Badge tone={r.enabled ? 'ok' : 'muted'}>{r.enabled ? '已启用' : '已停用'}</Badge>
                  </div>
                  <CopyPill label="监听地址" value={listenValue} toast={props.toast} />
                  <CopyPill label="目标地址" value={targetValue} toast={props.toast} />
                </div>
              </td>
              <td>
                {r.enabled ? <Badge tone={state.tone}>{state.text}</Badge> : <Badge tone="muted">已停用</Badge>}
                {st.updated_at && <div className="mt-2 text-xs text-slate-500">更新：{fmtDate(st.updated_at)}</div>}
                {st.last_error && <div className="mt-2 text-xs text-rose-600">{st.last_error}</div>}
              </td>
              <td>
                {fmtBytes(r.traffic_used)}
                {r.traffic_limit ? <div className="muted">上限 {fmtBytes(r.traffic_limit)}</div> : <div className="muted">无上限</div>}
              </td>
              <td>
                <Actions>
                  <button className="btn" onClick={() => props.onDetail(r)}>详情</button>
                  <button className="btn" onClick={() => props.onTest(r)}>检测</button>
                  <button className="btn" onClick={() => props.onEdit(r)}>编辑</button>
                  <button className="btn" onClick={() => props.onClone(r)}>克隆</button>
                  <button className="btn" onClick={() => props.onToggle(r)}>{r.enabled ? '停用' : '启用'}</button>
                  {props.isAdmin && <button className="btn" onClick={() => props.onResetTraffic(r)}>重置流量</button>}
                  <button className="btn btn-danger" onClick={() => props.onDelete(r)}>删除</button>
                </Actions>
              </td>
            </tr>;
          })}
        </tbody>
      </table>
    </div>
  </div>;
}

function TokensPage({ onCreate }: { onCreate: () => void }) { return <div className="card p-6"><h2 className="text-xl font-black">节点接入</h2><p className="mt-2 text-slate-500">生成一次性接入命令，并在节点服务器上执行。</p><button className="btn btn-primary mt-5" onClick={onCreate}>生成接入 Token</button><div className="mt-5 rounded-2xl bg-amber-50 p-4 text-sm text-amber-800">严格防火墙模式会保留 SSH 端口；如需救援，在节点执行 <code>relayguard-agent firewall rescue</code>。</div></div>; }
function UsersPage({ users, nodes, onNew, onEdit, onDelete }: any) { return <div className="grid gap-5"><button className="btn btn-primary w-fit" onClick={onNew}>新增用户</button><div className="table-wrap"><table className="table"><thead><tr><th>用户</th><th>角色</th><th>规则额度</th><th>流量额度</th><th>端口范围</th><th>状态</th><th>操作</th></tr></thead><tbody>{users.map((u: User)=><tr key={u.id}><td><b>{u.username}</b><div className="muted">{u.id}</div></td><td>{roleText(u.role)}</td><td>{u.rule_limit || '不限'}</td><td>{fmtBytes(u.traffic_used)}{u.traffic_limit ? ` / ${fmtBytes(u.traffic_limit)}` : ' / 不限'}</td><td>{u.port_range_start || '-'} - {u.port_range_end || '-'}</td><td>{u.disabled ? <Badge tone="danger">禁用</Badge> : <Badge tone="ok">正常</Badge>} {u.must_change && <Badge tone="warn">需改密</Badge>}</td><td><RowActions><button className="btn" onClick={()=>onEdit(u)}>编辑</button><button className="btn btn-danger" onClick={()=>onDelete(u)}>删除</button></RowActions></td></tr>)}</tbody></table></div><div className="muted">当前节点数：{nodes.length}</div></div>; }

function AuditPage() { const [items, setItems] = useState<any[]>([]); const [err, setErr] = useState(''); const [catFilter, setCatFilter] = useState('all'); useEffect(()=>{ api<{items:any[]}>('/api/audit-logs?limit=200').then(d=>setItems(d.items||[])).catch(e=>setErr(e.message)); }, []); function catOf(action: string): { label: string; cls: string } { const map: Record<string,{label:string;cls:string}> = { login: {label:'认证',cls:'bg-purple-100 text-purple-700'}, change_password: {label:'认证',cls:'bg-purple-100 text-purple-700'}, enable_totp: {label:'认证',cls:'bg-purple-100 text-purple-700'}, disable_totp: {label:'认证',cls:'bg-purple-100 text-purple-700'}, logout_other_sessions: {label:'认证',cls:'bg-purple-100 text-purple-700'}, create_user: {label:'用户',cls:'bg-blue-100 text-blue-700'}, update_user: {label:'用户',cls:'bg-blue-100 text-blue-700'}, delete_user: {label:'用户',cls:'bg-blue-100 text-blue-700'}, reset_user_traffic: {label:'用户',cls:'bg-blue-100 text-blue-700'}, create_node_token: {label:'节点',cls:'bg-emerald-100 text-emerald-700'}, update_node: {label:'节点',cls:'bg-emerald-100 text-emerald-700'}, delete_node: {label:'节点',cls:'bg-emerald-100 text-emerald-700'}, register_node: {label:'节点',cls:'bg-emerald-100 text-emerald-700'}, create_rule: {label:'规则',cls:'bg-amber-100 text-amber-700'}, update_rule: {label:'规则',cls:'bg-amber-100 text-amber-700'}, delete_rule: {label:'规则',cls:'bg-amber-100 text-amber-700'}, toggle_rule: {label:'规则',cls:'bg-amber-100 text-amber-700'}, clone_rule: {label:'规则',cls:'bg-amber-100 text-amber-700'}, reset_rule_traffic: {label:'规则',cls:'bg-amber-100 text-amber-700'}, backup: {label:'系统',cls:'bg-slate-200 text-slate-700'}, restore_backup: {label:'系统',cls:'bg-slate-200 text-slate-700'}, update_settings: {label:'系统',cls:'bg-slate-200 text-slate-700'}, reset_admin_password: {label:'系统',cls:'bg-slate-200 text-slate-700'}, connectivity_test: {label:'检测',cls:'bg-rose-100 text-rose-700'}, }; return map[action] || {label:'其他',cls:'bg-slate-100 text-slate-600'}; } const cats = ['all','认证','用户','节点','规则','系统','检测','其他']; const filtered = catFilter === 'all' ? items : items.filter((x:any) => catOf(x.action).label === catFilter); return <div className="grid gap-5"><div className="flex flex-wrap gap-2">{cats.map(c => <button key={c} className={cn('btn text-sm', catFilter === c ? 'btn-primary' : '')} onClick={() => setCatFilter(c)}>{c === 'all' ? '全部' : c}</button>)}<span className="muted self-center text-xs">{filtered.length} 条记录</span></div><div className="table-wrap"><table className="table"><thead><tr><th>时间</th><th>分类</th><th>用户</th><th>动作</th><th>目标</th><th>IP</th><th>详情</th></tr></thead><tbody>{err ? <tr><td colSpan={7} className="text-rose-600">{err}</td></tr> : filtered.length === 0 ? <tr><td colSpan={7} className="text-center text-slate-500">暂无匹配记录</td></tr> : filtered.map((x:any,i:number)=>{ const c = catOf(x.action); return <tr key={i}><td className="whitespace-nowrap text-xs">{fmtDate(x.created_at)}</td><td><span className={cn('rounded-lg px-2 py-0.5 text-xs font-semibold', c.cls)}>{c.label}</span></td><td className="font-mono text-xs max-w-32 truncate" title={x.user_id}>{x.user_id}</td><td className="font-mono text-xs">{x.action}</td><td className="font-mono text-xs max-w-32 truncate" title={x.target}>{x.target}</td><td className="font-mono text-xs">{x.ip}</td><td className="text-xs max-w-xs truncate" title={x.detail}>{x.detail}</td></tr>; })}</tbody></table></div></div>; }
function BackupPage({ toast, confirm }: any) { const [items, setItems] = useState<BackupItem[]>([]); const load = () => api<{items:BackupItem[]}>('/api/backups').then(d=>setItems(d.items||[])).catch((e: any)=>toast(e.message,'danger')); useEffect(() => { load(); }, []); async function create(){ await api('/api/backups',{method:'POST'}); toast('备份已创建'); load(); } return <div className="grid gap-5"><Toolbar><button className="btn btn-primary" onClick={create}>立即备份</button><button className="btn" onClick={load}>刷新</button></Toolbar><div className="table-wrap"><table className="table"><thead><tr><th>文件</th><th>大小</th><th>创建时间</th><th>操作</th></tr></thead><tbody>{items.map(b=><tr key={b.name}><td className="font-mono">{b.name}</td><td>{fmtBytes(b.size)}</td><td>{fmtDate(b.created_at)}</td><td><button className="btn btn-danger" onClick={()=>confirm('恢复备份', `恢复 ${b.name} 会覆盖当前数据库，恢复前会自动备份当前数据。`, async()=>{ await api(`/api/backups/${encodeURIComponent(b.name)}/restore`, { method:'POST' }); toast('恢复完成'); })}>恢复</button></td></tr>)}</tbody></table></div></div>; }
function AccountPage({ user, setUser, toast, openTotp }: any) { const [sessions, setSessions] = useState<SessionItem[]>([]); const loadSessions = () => api<{items:SessionItem[]}>('/api/account/sessions').then(d=>setSessions(d.items||[])).catch((e:any)=>toast(e.message,'danger')); useEffect(() => { loadSessions(); }, []); async function changePassword(e: React.FormEvent<HTMLFormElement>){ e.preventDefault(); const data = Object.fromEntries(new FormData(e.currentTarget)); const d = await api<{user:User}>('/api/account/password', { method:'POST', body: JSON.stringify(data) }); setUser(d.user); toast('密码已修改'); } return <div className="grid gap-5 lg:grid-cols-2"><form onSubmit={changePassword} className="card grid gap-4 p-5"><h2 className="text-xl font-black">修改密码</h2><label className="label">当前密码<input className="input" type="password" name="old_password" required /></label><label className="label">新密码<input className="input" type="password" name="new_password" required /></label><button className="btn btn-primary">保存新密码</button></form><div className="card p-5"><h2 className="text-xl font-black">两步验证</h2><p className="muted mt-2">当前状态：{user.totp_enabled ? '已启用' : '未启用'}</p><button className="btn mt-4" onClick={openTotp}>{user.totp_enabled ? '管理两步验证' : '启用两步验证'}</button></div><div className="card p-5 lg:col-span-2"><div className="flex justify-between"><h2 className="text-xl font-black">登录会话</h2><button className="btn" onClick={loadSessions}>刷新</button></div><div className="mt-4 grid gap-2">{sessions.map(s=><div key={s.id} className="rounded-2xl bg-slate-50 p-3"><b>{s.ip || '-'}</b><div className="muted">{s.user_agent || '-'}</div><div className="muted">创建：{fmtDate(s.created_at)} · 过期：{fmtDate(s.expires_at)}</div></div>)}</div></div></div>; }
function SettingsPage({ toast }: any) {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api<{ items: Record<string, string> }>('/api/settings').then(d => {
      setSettings(d.items || {});
      setEditing(d.items || {});
      setLoaded(true);
    }).catch((e: any) => toast(e.message || '加载设置失败', 'danger'));
  }, []);

  async function save() {
    setBusy(true);
    try {
      const changes: Record<string, string> = {};
      for (const k of Object.keys(editing)) {
        if (editing[k] !== (settings[k] || '')) changes[k] = editing[k];
      }
      if (Object.keys(changes).length === 0) { toast('没有更改'); setBusy(false); return; }
      await api('/api/settings', { method: 'PUT', body: JSON.stringify(changes) });
      setSettings({ ...editing });
      toast('设置已保存');
    } catch (e: any) { toast(e.message || '保存失败', 'danger'); } finally { setBusy(false); }
  }

  if (!loaded) return <div className="card p-6 text-center text-slate-500">加载中...</div>;

  const fields: Array<[string, string, string, string?]> = [
    ['site_name', '站点名称', editing.site_name || '', '显示在面板标题和 Agent 安装脚本中'],
    ['agent_interval', '心跳间隔（秒）', editing.agent_interval || '30', 'Agent 上报心跳的间隔，5-300 秒'],
    ['session_ttl_hours', '会话有效期（小时）', editing.session_ttl_hours || '72', '登录会话的过期时间，1-8760 小时'],
    ['audit_retention_days', '审计日志保留天数', editing.audit_retention_days || '90', '超过保留天数的审计日志会被自动清理，7-3650 天'],
    ['webhook_url', 'Webhook URL', editing.webhook_url || '', '事件通知的 HTTPS URL，留空关闭'],
    ['webhook_secret', 'Webhook 密钥', editing.webhook_secret || '', '用于签名 Webhook 请求的密钥'],
  ];

  return <div className="grid gap-5">
    <div className="card p-6">
      <h2 className="text-xl font-black">系统设置</h2>
      <p className="muted mt-2">配置站点名称、Agent 心跳间隔、会话有效期和 Webhook 通知。仅管理员可修改。</p>
      <div className="mt-5 grid gap-5">
        {fields.map(([key, label, value, hint]) => (
          <label key={key} className="label">
            {label}
            <input className="input" value={editing[key] || ''} onChange={e => setEditing({ ...editing, [key]: e.target.value })} placeholder={hint || label} />
            {hint && <span className="text-xs text-slate-400">{hint}</span>}
          </label>
        ))}
      </div>
      <button className="btn btn-primary mt-6" disabled={busy} onClick={save}>{busy ? '保存中...' : '保存设置'}</button>
    </div>
  </div>;
}

function SecurityPage(){ return <div className="card p-6 leading-8 text-slate-700"><h2 className="text-xl font-black text-slate-950">安全说明</h2><p className="mt-4"><b>两步验证（TOTP）：</b>支持 TOTP 两步验证，启用后登录需提供动态验证码，密钥通过 PBKDF2 安全存储。</p><p><b>密码安全：</b>用户密码使用 PBKDF2 加盐哈希存储，不可逆，面板不会以明文保存密码。</p><p><b>会话管理：</b>基于 Cookie 的会话认证，Cookie 设置 SameSite=Lax 防 CSRF，会话绑定服务端存储并支持强制下线。</p><p><b>节点接入：</b>Agent 注册使用一次性 Token，注册后即失效。后续心跳使用节点密钥签名，无需传输密码。</p><p><b>防火墙托管：</b>严格模式会先进入 60 秒待确认窗口；管理员需在面板确认后才长期保持，未确认时 Agent 自动回滚至宽松模式，确保 SSH 不丢失。</p><p><b>设置接口安全：</b>系统设置 API 仅接受白名单内的键名，Webhook URL 经过 SSRF 防护校验，禁止指向内网地址。</p><p><b>前端安全：</b>不使用 CDN，不加载远程字体或第三方统计脚本，所有前端资源编译后内嵌到 Go 二进制中，无外部依赖。</p></div>; }

function ModalHost({ modal, setModal, nodes, users, currentUser, setUser, refreshAll, toast }: any) {
  if (!modal) return null;
  const close = () => setModal(null);
  return <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/40 p-4 backdrop-blur-sm animate-fade-in" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
    {modal.kind === 'confirm' && <div className="card w-full max-w-md p-6 animate-slide-up"><h2 className="text-xl font-black">{modal.title}</h2><p className="mt-3 text-slate-600">{modal.message}</p><div className="mt-6 flex justify-end gap-2"><button className="btn" onClick={close}>取消</button><button className={cn('btn', modal.danger ? 'btn-danger' : 'btn-primary')} onClick={async()=>{ try { await modal.onConfirm(); close(); } catch (e: any) { toast(e.message || '操作失败', 'danger'); close(); } }}>确认</button></div></div>}
    {modal.kind === 'token' && <TokenModal close={close} toast={toast} refreshAll={refreshAll} />}
    {modal.kind === 'node' && <NodeModal node={modal.node} close={close} toast={toast} refreshAll={refreshAll} confirm={(m:string, cb:()=>void)=>setModal({ kind:'confirm', title:'启用严格防火墙托管', message:m, danger:true, onConfirm: cb })} />}
    {modal.kind === 'rule' && <RuleModal rule={modal.rule} nodes={nodes} users={users} currentUser={currentUser} close={close} toast={toast} refreshAll={refreshAll} />}
    {modal.kind === 'node-detail' && <Drawer title={`节点详情：${modal.node.name}`} close={close}><NodeDetail node={modal.node} /></Drawer>}
    {modal.kind === 'rule-detail' && <Drawer title={`规则详情：${modal.rule.name}`} close={close}><RuleDetail rule={modal.rule} nodes={nodes} users={users} /></Drawer>}
    {modal.kind === 'user' && <UserModal user={modal.user} nodes={nodes} close={close} toast={toast} refreshAll={refreshAll} />}
    {modal.kind === 'totp' && <TotpModal close={close} toast={toast} user={currentUser} setUser={setUser} />}
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

function RuleModal({ rule, nodes, users, currentUser, close, toast, refreshAll }: any) { async function submit(e: React.FormEvent<HTMLFormElement>){ e.preventDefault(); const fd = Object.fromEntries(new FormData(e.currentTarget)); const nodeId = String(fd.node_id || ''); const selNode = nodes.find((n: NodeItem) => n.id === nodeId); const lp = +(String(fd.listen_port || '0')); if (selNode && lp > 0) { if (selNode.port_range_start > 0 && lp < selNode.port_range_start) { toast(`监听端口 ${lp} 不在节点端口范围 (${selNode.port_range_start}-${selNode.port_range_end}) 内`, 'danger'); return; } if (selNode.port_range_end > 0 && lp > selNode.port_range_end) { toast(`监听端口 ${lp} 不在节点端口范围 (${selNode.port_range_start}-${selNode.port_range_end}) 内`, 'danger'); return; } } let exp = null; if (fd.expire_at) { const d = new Date(String(fd.expire_at)); d.setHours(23,59,59,999); exp = d.toISOString(); } const payload:any = { ...rule, ...fd, user_id: users.length ? fd.user_id : (rule?.user_id || currentUser?.id), listen_port:lp, target_port:+String(fd.target_port), speed_limit_mbps:+String(fd.speed_limit_mbps||0), max_connections:+String(fd.max_connections||0), traffic_limit:Math.round((+String(fd.traffic_limit_gb||0))*1024*1024*1024), expire_at:exp, enabled:fd.enabled === 'true', firewall_managed:true, source_cidrs: String(fd.source_cidrs || '').split(',').map(x=>x.trim()).filter(Boolean), tags: String(fd.tags || '').split(',').map(x=>x.trim()).filter(Boolean) }; delete payload.traffic_limit_gb; try { await api(rule?.id ? `/api/rules/${rule.id}` : '/api/rules', { method: rule?.id ? 'PUT':'POST', body: JSON.stringify(payload) }); toast('规则已保存'); close(); await refreshAll(true); } catch (e: any) { toast(e.message || '保存失败', 'danger'); } }
  return <div className="card max-h-[90vh] w-full max-w-3xl overflow-auto p-6 animate-slide-up"><div className="flex justify-between"><h2 className="text-xl font-black">{rule?.id?'编辑':'新增'}转发规则</h2><button className="btn" onClick={close}>关闭</button></div><form onSubmit={submit} className="field-grid mt-5"><label className="label">规则名称<input className="input" name="name" defaultValue={rule?.name || ''} required /></label><label className="label">节点<select className="input" name="node_id" defaultValue={rule?.node_id || nodes[0]?.id}>{nodes.map((n:NodeItem)=><option key={n.id} value={n.id}>{n.name}</option>)}</select></label>{users.length>0 && <label className="label">所属用户<select className="input" name="user_id" defaultValue={rule?.user_id || users[0]?.id}>{users.map((u:User)=><option key={u.id} value={u.id}>{u.username}（{roleText(u.role)}）</option>)}</select></label>}<label className="label">协议<select className="input" name="protocol" defaultValue={rule?.protocol || 'tcp'}><option value="tcp">TCP</option><option value="udp">UDP</option><option value="both">TCP + UDP</option></select></label><label className="label">监听端口<input className="input" type="number" name="listen_port" defaultValue={rule?.listen_port || ''} required /></label><label className="label">目标端口<input className="input" type="number" name="target_port" defaultValue={rule?.target_port || ''} required /></label><label className="label md:col-span-2">目标地址<input className="input" name="target_host" defaultValue={rule?.target_host || ''} required /></label><label className="label">限速 Mbps<input className="input" name="speed_limit_mbps" type="number" defaultValue={rule?.speed_limit_mbps || 0} /></label><label className="label">最大连接数<input className="input" name="max_connections" type="number" defaultValue={rule?.max_connections || 0} /></label><label className="label">状态<select className="input" name="enabled" defaultValue={String(rule?.enabled ?? true)}><option value="true">启用</option><option value="false">停用</option></select></label><label className="label">规则流量上限 GB<input className="input" name="traffic_limit_gb" type="number" defaultValue={rule?.traffic_limit ? Math.round(Number(rule.traffic_limit)/1024/1024/1024) : 0} /></label><label className="label">到期日期<input className="input" name="expire_at" type="date" defaultValue={(rule?.expire_at || '').slice(0,10)} /></label><label className="label md:col-span-2">来源 IP/CIDR 白名单<input className="input" name="source_cidrs" defaultValue={(rule?.source_cidrs || []).join(', ')} /></label><label className="label md:col-span-2">标签（逗号分隔）<input className="input" name="tags" defaultValue={(rule?.tags || []).join(', ')} placeholder="例如：生产环境,重要服务" /></label><label className="label md:col-span-2">备注<textarea className="input" name="description" defaultValue={rule?.description || ''} /></label><button className="btn btn-primary md:col-span-2">保存</button></form></div> }

function UserModal({ user, nodes, close, toast, refreshAll }: any) { async function submit(e:React.FormEvent<HTMLFormElement>){ e.preventDefault(); const fd = new FormData(e.currentTarget); const payload:any = { id:user?.id, username:fd.get('username'), password:fd.get('password') || '', role:fd.get('role'), rule_limit:+String(fd.get('rule_limit')||0), traffic_limit:Math.round((+String(fd.get('traffic_limit_gb')||0))*1024*1024*1024), port_range_start:+String(fd.get('port_range_start')||0), port_range_end:+String(fd.get('port_range_end')||0), expires_at:fd.get('expires_at') || '', disabled:fd.get('disabled')==='true', must_change:fd.get('must_change')==='true', allowed_node_ids:fd.getAll('allowed_node_ids') }; await api(user?.id ? `/api/users/${user.id}` : '/api/users', { method: user?.id ? 'PUT':'POST', body: JSON.stringify(payload) }); toast('用户已保存'); close(); await refreshAll(true); }
  const allowed = new Set(user?.allowed_node_ids || []); return <div className="card max-h-[90vh] w-full max-w-3xl overflow-auto p-6 animate-slide-up"><div className="flex justify-between"><h2 className="text-xl font-black">{user?.id?'编辑':'新增'}用户</h2><button className="btn" onClick={close}>关闭</button></div><form onSubmit={submit} className="field-grid mt-5"><label className="label">用户名<input className="input" name="username" defaultValue={user?.username||''} required /></label><label className="label">角色<select className="input" name="role" defaultValue={user?.role||'user'}><option value="user">普通用户</option><option value="admin">管理员</option><option value="super_admin">超级管理员</option></select></label><label className="label md:col-span-2">密码{user?.id?'（留空不修改）':''}<input className="input" type="password" name="password" /></label><label className="label">规则数量上限<input className="input" type="number" name="rule_limit" defaultValue={user?.rule_limit||0} /></label><label className="label">总流量额度 GB<input className="input" type="number" name="traffic_limit_gb" defaultValue={user?.traffic_limit ? Math.round(Number(user.traffic_limit)/1024/1024/1024) : 0} /></label><label className="label">端口范围开始<input className="input" type="number" name="port_range_start" defaultValue={user?.port_range_start||0} /></label><label className="label">端口范围结束<input className="input" type="number" name="port_range_end" defaultValue={user?.port_range_end||0} /></label><label className="label">到期日期<input className="input" type="date" name="expires_at" defaultValue={(user?.expires_at||'').slice(0,10)} /></label><label className="label">账号状态<select className="input" name="disabled" defaultValue={String(user?.disabled||false)}><option value="false">正常</option><option value="true">禁用</option></select></label><label className="label md:col-span-2"><span>允许使用的节点（全不选表示不限制）</span><div className="grid gap-2 rounded-2xl bg-slate-50 p-4">{nodes.map((n:NodeItem)=><label key={n.id} className="flex gap-2 text-sm"><input type="checkbox" name="allowed_node_ids" value={n.id} defaultChecked={allowed.has(n.id)} />{n.name}</label>)}</div></label><label className="flex gap-2 text-sm md:col-span-2"><input type="checkbox" name="must_change" value="true" defaultChecked={user?.must_change} />下次登录必须修改密码</label><button className="btn btn-primary md:col-span-2">保存</button></form></div> }
function NodeDetail({ node }: { node: NodeItem }) { const fw = firewallStatus(node); const m = node.last_metrics || {}; return <div className="grid gap-4"><Info title="状态" value={online(node)?'在线':'离线'} /><Info title="公网 IP" value={node.public_ip||'-'} /><Info title="系统" value={`${node.os||'-'} / ${node.arch||'-'}`} /><Info title="Agent" value={node.agent_version||'-'} /><Info title="最近心跳" value={fmtDate(node.last_seen_at)} /><Info title="防火墙" value={`${fw.text}${fw.note ? ' · ' + fw.note : ''}`} /><Info title="端口范围" value={`${node.port_range_start || '-'} - ${node.port_range_end || '-'}`} /><Info title="内存" value={`${fmtBytes(m.memory_used)} / ${fmtBytes(m.memory_total)}`} /></div>; }
function RuleDetail({ rule, nodes, users }: any) { const [tests, setTests] = useState<ConnectivityTest[]>([]); useEffect(()=>{ api<{items:ConnectivityTest[]}>(`/api/connectivity-tests?rule_id=${encodeURIComponent(rule.id)}&limit=20`).then(d=>setTests(d.items||[])).catch(()=>{}); }, [rule.id]); const nodeName = nodes.find((n:NodeItem)=>n.id===rule.node_id)?.name || rule.node_id; const owner = users.find((u:User)=>u.id===rule.user_id)?.username || rule.user_id; return <div className="grid gap-4"><Info title="协议" value={protocolText(rule.protocol)} /><Info title="监听" value={`${nodeName} :${rule.listen_port}`} /><Info title="目标" value={`${rule.target_host}:${rule.target_port}`} /><Info title="来源白名单" value={(rule.source_cidrs||[]).join(', ') || '不限'} /><Info title="规则流量" value={`${fmtBytes(rule.traffic_used)}${rule.traffic_limit ? ' / ' + fmtBytes(rule.traffic_limit) : ' / 不限'}`} /><Info title="归属用户" value={owner} /><h3 className="mt-3 font-black">检测历史</h3>{tests.map(t=><div key={t.id} className="rounded-2xl bg-slate-50 p-3"><b>{t.status}</b><div className="muted">{fmtDate(t.created_at)} · TCP {t.target_tcp_ok?'正常':'-'} · UDP {t.target_udp_ok?'已发送':'-'} · Ping {t.ping_ok ? `${t.ping_latency_ms||0} ms` : '-'}</div>{t.error && <div className="text-rose-600">{t.error}</div>}</div>)}</div>; }
function Info({ title, value }: { title:string; value:React.ReactNode }) { return <div className="rounded-2xl bg-slate-50 p-4"><div className="text-xs font-bold uppercase tracking-wider text-slate-400">{title}</div><div className="mt-1 font-semibold text-slate-800">{value}</div></div>; }
function TotpModal({ close, toast, user, setUser }: any) {
  const [step, setStep] = useState<'choose' | 'setup' | 'verify' | 'disable'>('choose');
  const [secret, setSecret] = useState('');
  const [uri, setUri] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  if (user?.totp_enabled && step === 'choose') {
    return <div className="card w-full max-w-xl p-6 animate-slide-up">
      <div className="flex justify-between"><h2 className="text-xl font-black">两步验证管理</h2><button className="btn" onClick={close}>关闭</button></div>
      <p className="muted mt-3">两步验证已启用。关闭后账号安全性将降低。</p>
      <div className="mt-5 grid gap-4">
        <label className="label">当前密码<input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)} required /></label>
        <label className="label">两步验证码<input className="input" inputMode="numeric" placeholder="输入验证器中的6位数字" value={code} onChange={e => setCode(e.target.value)} required /></label>
        <button className="btn btn-danger" disabled={busy || !password || !code} onClick={async () => {
          setBusy(true);
          try {
            const d = await api<{ ok: boolean; user: User }>('/api/account/totp/disable', { method: 'POST', body: JSON.stringify({ password, code }) });
            setUser(d.user);
            toast('两步验证已关闭');
            close();
          } catch (err: any) { toast(err.message || '操作失败', 'danger'); } finally { setBusy(false); }
        }}>{busy ? '处理中...' : '关闭两步验证'}</button>
      </div>
    </div>;
  }

  if (step === 'setup') {
    return <div className="card w-full max-w-xl p-6 animate-slide-up">
      <div className="flex justify-between"><h2 className="text-xl font-black">启用两步验证 - 第2步</h2><button className="btn" onClick={close}>取消</button></div>
      <p className="muted mt-3">请使用验证器应用（如 Google Authenticator、Microsoft Authenticator）扫描下方链接或手动输入密钥。</p>
      <div className="mt-4 grid gap-4">
        <div className="rounded-2xl bg-slate-50 p-4">
          <div className="text-xs font-bold text-slate-500 mb-2">验证器链接（点击可复制）</div>
          <textarea className="input min-h-20 font-mono text-xs break-all" readOnly value={uri} onClick={e => { (e.target as HTMLTextAreaElement).select(); copyText(uri, toast); }} />
        </div>
        <div className="rounded-2xl bg-slate-50 p-4">
          <div className="text-xs font-bold text-slate-500 mb-2">手动输入密钥</div>
          <div className="flex items-center gap-2">
            <code className="rounded-xl bg-white px-3 py-2 text-sm font-bold tracking-widest">{secret}</code>
            <button className="btn btn-xs" onClick={() => copyText(secret, toast)}>复制</button>
          </div>
        </div>
        <div className="rounded-2xl bg-amber-50 p-4 text-sm text-amber-800">请确保已将验证器设置完成后再继续，启用后需要输入验证码才能完成。</div>
        <label className="label">当前密码<input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)} required /></label>
        <label className="label">验证码<input className="input" inputMode="numeric" placeholder="输入验证器中的6位数字" value={code} onChange={e => setCode(e.target.value)} required /></label>
        <button className="btn btn-primary" disabled={busy || !password || !code} onClick={async () => {
          setBusy(true);
          try {
            const d = await api<{ ok: boolean; user: User }>('/api/account/totp/enable', { method: 'POST', body: JSON.stringify({ password, code }) });
            setUser(d.user);
            toast('两步验证已启用！其他登录会话已注销');
            close();
          } catch (err: any) { toast(err.message || '启用失败', 'danger'); } finally { setBusy(false); }
        }}>{busy ? '验证中...' : '确认启用'}</button>
      </div>
    </div>;
  }

  return <div className="card w-full max-w-xl p-6 animate-slide-up">
    <div className="flex justify-between"><h2 className="text-xl font-black">启用两步验证 - 第1步</h2><button className="btn" onClick={close}>取消</button></div>
    <p className="muted mt-3">启用两步验证后，登录时除了密码还需要输入动态验证码，显著提升账号安全性。</p>
    <div className="mt-5 rounded-2xl bg-slate-50 p-4 text-sm text-slate-600">
      <div className="font-bold text-slate-800">步骤说明：</div>
      <ol className="mt-2 grid gap-1 list-decimal pl-5">
        <li>点击下方按钮生成两步验证密钥</li>
        <li>使用验证器应用扫描或手动输入密钥</li>
        <li>输入当前密码和验证码完成启用</li>
      </ol>
    </div>
    <button className="btn btn-primary mt-5" disabled={busy} onClick={async () => {
      setBusy(true);
      try {
        const d = await api<{ secret: string; uri: string }>('/api/account/totp/setup', { method: 'POST' });
        setSecret(d.secret);
        setUri(d.uri);
        setStep('setup');
      } catch (err: any) { toast(err.message || '生成密钥失败', 'danger'); } finally { setBusy(false); }
    }}>{busy ? '生成中...' : '生成两步验证密钥'}</button>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
