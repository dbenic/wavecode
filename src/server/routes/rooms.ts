import type { Context, Hono } from 'hono';
import { getActingUser, type NodeAppEnv } from '../auth.js';
import { getRoom, getUser, updateRoomOwner, updateUserDefaultRoom } from '../db.js';
import { userName } from '../leases.js';
import {
  canWriteDoc,
  docErrorStatus,
  ensureRoom,
  listDocs,
  listRooms,
  readDoc,
  ROOM_NAME_RE,
  writeDoc,
} from '../rooms.js';
import { isAdmin, OWNER_USER_ID } from '../users.js';

/** `/api/rooms/<project>/docs/<path…>` → `<path…>` (URL-decoded). */
function docPath(c: Context<NodeAppEnv>): string {
  const marker = `/docs/`;
  const raw = c.req.path.slice(c.req.path.indexOf(marker) + marker.length);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Project rooms (spec §5e): the shared spec, ledger, decisions and reports. */
export function registerRoomRoutes(app: Hono<NodeAppEnv>): void {
  app.get('/api/rooms', (c) => {
    const user = getActingUser(c);
    return c.json(listRooms().map((r) => ({
      project: r.project,
      root: r.root,
      owner_id: r.owner_id,
      owner: r.owner_id ? userName(r.owner_id) : null,
      can_write_spec: canWriteDoc(user, r, 'SPEC.md').ok,
      is_default: user.default_room === r.project,
    })));
  });

  app.post('/api/rooms', async (c) => {
    const body = await c.req.json<{ project?: unknown }>().catch(() => ({} as { project?: unknown }));
    if (typeof body?.project !== 'string' || !ROOM_NAME_RE.test(body.project)) {
      return c.json({ error: 'project must be 1–48 chars of [a-z0-9_.-]' }, 400);
    }
    if (getRoom(body.project).ok) return c.json({ error: `Room '${body.project}' already exists` }, 409);
    const user = getActingUser(c);
    const room = ensureRoom(body.project, user.id === OWNER_USER_ID ? null : user.id);
    if (!room.ok) return c.json({ error: room.error }, 500);
    return c.json(room.data, 201);
  });

  /** Hand the room (SPEC.md / TEMPLATES/ write access) to someone else — owner or admin. */
  app.patch('/api/rooms/:project', async (c) => {
    const room = getRoom(c.req.param('project'));
    if (!room.ok) return c.json({ error: room.error }, 404);
    const user = getActingUser(c);
    if (!isAdmin(user) && room.data.owner_id !== user.id) return c.json({ error: 'Only the room owner or an admin may change the owner' }, 403);
    const body = await c.req.json<{ owner_id?: unknown }>().catch(() => ({} as { owner_id?: unknown }));
    if (body?.owner_id !== null && typeof body?.owner_id !== 'string') return c.json({ error: 'owner_id must be a user id or null' }, 400);
    if (typeof body.owner_id === 'string' && !getUser(body.owner_id).ok) return c.json({ error: `No such user: ${body.owner_id}` }, 400);
    const updated = updateRoomOwner(room.data.project, body.owner_id as string | null);
    return updated.ok ? c.json(updated.data) : c.json({ error: updated.error }, 500);
  });

  app.get('/api/rooms/:project/docs', (c) => {
    const room = getRoom(c.req.param('project'));
    if (!room.ok) return c.json({ error: room.error }, 404);
    return c.json({ project: room.data.project, root: room.data.root, docs: listDocs(room.data, getActingUser(c)) });
  });

  app.get('/api/rooms/:project/docs/*', (c) => {
    const room = getRoom(c.req.param('project'));
    if (!room.ok) return c.json({ error: room.error }, 404);
    const doc = readDoc(room.data, docPath(c));
    if (!doc.ok) return c.json({ error: doc.error }, docErrorStatus(doc.code));
    return c.json({ ...doc.data, writable: canWriteDoc(getActingUser(c), room.data, doc.data.path).ok });
  });

  app.put('/api/rooms/:project/docs/*', async (c) => {
    const room = getRoom(c.req.param('project'));
    if (!room.ok) return c.json({ error: room.error }, 404);
    const body = await c.req.json<{ content?: unknown; expected_modified_at?: unknown }>().catch(() => null);
    if (!body || typeof body !== 'object') return c.json({ error: 'Body must be a JSON object with content' }, 400);
    const expected = typeof body.expected_modified_at === 'string' ? body.expected_modified_at : undefined;
    const written = writeDoc(room.data, docPath(c), body.content, getActingUser(c), { expectedModifiedAt: expected });
    if (!written.ok) return c.json({ error: written.error }, docErrorStatus(written.code));
    return c.json(written.data);
  });

  /** Where tasks you create go when the agent's workspace matches no project. */
  app.put('/api/users/me/default-room', async (c) => {
    const user = getActingUser(c);
    if (user.id === OWNER_USER_ID) return c.json({ error: 'The fallback-token owner has no user record' }, 400);
    const body = await c.req.json<{ room?: unknown }>().catch(() => ({} as { room?: unknown }));
    const room = body?.room;
    if (room !== null && (typeof room !== 'string' || !getRoom(room).ok)) return c.json({ error: `Room not found: ${String(room)}` }, 400);
    updateUserDefaultRoom(user.id, room as string | null);
    return c.json({ default_room: room });
  });
}
