import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';
import { Shield } from 'lucide-react';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await login(username, password, totp || undefined);
      toast.success('登录成功');
      navigate('/');
    } catch (err) {
      toast.error(err.message || '登录失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-950 via-slate-900 to-brand-950 p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-brand-500/20 mb-4">
            <Shield className="w-8 h-8 text-brand-400" />
          </div>
          <h1 className="text-3xl font-black text-white">RelayGuard</h1>
          <p className="text-slate-400 mt-1">中转卫士 — 多节点端口转发管理面板</p>
        </div>
        <form onSubmit={handleSubmit} className="card p-8 space-y-4">
          <div>
            <label className="label">用户名</label>
            <input className="input" value={username} onChange={e=>setUsername(e.target.value)} autoFocus required />
          </div>
          <div>
            <label className="label">密码</label>
            <input className="input" type="password" value={password} onChange={e=>setPassword(e.target.value)} required />
          </div>
          <div>
            <label className="label">两步验证码（可选）</label>
            <input className="input" value={totp} onChange={e=>setTotp(e.target.value)} placeholder="6 位数字" maxLength={6} />
          </div>
          <button type="submit" disabled={loading} className="btn-primary w-full py-2.5">
            {loading ? '登录中...' : '登 录'}
          </button>
        </form>
      </div>
    </div>
  );
}
