import { useState, useEffect } from 'react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import StatCard from '../components/StatCard';
import { Server, ArrowLeftRight, Users, Activity } from 'lucide-react';

export default function DashboardPage() {
  const { isAdmin } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = () => {
    setLoading(true);
    api.dashboard().then(setData).catch(() => {}).finally(() => setLoading(false));
  };

  useEffect(() => { refresh(); }, []);

  if (loading && !data) return <div className="text-center py-20 text-slate-400">加载中...</div>;

  const fmt = (n) => {
    if (n == null) return '0';
    if (n >= 1e12) return (n / 1e12).toFixed(1) + ' TB';
    if (n >= 1e9) return (n / 1e9).toFixed(1) + ' GB';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + ' KB';
    return n + ' B';
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {isAdmin && (
          <StatCard icon={Server} label="节点" value={`${data?.online_nodes || 0} / ${data?.nodes || 0}`} sub="在线 / 总数" color="brand" />
        )}
        <StatCard icon={ArrowLeftRight} label="规则" value={`${data?.enabled_rules || 0} / ${data?.rules || 0}`} sub="启用 / 总数" color="emerald" />
        {isAdmin && (
          <StatCard icon={Users} label="用户" value={String(data?.users || 0)} color="amber" />
        )}
        <StatCard icon={Activity} label="流量" value={fmt(data?.traffic_used)} color="rose" />
      </div>

      {data?.top_rules?.length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 font-bold">热门规则</div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-slate-500 border-b border-slate-100 dark:border-slate-800">
                <th className="px-6 py-3 font-medium">名称</th>
                <th className="px-6 py-3 font-medium">节点</th>
                <th className="px-6 py-3 font-medium">转发</th>
                <th className="px-6 py-3 font-medium text-right">流量</th>
              </tr></thead>
              <tbody>
                {data.top_rules.map(r => (
                  <tr key={r.id} className="border-b border-slate-50 dark:border-slate-800/50 hover:bg-slate-50 dark:hover:bg-slate-800/30">
                    <td className="px-6 py-3 font-medium">{r.name}</td>
                    <td className="px-6 py-3 text-slate-500">{r.node_name || r.node_id}</td>
                    <td className="px-6 py-3 text-slate-500">{r.listen_port} → {r.target_host}:{r.target_port}</td>
                    <td className="px-6 py-3 text-right font-mono">{fmt(r.traffic_used)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {data?.nodes_overview?.length > 0 && isAdmin && (
        <div className="card overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 font-bold">节点概览</div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 p-6">
            {data.nodes_overview.map(n => (
              <div key={n.id} className="rounded-xl border border-slate-200 dark:border-slate-700 p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-medium">{n.name}</span>
                  <span className={n.online ? 'badge-ok' : 'badge-danger'}>{n.online ? '在线' : '离线'}</span>
                </div>
                <div className="text-xs text-slate-500 space-y-1">
                  <div>CPU: {n.cpu_percent ?? 0}% | 内存: {n.memory_used ?? 0}/{n.memory_total ?? 0}</div>
                  <div>规则: {n.rule_count ?? 0} | 流量: {fmt(n.traffic_used)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {!isAdmin && <p className="text-sm text-slate-400">更多数据请登录管理员账号查看</p>}
    </div>
  );
}