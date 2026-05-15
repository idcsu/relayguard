import { useState, useEffect } from 'react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';
import Badge from '../components/Badge';
import Modal from '../components/Modal';
import Drawer from '../components/Drawer';
import { RefreshCw, Search, Plus, Copy, Play, Square, TestTube2, RotateCcw, Tag } from 'lucide-react';

export default function RulesPage() {
  const { isAdmin } = useAuth();
  const toast = useToast();
  const [rules, setRules] = useState([]);
  const [nodes, setNodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [selected, setSelected] = useState(null);
  const [showCreate, setShowCreate] = useState(false);

  const refresh = () => {
    setLoading(true);
    Promise.all([api.rules(), api.nodes()])
      .then(([r, n]) => { setRules(r); setNodes(n); })
      .catch(() => toast.error('加载失败'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { refresh(); }, []);

  const toggleRule = async (id) => {
    try {
      await api.toggleRule(id);
      toast.success('操作成功');
      refresh();
    } catch (e) { toast.error(e.message); }
  };

  const cloneRule = async (id) => {
    try {
      await api.cloneRule(id);
      toast.success('规则已克隆');
      refresh();
    } catch (e) { toast.error(e.message); }
  };

  const resetTraffic = async (id) => {
    try {
      await api.resetRuleTraffic(id);
      toast.success('流量已重置');
      refresh();
    } catch (e) { toast.error(e.message); }
  };

  const deleteRule = async (id) => {
    if (!confirm('确定删除此规则？')) return;
    try {
      await api.deleteRule(id);
      toast.success('已删除');
      refresh();
    } catch (e) { toast.error(e.message); }
  };

  const testRule = async (id) => {
    try {
      const result = await api.testRule(id);
      toast.success(result?.message || '测试完成');
    } catch (e) { toast.error(e.message); }
  };

  const filtered = rules.filter(r => {
    if (search && !r.name?.includes(search) && !r.listen_port?.toString().includes(search)) return false;
    if (tagFilter) {
      const tags = tagFilter.split(',').map(t => t.trim()).filter(Boolean);
      if (!tags.some(t => r.tags?.includes(t))) return false;
    }
    return true;
  });

  const nodeName = (id) => nodes.find(n => n.id === id)?.name || id?.slice(0, 8);
  const fmt = (n) => {
    if (n == null) return '0 B';
    if (n >= 1e9) return (n / 1e9).toFixed(1) + ' GB';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + ' KB';
    return n + ' B';
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input className="input pl-9" placeholder="搜索规则..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="relative">
          <Tag className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input className="input pl-9 w-48" placeholder="标签筛选..." value={tagFilter} onChange={e => setTagFilter(e.target.value)} />
        </div>
        {isAdmin && <button onClick={() => setShowCreate(true)} className="btn-primary"><Plus className="w-4 h-4" /> 新建规则</button>}
        <button onClick={refresh} className="btn-ghost"><RefreshCw className="w-4 h-4" /></button>
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-700">
              <th className="px-4 py-3 font-medium">名称</th>
              <th className="px-4 py-3 font-medium">节点</th>
              <th className="px-4 py-3 font-medium">监听端口</th>
              <th className="px-4 py-3 font-medium">目标</th>
              <th className="px-4 py-3 font-medium">协议</th>
              <th className="px-4 py-3 font-medium">状态</th>
              <th className="px-4 py-3 font-medium">流量</th>
              <th className="px-4 py-3 font-medium">标签</th>
              <th className="px-4 py-3 font-medium">操作</th>
            </tr></thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={9} className="px-4 py-12 text-center text-slate-400">加载中...</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={9} className="px-4 py-12 text-center text-slate-400">暂无规则</td></tr>
              ) : filtered.map(r => (
                <tr key={r.id} className="border-b border-slate-50 dark:border-slate-800/50 hover:bg-slate-50 dark:hover:bg-slate-800/30">
                  <td className="px-4 py-3 font-medium cursor-pointer" onClick={() => setSelected(r)}>{r.name}</td>
                  <td className="px-4 py-3 text-slate-500">{nodeName(r.node_id)}</td>
                  <td className="px-4 py-3 font-mono">{r.listen_port}</td>
                  <td className="px-4 py-3 font-mono text-xs">{r.target_host}:{r.target_port}</td>
                  <td className="px-4 py-3"><span className="badge-ok">{r.protocol || 'TCP'}</span></td>
                  <td className="px-4 py-3"><Badge status={r.enabled ? 'enabled' : 'disabled'} label={r.enabled ? '启用' : '停用'} /></td>
                  <td className="px-4 py-3 font-mono text-xs">{fmt(r.traffic_used)}</td>
                  <td className="px-4 py-3">{(r.tags || []).map(t => <span key={t} className="badge-muted mr-1">{t}</span>)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      <button onClick={() => toggleRule(r.id)} className="btn-xs btn-ghost" title={r.enabled ? '停用' : '启用'}>
                        {r.enabled ? <Square className="w-3 h-3" /> : <Play className="w-3 h-3" />}
                      </button>
                      <button onClick={() => testRule(r.id)} className="btn-xs btn-ghost" title="连通测试"><TestTube2 className="w-3 h-3" /></button>
                      <button onClick={() => cloneRule(r.id)} className="btn-xs btn-ghost" title="克隆"><Copy className="w-3 h-3" /></button>
                      <button onClick={() => resetTraffic(r.id)} className="btn-xs btn-ghost" title="重置流量"><RotateCcw className="w-3 h-3" /></button>
                      {isAdmin && <button onClick={() => deleteRule(r.id)} className="btn-xs btn-danger" title="删除">×</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Drawer open={!!selected} onClose={() => setSelected(null)} title={selected?.name || '规则详情'} wide>
        {selected && (
          <div className="space-y-4 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <div><span className="text-slate-500">ID：</span><span className="font-mono text-xs">{selected.id}</span></div>
              <div><span className="text-slate-500">状态：</span><Badge status={selected.enabled ? 'enabled' : 'disabled'} /></div>
              <div><span className="text-slate-500">节点：</span>{nodeName(selected.node_id)}</div>
              <div><span className="text-slate-500">协议：</span>{selected.protocol || 'TCP'}</div>
              <div><span className="text-slate-500">监听端口：</span><span className="font-mono">{selected.listen_port}</span></div>
              <div><span className="text-slate-500">目标：</span><span className="font-mono">{selected.target_host}:{selected.target_port}</span></div>
              <div><span className="text-slate-500">流量：</span>{fmt(selected.traffic_used)}</div>
              <div><span className="text-slate-500">限速：</span>{selected.limit ? `${selected.limit} Mbps` : '无限制'}</div>
            </div>
            {selected.tags?.length > 0 && (
              <div><span className="text-slate-500">标签：</span>{selected.tags.map(t => <span key={t} className="badge-muted mr-1">{t}</span>)}</div>
            )}
          </div>
        )}
      </Drawer>

      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="新建规则" wide>
        <RuleForm nodes={nodes} onSave={async (data) => {
          try { await api.createRule(data); toast.success('规则已创建'); setShowCreate(false); refresh(); }
          catch (e) { toast.error(e.message); }
        }} />
      </Modal>
    </div>
  );
}

function RuleForm({ nodes, initial, onSave }) {
  const [form, setForm] = useState(initial || { name: '', node_id: '', listen_port: '', target_host: '', target_port: '', protocol: 'TCP', limit: '', tags: '' });
  const handleSubmit = (e) => {
    e.preventDefault();
    onSave({
      ...form,
      listen_port: Number(form.listen_port),
      target_port: Number(form.target_port),
      limit: form.limit ? Number(form.limit) : 0,
      tags: form.tags ? form.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
    });
  };
  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div><label className="label">规则名称</label><input className="input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required /></div>
      <div><label className="label">节点</label>
        <select className="input" value={form.node_id} onChange={e => setForm({ ...form, node_id: e.target.value })} required>
          <option value="">选择节点</option>
          {nodes.map(n => <option key={n.id} value={n.id}>{n.name}</option>)}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div><label className="label">监听端口</label><input className="input" type="number" value={form.listen_port} onChange={e => setForm({ ...form, listen_port: e.target.value })} required /></div>
        <div><label className="label">协议</label>
          <select className="input" value={form.protocol} onChange={e => setForm({ ...form, protocol: e.target.value })}>
            <option value="TCP">TCP</option><option value="UDP">UDP</option>
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div><label className="label">目标地址</label><input className="input" value={form.target_host} onChange={e => setForm({ ...form, target_host: e.target.value })} required /></div>
        <div><label className="label">目标端口</label><input className="input" type="number" value={form.target_port} onChange={e => setForm({ ...form, target_port: e.target.value })} required /></div>
      </div>
      <div><label className="label">限速 (Mbps，0=不限)</label><input className="input" type="number" value={form.limit} onChange={e => setForm({ ...form, limit: e.target.value })} /></div>
      <div><label className="label">标签 (逗号分隔)</label><input className="input" value={form.tags} onChange={e => setForm({ ...form, tags: e.target.value })} placeholder="prod,web" /></div>
      <div className="flex justify-end gap-2">
        <button type="submit" className="btn-primary">保存</button>
      </div>
    </form>
  );
}