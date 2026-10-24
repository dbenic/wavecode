/**
 * Ops job routes. These record work for a bot to pull.
 * They do not spawn, exec, or read an opsbots script.
 */

import type { Hono } from 'hono';
import { getActingUser, type NodeAppEnv } from '../auth.js';
import { emit } from '../event-bus.js';
import { canMutate } from '../users.js';
import { asksToChangeData } from '../ops-ask.js';
import { isOpsJobRole, type OpsJobRole } from '../ops-lanes-config.js';
import {
  approveOpsJob, checkReceiptPaths, claimOpsJob, completeOpsJob, currentOpsConfig,
  getOpsJob, insertOpsJob, listOpsJobs, openStageJob, publicOpsJob, READ_ANSWER_POLICY,
  roleBoundTo, stagePayload, userIsOpsOwner, type OpsJob,
} from '../ops-jobs.js';
import { opsStageRefusal } from '../ops-stage.js';

const SHA_RE = /^[0-9a-f]{40}$/i;
const COMPANY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SEAT_DENIED = 'a seat token cannot record ops jobs';

function seatDenied(user: { via_seat?: boolean }): boolean {
  return user.via_seat === true;
}

function jsonJob(job: OpsJob, extra?: Record<string, unknown>) {
  return { job: publicOpsJob(job), ...extra };
}

export function registerOpsJobRoutes(app: Hono<NodeAppEnv>): void {
  app.get('/api/ops/jobs', (c) => {
    return c.json(listOpsJobs().map(publicOpsJob));
  });

  app.post('/api/ops/jobs/claim', (c) => {
    const user = getActingUser(c);
    if (seatDenied(user)) return c.json({ error: SEAT_DENIED }, 403);
    if (!canMutate(user)) return c.json({ error: 'Forbidden' }, 403);
    return c.req.json<{ role?: unknown }>().then((body) => {
      const role = typeof body.role === 'string' ? body.role.trim() : '';
      if (!isOpsJobRole(role)) return c.json({ error: 'role must be stager, scout, scribe-hipsl, or scribe-clients' }, 400);
      const bound = roleBoundTo(user);
      if (bound !== role) return c.json({ error: `this token cannot claim ${role}` }, 403);
      const job = claimOpsJob(role, user.id);
      if (job) emit('ops.job.claimed', 'ops_job', job.id, { role, status: 'claimed' });
      return c.json({ job: job ? publicOpsJob(job) : null });
    }).catch(() => c.json({ error: 'Malformed request body' }, 400));
  });

  app.post('/api/ops/jobs/:id/complete', async (c) => {
    const user = getActingUser(c);
    if (seatDenied(user)) return c.json({ error: SEAT_DENIED }, 403);
    if (!canMutate(user)) return c.json({ error: 'Forbidden' }, 403);
    const body = await c.req.json<{ status?: unknown; receipt_paths?: unknown }>().catch(() => null);
    if (!body) return c.json({ error: 'Malformed request body' }, 400);
    if (body.status !== 'done' && body.status !== 'failed') return c.json({ error: 'status must be done or failed' }, 400);
    const job = getOpsJob(c.req.param('id'));
    if (!job) return c.json({ error: 'ops job not found' }, 404);
    const bound = roleBoundTo(user);
    if (bound !== job.role) return c.json({ error: `this token cannot complete a ${job.role} job` }, 403);
    if (job.claimed_by !== user.id) return c.json({ error: 'this token did not claim that job' }, 403);
    if (job.status !== 'claimed') return c.json({ error: `job is ${job.status}` }, 409);
    const receipts = await checkReceiptPaths(job.role, body.receipt_paths ?? [], currentOpsConfig().receiptsRoot);
    if (!receipts.ok) return c.json({ error: receipts.error }, 400);
    const finished = completeOpsJob(job.id, body.status, receipts.paths);
    if (!finished) return c.json({ error: 'job is no longer claimed' }, 409);
    emit('ops.job.completed', 'ops_job', finished.id, { role: finished.role, status: finished.status });
    return c.json(jsonJob(finished));
  });

  app.post('/api/ops/jobs/:id/approve', (c) => {
    const user = getActingUser(c);
    if (seatDenied(user)) return c.json({ error: 'agents cannot approve an ops job' }, 403);
    const cfg = currentOpsConfig();
    if (!userIsOpsOwner(user, cfg)) {
      const names = cfg.owners.length > 0 ? cfg.owners.join(' or ') : 'a configured owner';
      return c.json({ error: `only ${names} can approve an ops job` }, 403);
    }
    const existing = getOpsJob(c.req.param('id'));
    if (!existing) return c.json({ error: 'ops job not found' }, 404);
    if (existing.status !== 'awaiting_owner') return c.json({ error: `job is ${existing.status}` }, 409);
    if (existing.approval) return c.json({ error: 'job is already approved' }, 409);
    const approved = approveOpsJob(existing.id, user.name);
    if (!approved) return c.json({ error: 'job is already approved' }, 409);
    emit('ops.job.approved', 'ops_job', approved.id, { role: approved.role, status: approved.status, approval: approved.approval });
    return c.json(jsonJob(approved));
  });

  app.post('/api/ops/stage', async (c) => {
    const user = getActingUser(c);
    if (!canMutate(user) || seatDenied(user)) return c.json({ error: seatDenied(user) ? SEAT_DENIED : 'Forbidden' }, 403);
    const body = await c.req.json<{ sha?: unknown }>().catch(() => null);
    if (!body) return c.json({ error: 'Malformed request body' }, 400);
    const sha = typeof body.sha === 'string' ? body.sha.trim().toLowerCase() : '';
    if (!SHA_RE.test(sha)) return c.json({ error: 'sha must be 40 hex characters' }, 400);
    const open = openStageJob(sha);
    if (open) return c.json(jsonJob(open, { deduped: true }));
    let reason: string | null;
    try {
      reason = await opsStageRefusal(sha);
    } catch {
      reason = 'staging checks are not ready';
    }
    if (reason) return c.json({ error: reason }, 409);
    const job = insertOpsJob({
      kind: 'stage',
      role: 'stager',
      status: 'queued',
      requester: user.name,
      payload: stagePayload(sha),
    });
    emit('ops.job.queued', 'ops_job', job.id, { role: 'stager', kind: 'stage', sha });
    return c.json(jsonJob(job, { deduped: false }), 201);
  });

  app.post('/api/ops/ask', async (c) => {
    const user = getActingUser(c);
    if (!canMutate(user) || seatDenied(user)) return c.json({ error: seatDenied(user) ? SEAT_DENIED : 'Forbidden' }, 403);
    const body = await c.req.json<{ company?: unknown; env?: unknown; question?: unknown }>().catch(() => null);
    if (!body) return c.json({ error: 'Malformed request body' }, 400);
    const company = typeof body.company === 'string' ? body.company.trim() : '';
    const env = body.env === 'staging' || body.env === 'prod' ? body.env : null;
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (!COMPANY_RE.test(company)) return c.json({ error: 'company must be an id' }, 400);
    if (!env) return c.json({ error: 'env must be staging or prod' }, 400);
    if (!question || question.length > 4000) return c.json({ error: 'question is required' }, 400);
    const write = asksToChangeData(question);
    const cfg = currentOpsConfig();
    let role: OpsJobRole = 'scout';
    if (write) {
      const scribe = cfg.companies[company.toLowerCase()];
      if (!scribe || (scribe !== 'scribe-hipsl' && scribe !== 'scribe-clients')) {
        return c.json({ error: 'company must be hipsl or clients for a change' }, 400);
      }
      role = scribe;
    }
    const job = insertOpsJob({
      kind: write ? 'scribe_write' : 'ask_data',
      role,
      status: write ? 'awaiting_owner' : 'queued',
      requester: user.name,
      payload: write
        ? { company, env, question, read_only: false }
        : { company, env, question, read_only: true, answer_policy: { ...READ_ANSWER_POLICY } },
    });
    emit('ops.job.queued', 'ops_job', job.id, { role, kind: job.kind, status: job.status });
    return c.json(jsonJob(job), 201);
  });
}
