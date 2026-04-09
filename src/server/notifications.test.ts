/**
 * Phase 2 Tests — notifications.ts (VAPID persistence, Telegram chatId)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Mock web-push before importing
vi.mock('web-push', () => ({
  default: {
    generateVAPIDKeys: vi.fn(() => ({
      publicKey: 'test-public-key-' + Math.random().toString(36).slice(2),
      privateKey: 'test-private-key-' + Math.random().toString(36).slice(2),
    })),
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(),
  },
}));

describe('notifications.ts — VAPID persistence', () => {
  let tmpDir: string;
  let dbPath: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-notif-test-'));
    dbPath = path.join(tmpDir, 'test.db');
    configPath = path.join(tmpDir, 'config.yaml');
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('generates VAPID keys on first run and persists them', async () => {
    // Set up config with web_push enabled
    const { loadConfig } = await import('./config.js');
    loadConfig(configPath);
    const { updateConfig } = await import('./config.js');
    updateConfig({ notifications: { web_push: true, ntfy_topic: null, telegram_bot_token: null, telegram_chat_id: null } });

    // Init DB
    const { initDb, getDb, resetDbForTest } = await import('./db.js');
    initDb(dbPath);

    // Init web push
    const { initWebPush } = await import('./notifications.js');
    const result = initWebPush();
    expect(result).not.toBeNull();
    expect(result!.publicKey).toBeTruthy();

    // Verify keys were persisted to DB
    const row = getDb().prepare('SELECT value FROM kv_settings WHERE key = ?').get('vapid_keys') as { value: string } | undefined;
    expect(row).toBeTruthy();
    const keys = JSON.parse(row!.value);
    expect(keys.publicKey).toBe(result!.publicKey);

    resetDbForTest();
  });

  it('reuses persisted VAPID keys on subsequent runs', async () => {
    const { loadConfig, updateConfig } = await import('./config.js');
    loadConfig(configPath);
    updateConfig({ notifications: { web_push: true, ntfy_topic: null, telegram_bot_token: null, telegram_chat_id: null } });

    const { initDb, getDb, resetDbForTest } = await import('./db.js');
    initDb(dbPath);

    // First init — generates keys
    const { initWebPush } = await import('./notifications.js');
    const first = initWebPush();
    expect(first).not.toBeNull();

    // Read back from DB
    const row = getDb().prepare('SELECT value FROM kv_settings WHERE key = ?').get('vapid_keys') as { value: string };
    const firstKeys = JSON.parse(row.value);

    // "Restart" — re-init should reuse existing keys
    const second = initWebPush();
    expect(second).not.toBeNull();
    // The DB still has the same keys (not regenerated)
    const row2 = getDb().prepare('SELECT value FROM kv_settings WHERE key = ?').get('vapid_keys') as { value: string };
    const secondKeys = JSON.parse(row2.value);
    expect(secondKeys.publicKey).toBe(firstKeys.publicKey);
    expect(secondKeys.privateKey).toBe(firstKeys.privateKey);

    resetDbForTest();
  });
});

describe('notifications.ts — Telegram chatId', () => {
  it('sendTelegramNotification requires chatId parameter', async () => {
    // The function should return early when chatId is undefined
    const { sendTelegramNotification } = await import('./notifications.js');

    // Mock fetch to track if it was called
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));

    await sendTelegramNotification(
      { title: 'Test', body: 'msg', url: '/', tag: 'test' },
      undefined, // no chatId
    );

    // fetch should NOT have been called since chatId is undefined
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('sendTelegramNotification calls API when chatId is provided', async () => {
    // Need to set config with telegram_bot_token
    const { loadConfig, updateConfig } = await import('./config.js');
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-tg-'));
    loadConfig(path.join(tmpDir2, 'config.yaml'));
    updateConfig({ notifications: { web_push: false, ntfy_topic: null, telegram_bot_token: 'fake-bot-token', telegram_chat_id: '12345' } });

    const { sendTelegramNotification } = await import('./notifications.js');

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));

    await sendTelegramNotification(
      { title: 'Test', body: 'msg', url: '/', tag: 'test' },
      '12345',
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const callUrl = fetchSpy.mock.calls[0][0] as string;
    expect(callUrl).toContain('api.telegram.org');
    expect(callUrl).toContain('fake-bot-token');

    fetchSpy.mockRestore();
    fs.rmSync(tmpDir2, { recursive: true, force: true });
  });
});
