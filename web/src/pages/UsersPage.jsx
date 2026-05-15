import { useState, useEffect } from 'react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';
import Badge from '../components/Badge';
import Modal from '../components/Modal';
import { RefreshCw, Plus, RotateCcw } from 'lucide-react';

export default function UsersPage() {
  const { isAdmin } = useAuth();
  const toast = useToast();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  const refresh = () => {
    setLoading(true);
    api.users().then(setUsers).catch(() => toast.error('加载失败')).finally(() => setLoading(false));
  };

  useEffect(() => { if (isAdmin) refresh(); }, [isAdmin]);

  const resetTraffic = async (id) => {
    if (!confirm('确定重置此用户的流量？')) return;
    try { await api.resetUserTraffic(id); toast.success('流量已重置'); refresh(); }
    catch (e) { toast.error(e.message); }
  };

  const deleteUser = async (id) => {
    if (!confirm('确定删除此用户？此操作不可撤销！')) return;
    try { await api.deleteUser(id); toast.success('已删除'); refresh(); }
    catch (e) { toast.error(e.message); }
  };

  if (!isAdmin) return <div className="text-center py-20 text-slate-400">需要管理员权限</div>;

  const fmt = (n) => {
    if (n == null) return '0';
    if (n >= 1e9) return (n / 1e9).toFixed(1) + ' GB';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB';
    return n + ' B';
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div />
        <div className="flex gap-2">
          <button onClick={() => setShowCreate(true)} className="btn-primary"><Plus className="w-4 h-4" /> 新建用户</button>
          <button onClick={refresh} className="btn-ghost"><RefreshCw className="w-4 h-4" /></button>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-700">
              <th className="px-6 py-3 font-medium">用户名</th>
              <th className="px-6 py-3 font-medium">角色</th>
              <th className="px-6 py-3 font-medium">流量</th>
              <th className="px-6 py-3 font-medium">流量上限</th>
              <th className="px-6 py-3 font-medium">两步验证</th>
              <th className="px-6 py-3 font-medium">操作</th>
            </tr></thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} className="px-6 py-12 text-center text-slate-400">加载中...</td></tr>
              ) : users.length === 0 ? (
                <tr><td colSpan={6} className="px-6 py-12 text-center text-slate-400">暂无用户</td></tr>
              ) : users.map(u => (
                <tr key={u.id} className="border-b border-slate-50 dark:border-slate-800/50 hover:bg-slate-50 dark:hover:bg-slate-800/30">
                  <td className="px-6 py-3 font-medium">{u.username}</td>
                  <td className="px-6 py-3"><Badge status={u.role === 'admin' || u.role === 'super_admin' ? 'ok' : 'muted'} label={u.role} /></td>
                  <td className="px-6 py-3 font-mono text-xs">{fmt(u.traffic_used)}</td>
                  <td className="px-6 py-3 font-mono text-xs">{u.traffic_limit ? fmt(u.traffic_limit) : '无限制'}</td>
                  <td className="px-6 py-3"><Badge status={u.totp_enabled ? 'ok' : 'muted'} label={u.totp_enabled ? '已启用' : '未启用'} /></td>
                  <td className="px-6 py-3">
                    <div className="flex gap-1">
                      <button onClick={() => resetTraffic(u.id)} className="btn-xs btn-ghost" title="重置流量"><RotateCcw className="w-3 h-3" /></button>
                      <button onClick={() => deleteUser(u.id)} className="btn-xs btn-danger" title="删除">×</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="新建用户">
        <UserForm onSave={async (data) => {
          try { await api.createUser(data); toast.success('用户已创建'); setShowCreate(false); refresh(); }
          catch (e) { toast.error(e.message); }
        }} />
      </Modal>
    </div>
  );
}

function UserForm({ onSave }) {
  const [form, setForm] = useState({ username: '', password: '', role: 'user', traffic_limit: '' });
  const handleSubmit = (e) => {
    e.preventDefault();
    onSave({ ...form, traffic_limit: form.traffic_limit ? Number(form.traffic_limit) : 0 });
  };
  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div><label className="label">用户名</label><input className="input" value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} required /></div>
      <div><label className="label">密码</label><input className="input" type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} required /></div>
      <div><label className="label">角色</label>
        <select className="input" value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}>
          <option value="user">普通用户</option><option value="admin">管理员</option>
        </select>
      </div>
      <div><label className="label">流量上限 (字节，0=无限)</label><input className="input" type="number" value={form.traffic_limit} onChange={e => setForm({ ...form, traffic_limit: e.target.value })} /></div>
      <div className="flex justify-end gap-2"><button type="submit" className="btn-primary">创建</button></div>
    </form>
  );
}