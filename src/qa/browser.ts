/**
 * Thin Playwright wrapper exposing only the actions the QA agent is allowed
 * to take. Centralising this here means the LLM tool definitions in llm.ts
 * map 1:1 to functions here, and the runner doesn't touch Playwright APIs
 * directly.
 *
 * Console errors and unhandled page errors are captured automatically and
 * exposed via drainConsoleEvents() — the runner attaches them to each
 * screenshot so the LLM can correlate visual state with JS failures.
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

export interface ConsoleEvent {
  type: 'error' | 'warning' | 'pageerror';
  text: string;
  ts: number;
}

export interface ScreenshotResult {
  path: string;
  bytes: Buffer;
  width: number;
  height: number;
}

export interface BrowserSession {
  page: Page;
  screenshot(label: string): Promise<ScreenshotResult>;
  click(selector: string, by?: 'css' | 'text' | 'role'): Promise<void>;
  type(selector: string, value: string, by?: 'css' | 'placeholder' | 'label'): Promise<void>;
  pressKey(key: string): Promise<void>;
  navigate(url: string): Promise<void>;
  scroll(direction: 'up' | 'down', amount: number): Promise<void>;
  wait(seconds: number): Promise<void>;
  drainConsoleEvents(): ConsoleEvent[];
  close(): Promise<void>;
}

export async function launchBrowser(opts: {
  startingUrl: string;
  sessionDir: string;
  headless?: boolean;
  viewport?: { width: number; height: number };
}): Promise<BrowserSession> {
  const browser: Browser = await chromium.launch({
    headless: opts.headless ?? true,
  });

  const context: BrowserContext = await browser.newContext({
    viewport: opts.viewport ?? { width: 1280, height: 800 },
    recordVideo: {
      dir: path.join(opts.sessionDir, 'video'),
      size: opts.viewport ?? { width: 1280, height: 800 },
    },
  });

  const page = await context.newPage();
  const consoleBuffer: ConsoleEvent[] = [];

  page.on('console', (msg) => {
    const t = msg.type();
    if (t === 'error' || t === 'warning') {
      consoleBuffer.push({ type: t, text: msg.text(), ts: Date.now() });
    }
  });

  page.on('pageerror', (err) => {
    consoleBuffer.push({ type: 'pageerror', text: err.message, ts: Date.now() });
  });

  fs.mkdirSync(path.join(opts.sessionDir, 'screenshots'), { recursive: true });

  await page.goto(opts.startingUrl, { waitUntil: 'domcontentloaded' });

  let screenshotIndex = 0;

  return {
    page,

    async screenshot(label: string): Promise<ScreenshotResult> {
      const idx = String(screenshotIndex++).padStart(3, '0');
      const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
      const filename = `${idx}-${safeLabel}.png`;
      const filepath = path.join(opts.sessionDir, 'screenshots', filename);
      const buf = await page.screenshot({ path: filepath, fullPage: false });
      const vp = page.viewportSize() ?? { width: 1280, height: 800 };
      return { path: filepath, bytes: buf, width: vp.width, height: vp.height };
    },

    async click(selector: string, by: 'css' | 'text' | 'role' = 'css'): Promise<void> {
      const locator =
        by === 'text'
          ? page.getByText(selector, { exact: false }).first()
          : by === 'role'
            ? page.getByRole(selector as Parameters<typeof page.getByRole>[0]).first()
            : page.locator(selector).first();
      await locator.click({ timeout: 8000 });
    },

    async type(
      selector: string,
      value: string,
      by: 'css' | 'placeholder' | 'label' = 'css',
    ): Promise<void> {
      const locator =
        by === 'placeholder'
          ? page.getByPlaceholder(selector).first()
          : by === 'label'
            ? page.getByLabel(selector).first()
            : page.locator(selector).first();
      await locator.fill(value, { timeout: 8000 });
    },

    async pressKey(key: string): Promise<void> {
      await page.keyboard.press(key);
    },

    async navigate(url: string): Promise<void> {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    },

    async scroll(direction: 'up' | 'down', amount: number): Promise<void> {
      const delta = direction === 'down' ? amount : -amount;
      await page.evaluate((d) => window.scrollBy(0, d), delta);
    },

    async wait(seconds: number): Promise<void> {
      await page.waitForTimeout(Math.min(seconds * 1000, 10_000));
    },

    drainConsoleEvents(): ConsoleEvent[] {
      const events = consoleBuffer.slice();
      consoleBuffer.length = 0;
      return events;
    },

    async close(): Promise<void> {
      await context.close();
      await browser.close();
    },
  };
}
