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
];

export default function BottomNav() {
  const navigate = useNavigate();
  const location = useLocation();

  // Don't show on agent detail or chat view (they have their own bottom input)
  if (location.pathname.startsWith('/agent/')) return null;

  return (
    <nav className="sm:hidden fixed bottom-0 left-0 right-0 z-40 border-t border-slate-800/60 bg-slate-950/95 backdrop-blur-xl safe-bottom">
      <div className="flex items-center justify-around py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        {NAV_ITEMS.map((item) => {
          const active = location.pathname === item.path
            || (item.path === '/' && location.pathname === '/chat');
          return (
            <button
              key={item.path}
              onClick={() => navigate(item.path)}
              className={`
                flex flex-col items-center gap-0.5 px-3 py-1 rounded-lg transition-colors
                ${active ? 'text-emerald-400' : 'text-slate-600 active:text-slate-400'}
              `}
            >
              <span className="text-base leading-none">{item.icon}</span>
              <span className="text-[8px] font-semibold tracking-[0.15em] uppercase">
                {item.label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
