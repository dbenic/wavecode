import webpush from 'web-push';
import { getDb, listPushSubscriptions, deletePushSubscription, listTasks, listRuns } from './db.js';
import { getConfig } from './config.js';
import logger from './logger.js';

let vapidConfigured = false;

export interface NotificationPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

/**
 * Ensure the kv_settings table exists for persisting VAPID keys etc.
 */
function ensureKvTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS kv_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

/**
 * Initialize VAPID keys for Web Push.
 * Keys are persisted to the DB so push subscriptions survive restarts.
 */
export function initWebPush(): { publicKey: string } | null {
  const config = getConfig();
  if (!config.notifications.web_push) return null;

  ensureKvTable();

  // Try to load existing keys from DB
  const row = getDb().prepare('SELECT value FROM kv_settings WHERE key = ?').get('vapid_keys') as { value: string } | undefined;

  let publicKey: string;
  let privateKey: string;

  if (row) {
    const keys = JSON.parse(row.value) as { publicKey: string; privateKey: string };
    publicKey = keys.publicKey;
    privateKey = keys.privateKey;
    logger.info('VAPID keys loaded from database');
  } else {
    // First run — generate and persist
    const vapidKeys = webpush.generateVAPIDKeys();
    publicKey = vapidKeys.publicKey;
    privateKey = vapidKeys.privateKey;
    getDb().prepare('INSERT INTO kv_settings (key, value) VALUES (?, ?)').run(
      'vapid_keys',
      JSON.stringify({ publicKey, privateKey }),
    );
    logger.info('VAPID keys generated and persisted');
  }

  webpush.setVapidDetails('mailto:wavecode@localhost', publicKey, privateKey);
  vapidConfigured = true;
  return { publicKey };
}

let vapidPublicKey: string | null = null;

export function getVapidPublicKey(): string | null {
  if (vapidPublicKey) return vapidPublicKey;
  const result = initWebPush();
  if (result) {
    vapidPublicKey = result.publicKey;
  }
  return vapidPublicKey;
}

/**
 * Send a notification to all registered push subscriptions.
 */
export async function sendPushNotification(payload: NotificationPayload): Promise<void> {
  if (!vapidConfigured) return;

  const subscriptions = listPushSubscriptions();
  const payloadStr = JSON.stringify(payload);

  for (const sub of subscriptions) {
    const keys = JSON.parse(sub.keys_json);
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: keys.p256dh, auth: keys.auth },
        },
        payloadStr,
      );
    } catch (e: unknown) {
      const err = e as { statusCode?: number };
      // Remove expired subscriptions
      if (err.statusCode === 410 || err.statusCode === 404) {
        deletePushSubscription(sub.endpoint);
      }
    }
  }
}

/**
 * Send a notification via ntfy.sh.
 */
export async function sendNtfyNotification(payload: NotificationPayload): Promise<void> {
  const config = getConfig();
  if (!config.notifications.ntfy_topic) return;

  try {
    await fetch(`https://ntfy.sh/${config.notifications.ntfy_topic}`, {
      method: 'POST',
      headers: {
        'Title': payload.title,
        'Tags': payload.tag,
        'Click': payload.url,
      },
      body: payload.body,
    });
  } catch {
    // ntfy send failed silently
  }
}

/**
 * Send a notification via Telegram Bot API.
 */
export async function sendTelegramNotification(payload: NotificationPayload, chatId?: string): Promise<void> {
  const config = getConfig();
  if (!config.notifications.telegram_bot_token) return;

  const token = config.notifications.telegram_bot_token;
  // Chat ID should be configured; for now skip if not set
  if (!chatId) return;

  const text = `*${payload.title}*\n${payload.body}`;

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
      }),
    });
  } catch {
    // Telegram send failed silently
  }
}

/**
 * Unified notification dispatcher.
 * Sends to all configured channels.
 */
export async function notify(payload: NotificationPayload): Promise<void> {
  const config = getConfig();
  await Promise.allSettled([
    sendPushNotification(payload),
    sendNtfyNotification(payload),
    sendTelegramNotification(payload, config.notifications.telegram_chat_id ?? undefined),
  ]);
}

// --- Event-driven notifications ---

/**
 * Notify when a run completes successfully.
 */
export async function notifyRunCompleted(taskPrompt: string, agentName: string): Promise<void> {
  await notify({
    title: 'Run Completed',
    body: `${agentName}: ${taskPrompt.substring(0, 80)}`,
    url: '/review',
    tag: 'run-completed',
  });
}

/**
 * Notify when a run fails.
 */
export async function notifyRunFailed(taskPrompt: string, agentName: string): Promise<void> {
  await notify({
    title: 'Run Failed',
    body: `${agentName}: ${taskPrompt.substring(0, 80)}`,
    url: '/tasks',
    tag: 'run-failed',
  });
}

/**
 * Notify when the task queue is empty.
 */
export async function notifyQueueEmpty(): Promise<void> {
  await notify({
    title: 'Queue Empty',
    body: 'All tasks completed. Load more tasks to keep agents working.',
    url: '/tasks',
    tag: 'queue-empty',
  });
}

/**
 * Notify when a spawned agent crashes.
 */
export async function notifyAgentCrashed(agentName: string, agentId: string): Promise<void> {
  await notify({
    title: 'Agent Crashed',
    body: `${agentName} has crashed and will be auto-restarted.`,
    url: `/agent/${agentId}`,
    tag: 'agent-crashed',
  });
}

/**
 * Generate and send a daily summary notification.
 */
export async function sendDailySummary(): Promise<void> {
  const tasks = listTasks();
  const runs = listRuns();

  const today = new Date().toISOString().split('T')[0];
  const todayRuns = runs.filter((r) => r.started_at.startsWith(today));
  const completed = todayRuns.filter((r) => r.status === 'done').length;
  const failed = todayRuns.filter((r) => r.status === 'failed').length;
  const pending = tasks.filter((t) => t.status === 'pending').length;
  const running = tasks.filter((t) => t.status === 'running').length;

  await notify({
    title: 'WaveCode Daily Summary',
    body: `Today: ${completed} completed, ${failed} failed. Queue: ${pending} pending, ${running} running.`,
    url: '/',
    tag: 'daily-summary',
  });
}
