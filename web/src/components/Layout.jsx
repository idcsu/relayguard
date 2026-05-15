import { useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';
import { api } from '../api';
import { LayoutDashboard, Server, ArrowLeftRight, Users, Key, FileText, Database, Settings, Shield, User, LogOut, Moon, Sun, Menu, X } from 'lucide-react';

const NAV = [
  { key:'dashboard', path:'/', icon:LayoutDashboard, label:'仪表盘' },
  { key:'nodes', path:'/nodes', icon:Server, label:'节点管理' },
  { key:'rules', path:'/rules', icon:ArrowLeftRight, label:'转发规则' },
  { key:'users', path:'/users', icon:Users, label:'用户管理', admin:true },
  { key:'tokens', path:'/tokens', icon:Key, label:'节点接入', admin:true },
  { key:'audit', path:'/audit', icon:FileText, label:'审计日志', admin:true },
  { key:'backup', path:'/backup', icon:Database, label:'备份恢复', admin:true },
  { key:'settings', path:'/settings', icon:Settings, label:'系统设置', admin:true },
  { key:'account', path:'/account', icon:User, label:'账号安全' },
  { key:'security', path:'/security', icon:Shield, label:'安全说明' },
];

const TITLES = { '/':'仪表盘','/nodes':'节点管理','/rules':'转发规则','/users':'用户管理','/tokens':'节点接入','/audit':'审计日志','/backup':'备份恢复','/settings':'系统设置','/account':'账号安全','/security':'安全说明' };

export default function Layout({ children }) {
  const { user, version, isAdmin, logout } = useAuth();
  const toast = useToast();
  const location = useLocation();
  const navigate = useNavigate();
  const [dark, setDark] = useState(() => localStorage.getItem('theme')==='dark');
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('theme', dark ? 'dark' : 'light');
  }, [dark]);

  const handleLogout = async () => {
    try { await logout(); } catch {}
    toast.success('已退出登录');
    navigate('/login');
  };

  const filteredNav = NAV.filter(n => !n.admin || isAdmin);

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      {/* Sidebar - desktop */}
      <aside className="hidden lg:flex lg:fixed lg:inset-y-0 lg:left-0 lg:w-72 lg:flex-col bg-slate-950 text-white z-30">
        <div className="px-6 py-5 border-b border-white/10">
          <div className="text-xl font-black tracking-tight">RelayGuard</div>
          <div className="text-xs text-slate-400 mt-1">中转卫士 · v{version||'0.16.0'}</div>
        </div>
        <nav className="flex-1 px-3 py-4 grid gap-1 auto-rows-min">
          {filteredNav.map(n => (
            <button key={n.key} onClick={()=>navigate(n.path)} className={`flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm transition ${location.pathname===n.path?'bg-white/15 text-white font-semibold':'text-slate-400 hover:bg-white/10 hover:text-white'}`}>
              <n.icon className="w-5 h-5" />{n.label}
            </button>
          ))}
        </nav>
        <div className="px-4 py-4 border-t border-white/10">
          <div className="text-sm text-slate-300 truncate">{user?.username}</div>
          <div className="text-xs text-slate-500 mb-2">{user?.role}</div>
          <button onClick={handleLogout} className="btn-ghost btn-xs w-full text-slate-400"><LogOut className="w-4 h-4 mr-1"/>退出登录</button>
        </div>
      </aside>

      {/* Mobile menu overlay */}
      {mobileOpen && <div className="fixed inset-0 bg-black/50 z-40 lg:hidden" onClick={()=>setMobileOpen(false)} />}
      {/* Sidebar - mobile */}
      <aside className={`fixed inset-y-0 left-0 w-72 bg-slate-950 text-white z-50 transform transition-transform lg:hidden ${mobileOpen?'translate-x-0':'-translate-x-full'}`}>
        <div className="px-6 py-5 border-b border-white/10 flex items-center justify-between">
          <div><div className="text-xl font-black">RelayGuard</div><div className="text-xs text-slate-400 mt-1">中转卫士 · v{version||'0.16.0'}</div></div>
          <button onClick={()=>setMobileOpen(false)} className="text-slate-400 hover:text-white"><X className="w-5 h-5"/></button>
        </div>
        <nav className="flex-1 px-3 py-4 grid gap-1 auto-rows-min">
          {filteredNav.map(n => (
            <button key={n.key} onClick={()=>{navigate(n.path);setMobileOpen(false);}} className={`flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm transition ${location.pathname===n.path?'bg-white/15 text-white font-semibold':'text-slate-400 hover:bg-white/10 hover:text-white'}`}>
              <n.icon className="w-5 h-5" />{n.label}
            </button>
          ))}
        </nav>
        <div className="px-4 py-4 border-t border-white/10">
          <button onClick={handleLogout} className="btn-ghost btn-xs w-full text-slate-400"><LogOut className="w-4 h-4 mr-1"/>退出登录</button>
        </div>
      </aside>

      {/* Main content */}
      <div className="lg:pl-72">
        <header className="sticky top-0 z-20 bg-white/70 dark:bg-slate-900/70 backdrop-blur-xl border-b border-slate-200 dark:border-slate-800">
          <div className="flex items-center justify-between px-4 lg:px-8 h-14">
            <div className="flex items-center gap-3">
              <button className="lg:hidden text-slate-500" onClick={()=>setMobileOpen(true)}><Menu className="w-6 h-6"/></button>
              <h1 className="text-lg font-bold">{TITLES[location.pathname]||'中转卫士'}</h1>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={()=>setDark(!dark)} className="btn-ghost btn-xs">
                {dark ? <Sun className="w-4 h-4"/> : <Moon className="w-4 h-4"/>}
              </button>
            </div>
          </div>
        </header>
        <main className="p-4 lg:p-8 max-w-7xl mx-auto animate-fade-in">{children}</main>
      </div>
    </div>
  );
}
