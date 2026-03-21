import React from 'react';

interface ToastProps {
  toast: { text: string; type: 'info' | 'ok' | 'error' } | null;
}

const Toast: React.FC<ToastProps> = ({ toast }) => {
  if (!toast) return null;
  const colors = {
    ok: 'bg-emerald-900/90 border-emerald-700 text-emerald-100',
    error: 'bg-red-900/90 border-red-700 text-red-100',
    info: 'bg-slate-800/90 border-slate-600 text-slate-100',
  };
  return (
    <div className={`fixed top-4 right-4 z-[100] px-4 py-2.5 rounded-lg border text-sm font-medium flex items-center gap-2 shadow-xl backdrop-blur-sm ${colors[toast.type]}`}>
      {toast.type === 'info' && <div className="w-4 h-4 border-2 border-slate-400 border-t-white rounded-full animate-spin" />}
      {toast.text}
    </div>
  );
};

export default Toast;
