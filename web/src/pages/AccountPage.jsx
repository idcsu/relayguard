import { useState, useEffect } from 'react';
import { api } from '../api';
import { useToast } from '../components/Toast';
import { Lock, Shield, LogOut } from 'lucide-react';

export default function AccountPage() {
  const toast = useToast();
  const [sessions, setSessions] = useState([]);
  const [totpSecret, setTotpSecret] = useState(null);
  const [totpCode, setTotpCode] = useState('');
  const [totpPassword, setTotpPassword] = useState('');
  const [totpEnabled, setTotpEnabled] = useState(false);

  // Password form
  const [pwForm, setPwForm] = useState({ old_password: '', new_password: '', confirm: '' });

  useEffect(() => {
    api.sessions().then(setSessions).catch(() => {});
    api.me().then(d => setTotpEnabled(d.user?.totp_enabled || false)).catch(() => {});
  }, []);

  const changePassword = async (e) => {
    e.preventDefault();
    if (pwForm.new_password !== pwForm.confirm) { toast.error('两次密码不一致'); return; }
    try {
      await api.changePassword({ old_password: pwForm.old_password, new_password: pwForm.new_password });
      toast.success('密码已修改');
      setPwForm({ old_password: '', new_password: '', confirm: '' });
    } catch (e) { toast.error(e.message); }
  };

  const setupTotp = async () => {
    try {
      const result = await api.totpSetup();
      setTotpSecret(result);
    } catch (e) { toast.error(e.message); }
  };

  const enableTotp = async () => {
    try {
      await api.totpEnable(totpCode, totpPassword);
      toast.success('两步验证已启用');
      setTotpEnabled(true);
      setTotpSecret(null);
      setTotpCode('');
      setTotpPassword('');
    } catch (e) { toast.error(e.message); }
  };

  const disableTotp = async () => {
    const code = prompt('请输入当前两步验证码以关闭：');
    if (!code) return;
    try {
      await api.totpDisable(code);
      toast.success('两步验证已关闭');
      setTotpEnabled(false);
    } catch (e) { toast.error(e.message); }
  };

  const logoutOthers = async () => {
    try {
      await api.logoutOthers();
      toast.success('其他会话已注销');
      api.sessions().then(setSessions);
    } catch (e) { toast.error(e.message); }
  };

  const copyText = (text) => {
    navigator.clipboard.writeText(text).then(() => toast.success('已复制'));
  };

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Password change */}
      <div className="card p-6">
        <h3 className="text-lg font-bold mb-4 flex items-center gap-2"><Lock className="w-5 h-5" /> 修改密码</h3>
        <form onSubmit={changePassword} className="space-y-4">
          <div><label className="label">当前密码</label><input className="input" type="password" value={pwForm.old_password} onChange={e => setPwForm({ ...pwForm, old_password: e.target.value })} required /></div>
          <div><label className="label">新密码</label><input className="input" type="password" value={pwForm.new_password} onChange={e => setPwForm({ ...pwForm, new_password: e.target.value })} required /></div>
          <div><label className="label">确认新密码</label><input className="input" type="password" value={pwForm.confirm} onChange={e => setPwForm({ ...pwForm, confirm: e.target.value })} required /></div>
          <button type="submit" className="btn-primary">修改密码</button>
        </form>
      </div>

      {/* TOTP */}
      <div className="card p-6">
        <h3 className="text-lg font-bold mb-4 flex items-center gap-2"><Shield className="w-5 h-5" /> 两步验证</h3>
        {totpEnabled ? (
          <div className="space-y-3">
            <span className="badge-ok">已启用</span>
            <p className="text-sm text-slate-500">您的账号已启用两步验证，登录时需要输入验证码。</p>
            <button onClick={disableTotp} className="btn-danger">关闭两步验证</button>
          </div>
        ) : totpSecret ? (
          <div className="space-y-4">
            <p className="text-sm text-slate-500">1. 扫描下方二维码或手动输入密钥到您的验证器 APP</p>
            <div className="bg-white p-4 rounded-xl inline-block">
              <img src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(totpSecret.uri || '')}`} alt="TOTP QR" className="w-48 h-48" />
            </div>
            <div>
              <p className="text-sm text-slate-500 mb-1">手动密钥：</p>
              <code className="bg-slate-100 dark:bg-slate-800 px-3 py-1 rounded text-sm font-mono break-all cursor-pointer" onClick={() => copyText(totpSecret.secret)}>{totpSecret.secret}</code>
            </div>
            <p className="text-sm text-slate-500">2. 输入当前密码和验证器显示的 6 位数字</p>
            <div className="flex items-center gap-2">
              <input className="input w-48" type="password" value={totpPassword} onChange={e => setTotpPassword(e.target.value)} placeholder="当前密码" />
              <input className="input w-40" value={totpCode} onChange={e => setTotpCode(e.target.value)} placeholder="000000" maxLength={6} />
              <button onClick={enableTotp} className="btn-primary">启用</button>
            </div>
          </div>
        ) : (
          <button onClick={setupTotp} className="btn-primary">设置两步验证</button>
        )}
      </div>

      {/* Sessions */}
      <div className="card p-6">
        <h3 className="text-lg font-bold mb-4 flex items-center gap-2"><LogOut className="w-5 h-5" /> 会话管理</h3>
        <div className="mb-4">
          <button onClick={logoutOthers} className="btn-ghost text-sm">注销其他会话</button>
        </div>
        <div className="space-y-2">
          {sessions.map(s => (
            <div key={s.id} className="flex items-center justify-between py-2 border-b border-slate-100 dark:border-slate-800 last:border-0">
              <div className="text-sm">
                <div className="font-medium">{s.ip || s.user_agent?.slice(0, 40) || '未知会话'}</div>
                <div className="text-xs text-slate-400">{s.created_at ? new Date(s.created_at).toLocaleString('zh-CN') : ''}</div>
              </div>
              {s.current && <span className="badge-ok">当前</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}