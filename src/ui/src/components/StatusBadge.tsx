type Status = 'idle' | 'working' | 'error';

const config: Record<Status, { label: string; dotClass: string; textClass: string; glowClass: string }> = {
  idle: {
    label: 'IDLE',
    dotClass: 'bg-slate-500',
    textClass: 'text-slate-400',
    glowClass: '',
  },
  working: {
    label: 'WORKING',
    dotClass: 'bg-emerald-400 animate-pulse',
    textClass: 'text-emerald-400',
    glowClass: 'shadow-[0_0_6px_theme(colors.emerald.400)]',
  },
  error: {
    label: 'ERROR',
    dotClass: 'bg-red-500 animate-pulse',
    textClass: 'text-red-400',
    glowClass: 'shadow-[0_0_6px_theme(colors.red.500)]',
  },
};

export default function StatusBadge({ status }: { status: Status }) {
  const c = config[status] ?? config.idle;

  return (
    <div className="flex items-center gap-1.5">
      <span className={`block h-2 w-2 rounded-full ${c.dotClass} ${c.glowClass}`} />
      <span className={`text-[10px] font-bold tracking-[0.2em] uppercase ${c.textClass}`}>
        {c.label}
      </span>
    </div>
  );
}
