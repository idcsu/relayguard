import { useState, useEffect } from 'react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';
import Badge from '../components/Badge';
import Drawer from '../components/Drawer';
import { RefreshCw, Search } from 'lucide-react';

export default function NodesPage() {
  const { isAdmin } = useAuth();
  const toast = useToast();
  const [nodes, setNodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null);

  const refresh = () => {
    setLoading(true);
    api.nodes().then(setNodes).catch(() => toast.error('加载失败')).finally(() => setLoading(false));
  };

  useEffect(() => { refresh(); }, []);

  const filtered = nodes.filter(n => !search || n.name?.includes(search) || n.id?.includes(search) || n.public_ip?.includes(search));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input className="input pl-9 w-64" placeholder="搜索节点..." value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>
        <button onClick={refresh} className="btn-ghost"><RefreshCw className="w-4 h-4" /> 刷新</button>
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-700">
              <th className="px-6 py-3 font-medium">名称</th>
              <th className="px-6 py-3 font-medium">公网 IP</th>
              <th className="px-6 py-3 font-medium">状态</th>
              <th className="px-6 py-3 font-medium">系统</th>
              <th className="px-6 py-3 font-medium">CPU</th>
              <th className="px-6 py-3 font-medium">内存</th>
              <th className="px-6 py-3 font-medium">最后心跳</th>
            </tr></thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="px-6 py-12 text-center text-slate-400">加载中...</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={7} className="px-6 py-12 text-center text-slate-400">暂无节点数据</td></tr>
              ) : filtered.map(n => (
                <tr key={n.id} className="border-b border-slate-50 dark:border-slate-800/50 hover:bg-slate-50 dark:hover:bg-slate-800/30 cursor-pointer" onClick={() => setSelected(n)}>
                  <td className="px-6 py-3 font-medium">{n.name}</td>
                  <td className="px-6 py-3 text-slate-500 font-mono text-xs">{n.public_ip || '-'}</td>
                  <td className="px-6 py-3"><Badge status={n.online ? 'online' : 'offline'} label={n.online ? '在线' : '离线'} /></td>
                  <td className="px-6 py-3 text-slate-500 text-xs">{n.os || '-'}</td>
                  <td className="px-6 py-3 text-slate-500">{n.cpu_percent != null ? `${n.cpu_percent}%` : '-'}</td>
                  <td className="px-6 py-3 text-slate-500 text-xs">{n.memory_used != null ? `${n.memory_used}/${n.memory_total}` : '-'}</td>
                  <td className="px-6 py-3 text-slate-500 text-xs">{n.last_heartbeat ? new Date(n.last_heartbeat).toLocaleString('zh-CN') : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Drawer open={!!selected} onClose={() => setSelected(null)} title={selected?.name || '节点详情'} wide>
        {selected && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div><span className="text-slate-500">ID：</span><span className="font-mono">{selected.id}</span></div>
              <div><span className="text-slate-500">状态：</span><Badge status={selected.online ? 'online' : 'offline'} /></div>
              <div><span className="text-slate-500">公网 IP：</span><span className="font-mono">{selected.public_ip || '-'}</span></div>
              <div><span className="text-slate-500">内网 IP：</span><span className="font-mono">{selected.private_ip || '-'}</span></div>
              <div><span className="text-slate-500">系统：</span>{selected.os || '-'}</div>
              <div><span className="text-slate-500">CPU：</span>{selected.cpu_percent != null ? `${selected.cpu_percent}%` : '-'}</div>
              <div><span className="text-slate-500">内存：</span>{selected.memory_used || '-'}/{selected.memory_total || '-'}</div>
              <div><span className="text-slate-500">磁盘：</span>{selected.disk_used || '-'}/{selected.disk_total || '-'}</div>
            </div>
            {isAdmin && selected.secret && (
              <div className="text-sm"><span className="text-slate-500">密钥：</span><span className="font-mono text-xs break-all">{selected.secret}</span></div>
            )}
          </div>
        )}
      </Drawer>
    </div>
  );
}