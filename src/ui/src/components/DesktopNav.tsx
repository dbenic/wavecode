import { useNavigate, useLocation } from 'react-router-dom';

const NAV_ITEMS = [
  { path: '/', label: 'Chat', icon: '▶' },
  { path: '/dashboard', label: 'Agents', icon: '◉' },
  { path: '/tasks', label: 'Tasks', icon: '☰' },
  { path: '/review', label: 'Review', icon: '✓' },
  { path: '/artifacts', label: 'Files', icon: '◫' },
  { path: '/docs', label: 'Docs', icon: '◈' },
  { path: '/library', label: 'Library', icon: '◊' },
  { path: '/specs', label: 'Specs', icon: '◇' },
  { path: '/settings', label: '', icon: '⚙' },
];

export default function DesktopNav() {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <nav className="hidden sm:block fixed top-0 left-0 right-0 z-50 border-b border-slate-800/60 bg-slate-950/95 backdrop-blur-xl">
      <div className="flex items-center justify-center h-10 gap-1 px-4">
        <span
          className="text-[10px] font-black tracking-[0.15em] text-emerald-400 uppercase mr-3 cursor-pointer shrink-0"
          onClick={() => navigate('/')}
        >
          WaveCode
        </span>
        {NAV_ITEMS.map((item) => {
          const active = location.pathname === item.path
            || (item.path === '/' && location.pathname === '/chat')
            || (item.path === '/dashboard' && location.pathname.startsWith('/agent/'));
          return (
            <button
              key={item.path}
              onClick={() => navigate(item.path)}
              className={`
                px-2 py-1 rounded text-[9px] font-bold tracking-[0.1em] uppercase transition-all duration-150 shrink-0
                ${active
                  ? 'bg-emerald-950 border border-emerald-500/40 text-emerald-300 shadow-[0_0_8px_rgba(16,185,129,0.1)]'
                  : 'border border-transparent text-slate-500 hover:text-slate-300 hover:border-slate-700/50'}
              `}
              title={item.label || 'Settings'}
            >
              {item.label || item.icon}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
