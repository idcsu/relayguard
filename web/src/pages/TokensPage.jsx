import { useState, useEffect } from 'react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';
import { RefreshCw, Plus, Copy } from 'lucide-react';

export default function TokensPage() {
  const { isAdmin } = useAuth();
  const toast = useToast();
  const [tokens, setTokens] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newToken, setNewToken] = useState(null);

  const refresh = () => {
    setLoading(true);
    api.nodeTokens().then(setTokens).catch(() => toast.error('加载失败')).finally(() => setLoading(false));
  };

  useEffect(() => { if (isAdmin) refresh(); }, [isAdmin]);

  const createToken = async () => {
    try {
      const result = await api.createNodeToken({});
      setNewToken(result);
      toast.success('令牌已生成');
      refresh();
    } catch (e) { toast.error(e.message); }
  };

  const copyText = (text) => {
    navigator.clipboard.writeText(text).then(() => toast.success('已复制'));
  };

  if (!isAdmin) return <div className="text-center py-20 text-slate-400">需要管理员权限</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div />
        <div className="flex gap-2">
          <button onClick={createToken} className="btn-primary"><Plus className="w-4 h-4" /> 生成令牌</button>
          <button onClick={refresh} className="btn-ghost"><RefreshCw className="w-4 h-4" /></button>
        </div>
      </div>

      {newToken && (
        <div className="card p-6 border-brand-500 border-2">
          <div className="font-bold mb-2">新令牌已生成</div>
          <div className="flex items-center gap-2 mb-4">
            <code className="bg-slate-100 dark:bg-slate-800 px-3 py-2 rounded-lg text-sm font-mono break-all flex-1">{newToken.token || newToken.id}</code>
            <button onClick={() => copyText(newToken.token || newToken.id)} className="btn-ghost btn-xs"><Copy className="w-4 h-4" /></button>
          </div>
          <div className="text-sm text-slate-500">请在目标节点上使用此令牌注册。关闭后令牌将不再显示。</div>
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-700">
              <th className="px-6 py-3 font-medium">ID</th>
              <th className="px-6 py-3 font-medium">创建时间</th>
              <th className="px-6 py-3 font-medium">过期时间</th>
              <th className="px-6 py-3 font-medium">状态</th>
            </tr></thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={4} className="px-6 py-12 text-center text-slate-400">加载中...</td></tr>
              ) : tokens.length === 0 ? (
                <tr><td colSpan={4} className="px-6 py-12 text-center text-slate-400">暂无令牌</td></tr>
              ) : tokens.map(t => (
                <tr key={t.id} className="border-b border-slate-50 dark:border-slate-800/50 hover:bg-slate-50 dark:hover:bg-slate-800/30">
                  <td className="px-6 py-3 font-mono text-xs">{t.id?.slice(0, 12)}...</td>
                  <td className="px-6 py-3 text-slate-500">{t.created_at ? new Date(t.created_at).toLocaleString('zh-CN') : '-'}</td>
                  <td className="px-6 py-3 text-slate-500">{t.expires_at ? new Date(t.expires_at).toLocaleString('zh-CN') : '永不过期'}</td>
                  <td className="px-6 py-3"><span className={t.used ? 'badge-muted' : 'badge-ok'}>{t.used ? '已使用' : '未使用'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
