import { createContext, useContext, useState, useCallback } from 'react';
const T = createContext(null);
export function useToast() { return useContext(T); }
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const add = useCallback((message, type='info', dur=3000) => {
    const id = Date.now()+Math.random();
    setToasts(p=>[...p,{id,message,type}]);
    if(dur>0) setTimeout(()=>setToasts(p=>p.filter(t=>t.id!==id)), dur);
  },[]);
  const fns = {
    toasts,
    success: useCallback(m=>add(m,'success'),[add]),
    error: useCallback(m=>add(m,'error',5000),[add]),
    info: useCallback(m=>add(m,'info'),[add]),
    warning: useCallback(m=>add(m,'warning'),[add]),
    remove: useCallback(id=>setToasts(p=>p.filter(t=>t.id!==id)),[]),
  };
  return <T.Provider value={fns}>{children}<ToastDisplay toasts={toasts} remove={fns.remove}/></T.Provider>;
}
const colors = { success:'bg-emerald-500', error:'bg-rose-500', warning:'bg-amber-500', info:'bg-brand-500' };
function ToastDisplay({toasts, remove}) {
  return <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">{toasts.map(t=>(
    <div key={t.id} className={`animate-slide-up ${colors[t.type]||colors.info} text-white px-4 py-2 rounded-xl shadow-lg text-sm flex items-center gap-2 min-w-[200px] cursor-pointer`} onClick={()=>remove(t.id)}>
      {t.message}
    </div>
  ))}</div>;
}
