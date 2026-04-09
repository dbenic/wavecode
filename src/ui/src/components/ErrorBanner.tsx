import { useState, useEffect } from 'react';

interface Props {
  error: string | null;
  autoDismissMs?: number;
}

/**
 * Transient error banner. Shows at the top of the view, auto-dismisses after timeout.
 * Usage: <ErrorBanner error={errorState} />
 */
export default function ErrorBanner({ error, autoDismissMs = 5000 }: Props) {
  const [visible, setVisible] = useState(false);
  const [displayError, setDisplayError] = useState<string | null>(null);

  useEffect(() => {
    if (error) {
      setDisplayError(error);
      setVisible(true);
      const timer = setTimeout(() => setVisible(false), autoDismissMs);
      return () => clearTimeout(timer);
    }
  }, [error, autoDismissMs]);

  if (!visible || !displayError) return null;

  return (
    <div className="fixed top-2 left-1/2 -translate-x-1/2 z-50 max-w-md w-[90%] animate-slide-down">
      <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-red-950/90 border border-red-500/40 text-red-200 text-sm backdrop-blur-sm shadow-lg">
        <span className="text-red-400 flex-shrink-0">!</span>
        <span className="flex-1 truncate">{displayError}</span>
        <button
          onClick={() => setVisible(false)}
          className="text-red-400 hover:text-red-200 text-xs flex-shrink-0"
        >
          &times;
        </button>
      </div>
    </div>
  );
}
