import { useState, useEffect } from 'react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';
import Badge from '../components/Badge';
import { RefreshCw } from 'lucide-react';

export default function AuditPage() {
  const { isAdmin } = useAuth();
  const toast = useToast();
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);

  const refresh = () => {
    setLoading(true);
    api.auditLogs(200).then(setLogs).catch(() => toast.error('加载失败')).finally(() => setLoading(false));
  };

  useEffect(() => { if (isAdmin) refresh(); }, [isAdmin]);

  if (!isAdmin) return <div className="text-center py-20 text-slate-400">需要管理员权限</div>;

  const actionColors = {
    login: 'ok', create: 'ok', update: 'warn', delete: 'danger', toggle: 'warn', reset: 'warn', enable: 'ok', disable: 'danger',
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div />
        <button onClick={refresh} className="btn-ghost"><RefreshCw className="w-4 h-4" /> 刷新</button>
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-700">
              <th className="px-6 py-3 font-medium">时间</th>
              <th className="px-6 py-3 font-medium">用户</th>
              <th className="px-6 py-3 font-medium">操作</th>
              <th className="px-6 py-3 font-medium">目标</th>
              <th className="px-6 py-3 font-medium">详情</th>
            </tr></thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={5} className="px-6 py-12 text-center text-slate-400">加载中...</td></tr>
              ) : logs.length === 0 ? (
                <tr><td colSpan={5} className="px-6 py-12 text-center text-slate-400">暂无审计日志</td></tr>
              ) : logs.map(l => (
                <tr key={l.id} className="border-b border-slate-50 dark:border-slate-800/50 hover:bg-slate-50 dark:hover:bg-slate-800/30">
                  <td className="px-6 py-3 text-slate-500 text-xs">{l.created_at ? new Date(l.created_at).toLocaleString('zh-CN') : '-'}</td>
                  <td className="px-6 py-3">{l.username || '-'}</td>
                  <td className="px-6 py-3"><Badge status={actionColors[l.action] || 'muted'} label={l.action} /></td>
                  <td className="px-6 py-3 font-mono text-xs">{l.target_type}/{l.target_id?.slice(0, 8) || '-'}</td>
                  <td className="px-6 py-3 text-slate-500 text-xs max-w-xs truncate">{l.detail || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
