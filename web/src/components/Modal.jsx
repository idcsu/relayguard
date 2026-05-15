export default function Modal({ open, onClose, title, children, wide }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" />
      <div className={`relative bg-white dark:bg-slate-900 rounded-2xl shadow-2xl ${wide?'max-w-2xl':'max-w-lg'} w-full max-h-[90vh] overflow-y-auto animate-fade-in`} onClick={e=>e.stopPropagation()}>
        {title && <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-800">
          <h2 className="text-lg font-bold">{title}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 text-xl">&times;</button>
        </div>}
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}
