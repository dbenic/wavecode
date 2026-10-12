/**
 * Request-scoped actor for event attribution (multi-orchestrator spec §1).
 *
 * The auth middleware runs each request inside `runWithActor()`, so any
 * `emit()` reached while that request is in flight records the caller as
 * `actor_id` without threading the user through every module. The scope is
 * closed when the request finishes: timers/intervals created during a
 * request inherit the async context, but emit from them after the response
 * is attributed to the system (null), not to whoever happened to start them.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

interface ActorScope {
  actorId: string;
  /** Effective role after auth (a seat token is never admin). */
  admin: boolean;
  active: boolean;
}

const storage = new AsyncLocalStorage<ActorScope>();

export async function runWithActor<T>(actorId: string, fn: () => Promise<T>, opts?: { admin?: boolean }): Promise<T> {
  const scope: ActorScope = { actorId, admin: opts?.admin === true, active: true };
  try {
    return await storage.run(scope, fn);
  } finally {
    scope.active = false;
  }
}

/** The actor of the in-flight request, or null outside a request (system). */
export function currentActorId(): string | null {
  const scope = storage.getStore();
  return scope?.active ? scope.actorId : null;
}

/**
 * True only when this request's effective role is admin. A seat token, a
 * developer, an agent token, and anything outside a request are not.
 */
export function currentActorIsAdmin(): boolean {
  const scope = storage.getStore();
  return scope?.active === true && scope.admin === true;
}
