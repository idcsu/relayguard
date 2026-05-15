import { useState, useEffect } from 'react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';
import { RefreshCw, Save } from 'lucide-react';

const SETTING_KEYS = [
  { key: 'site_name', label: '站点名称', type: 'text', desc: '显示在浏览器标题和侧边栏' },
  { key: 'session_ttl_hours', label: '会话有效期（小时）', type: 'number', desc: '用户登录会话过期时间，默认 24 小时' },
  { key: 'audit_retention_days', label: '审计日志保留天数', type: 'number', desc: '超过此天数的审计日志将被自动清理，默认 90 天' },
  { key: 'agent_interval', label: 'Agent 上报间隔（秒）', type: 'number', desc: 'Agent 心跳和指标上报间隔' },
  { key: 'webhook_url', label: 'Webhook URL', type: 'text', desc: '事件推送目标 URL，留空则不推送' },
  { key: 'webhook_secret', label: 'Webhook Secret', type: 'text', desc: 'Webhook 签名密钥' },
  { key: 'install_base_url', label: '安装脚本基站 URL', type: 'text', desc: 'Agent 安装脚本下载的基础 URL' },
];

export default function SettingsPage() {
  const { isAdmin } = useAuth();
  const toast = useToast();
  const [settings, setSettings] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const refresh = () => {
    setLoading(true);
    api.settings().then(setSettings).catch(() => toast.error('加载失败')).finally(() => setLoading(false));
  };

  useEffect(() => { if (isAdmin) refresh(); }, [isAdmin]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.updateSettings(settings);
      toast.success('设置已保存');
      refresh();
    } catch (e) { toast.error(e.message); }
    finally { setSaving(false); }
  };

  if (!isAdmin) return <div className="text-center py-20 text-slate-400">需要管理员权限</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div />
        <button onClick={handleSave} disabled={saving} className="btn-primary">
          <Save className="w-4 h-4" /> {saving ? '保存中...' : '保存设置'}
        </button>
      </div>

      <div className="card p-6 space-y-6">
        {loading ? (
          <div className="text-center py-12 text-slate-400">加载中...</div>
        ) : (
          SETTING_KEYS.map(s => (
            <div key={s.key}>
              <label className="label">{s.label}</label>
              <input
                className="input max-w-md"
                type={s.type}
                value={settings[s.key] || ''}
                onChange={e => setSettings({ ...settings, [s.key]: e.target.value })}
                placeholder={s.desc}
              />
              <p className="text-xs text-slate-400 mt-1">{s.desc}</p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}