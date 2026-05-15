import { useState, useEffect } from 'react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';
import { RefreshCw, Plus, RotateCcw, Download } from 'lucide-react';

export default function BackupPage() {
  const { isAdmin } = useAuth();
  const toast = useToast();
  const [backups, setBackups] = useState([]);
  const [loading, setLoading] = useState(true);

  const refresh = () => {
    setLoading(true);
    api.backups().then(setBackups).catch(() => toast.error('加载失败')).finally(() => setLoading(false));
  };

  useEffect(() => { if (isAdmin) refresh(); }, [isAdmin]);

  const createBackup = async () => {
    try { await api.createBackup(); toast.success('备份已创建'); refresh(); }
    catch (e) { toast.error(e.message); }
  };

  const restoreBackup = async (name) => {
    if (!confirm(`确定恢复备份 "${name}"？当前数据将被覆盖！`)) return;
    try { await api.restoreBackup(name); toast.success('备份已恢复'); refresh(); }
    catch (e) { toast.error(e.message); }
  };

  if (!isAdmin) return <div className="text-center py-20 text-slate-400">需要管理员权限</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="text-sm text-slate-500">备份存储在服务器 /etc/relayguard/ 目录下</div>
        <div className="flex gap-2">
          <button onClick={createBackup} className="btn-primary"><Plus className="w-4 h-4" /> 创建备份</button>
          <button onClick={refresh} className="btn-ghost"><RefreshCw className="w-4 h-4" /></button>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-700">
              <th className="px-6 py-3 font-medium">名称</th>
              <th className="px-6 py-3 font-medium">大小</th>
              <th className="px-6 py-3 font-medium">创建时间</th>
              <th className="px-6 py-3 font-medium">操作</th>
            </tr></thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={4} className="px-6 py-12 text-center text-slate-400">加载中...</td></tr>
              ) : backups.length === 0 ? (
                <tr><td colSpan={4} className="px-6 py-12 text-center text-slate-400">暂无备份</td></tr>
              ) : backups.map(b => (
                <tr key={b.name || b.id} className="border-b border-slate-50 dark:border-slate-800/50 hover:bg-slate-50 dark:hover:bg-slate-800/30">
                  <td className="px-6 py-3 font-medium font-mono text-xs">{b.name}</td>
                  <td className="px-6 py-3 text-slate-500">{b.size ? (b.size / 1024 / 1024).toFixed(1) + ' MB' : '-'}</td>
                  <td className="px-6 py-3 text-slate-500 text-xs">{b.created_at ? new Date(b.created_at).toLocaleString('zh-CN') : '-'}</td>
                  <td className="px-6 py-3">
                    <button onClick={() => restoreBackup(b.name)} className="btn-xs btn-ghost" title="恢复"><RotateCcw className="w-3 h-3 mr-1" />恢复</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
