/**
 * Settings → Users (spec §4.3, admin). List users, add one (its bearer
 * token is shown exactly once), revoke. Non-admins see the list read-only.
 */

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { apiDelete, apiGet, apiPost } from '../hooks/useApi';
import { useSSE } from '../hooks/useSSE';
import type { User, UserRole } from '../types';

const ROLES: UserRole[] = ['developer', 'observer', 'admin'];

export default function Users() {
  const [me, setMe] = useState<User | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [name, setName] = useState('');
  const [role, setRole] = useState<UserRole>('developer');
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => apiGet<User[]>('/users').then(setUsers).catch(() => {}), []);

  useEffect(() => {
    apiGet<User>('/me').then(setMe).catch(() => {});
    void load();
  }, [load]);

  useSSE((event) => {
    if (event.type.startsWith('user.')) void load();
  });

  const isAdmin = me?.role === 'admin';

  async function add(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setCreated(null);
    try {
      const res = await apiPost<User & { token: string }>('/users', { name: name.trim(), role });
      setCreated({ name: res.name, token: res.token });
      setName('');
      void load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function revoke(user: User) {
    if (!window.confirm(`Revoke ${user.name}? Their token stops working and their agent leases are released.`)) return;
    try {
      await apiDelete(`/users/${user.id}`);
      void load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <div className="mb-4 flex items-center gap-3">
        <Link to="/" className="text-sm text-slate-500 hover:text-slate-300">&larr;</Link>
        <h1 className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-300">Users</h1>
      </div>

      {isAdmin && (
        <form aria-label="Add user" onSubmit={add} className="mb-4 flex flex-wrap items-end gap-2 rounded-lg border border-slate-800 p-3">
          <label className="flex flex-col text-xs text-slate-400">
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ana"
              className="mt-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-100"
            />
          </label>
          <label className="flex flex-col text-xs text-slate-400">
            Role
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as UserRole)}
              className="mt-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-100"
            >
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <button type="submit" disabled={!name.trim()} className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40">
            Add user
          </button>
        </form>
      )}

      {created && (
        <div role="status" className="mb-4 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm text-amber-200">
          <p>Token for <strong>{created.name}</strong> — shown once, copy it now:</p>
          <code data-testid="new-token" className="mt-1 block break-all rounded bg-slate-950 p-2 text-xs text-slate-100">{created.token}</code>
        </div>
      )}
      {error && <p role="alert" className="mb-3 text-sm text-red-400">{error}</p>}

      <ul aria-label="Users" className="flex flex-col gap-1.5">
        {users.map((u) => (
          <li key={u.id} className="flex items-center gap-2 rounded-lg border border-slate-800/60 px-3 py-2">
            <span aria-hidden className="block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: u.color }} />
            <span className="text-sm text-slate-200">{u.name}</span>
            <span className="text-xs text-slate-500">{u.role}</span>
            {u.profile && <span className="text-xs text-slate-600">profile {u.profile}</span>}
            {isAdmin && u.id !== 'owner' && u.id !== me?.id && (
              <button type="button" onClick={() => void revoke(u)} className="ml-auto text-xs text-red-400 hover:text-red-300">
                Revoke
              </button>
            )}
          </li>
        ))}
      </ul>
      {!isAdmin && me && <p className="mt-3 text-xs text-slate-600">Only admins can add or revoke users.</p>}
    </div>
  );
}
