export default function StatCard({ icon: Icon, label, value, sub, color='brand' }) {
  const bg = { brand:'from-brand-500 to-blue-500', rose:'from-rose-500 to-pink-500', amber:'from-amber-500 to-orange-500', emerald:'from-emerald-500 to-teal-500' }[color] || bg.brand;
  return (
    <div className="card p-5 flex items-center gap-4">
      <div className={`w-12 h-12 rounded-2xl bg-gradient-to-br ${bg} flex items-center justify-center text-white shrink-0`}>
        {Icon && <Icon className="w-6 h-6" />}
      </div>
      <div className="min-w-0">
        <div className="text-sm text-slate-500 dark:text-slate-400 truncate">{label}</div>
        <div className="text-2xl font-black truncate">{value}</div>
        {sub && <div className="text-xs text-slate-400 dark:text-slate-500 truncate">{sub}</div>}
      </div>
    </div>
  );
}
