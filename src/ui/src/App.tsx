import { Routes, Route, Navigate } from 'react-router-dom';
import Dashboard from './views/Dashboard';
import AgentView from './views/AgentView';
import TaskBoard from './views/TaskBoard';
import ReviewQueue from './views/ReviewQueue';
import Artifacts from './views/Artifacts';
import CommandChat from './views/CommandChat';
import Settings from './views/Settings';
import Docs from './views/Docs';
import Library from './views/Library';
import Specs from './views/Specs';
import BottomNav from './components/BottomNav';
import DesktopNav from './components/DesktopNav';
import ErrorBanner from './components/ErrorBanner';
import AuthGate from './components/AuthGate';
import { fetchAuthStatus, useAuthState, useGlobalApiError } from './hooks/useApi';
import { useEffect } from 'react';

export default function App() {
  const apiError = useGlobalApiError();
  const auth = useAuthState();

  useEffect(() => {
    fetchAuthStatus().catch(() => {});
  }, []);

  if (!auth.loaded) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="text-[10px] text-slate-600 tracking-[0.3em] uppercase animate-pulse">
          Loading WaveCode...
        </div>
      </div>
    );
  }

  const gated = auth.method === 'token' && (!auth.token || auth.unauthorized);

  return (
    <div className="min-h-screen bg-slate-950 pb-14 sm:pb-0 sm:pt-10">
      <ErrorBanner error={apiError} />
      {gated ? (
        <AuthGate />
      ) : (
        <>
          <DesktopNav />
          <Routes>
            <Route path="/" element={<CommandChat />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/agent/:id" element={<AgentView />} />
            <Route path="/tasks" element={<TaskBoard />} />
            <Route path="/review" element={<ReviewQueue />} />
            <Route path="/artifacts" element={<Artifacts />} />
            <Route path="/chat" element={<CommandChat />} />
            <Route path="/docs" element={<Docs />} />
            <Route path="/docs/:slug" element={<Docs />} />
            <Route path="/library" element={<Library />} />
            <Route path="/library/:tab" element={<Library />} />
            <Route path="/library/guides/:guideId" element={<Library />} />
            <Route path="/specs" element={<Specs />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          <BottomNav />
        </>
      )}
    </div>
  );
}
