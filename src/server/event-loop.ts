/**
 * Event-loop delay. A stall here is the page stall: one blocked thread
 * cannot answer `/` or `/index.html`.
 */

import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import logger from './logger.js';

const RESOLUTION_MS = 20;
const SAMPLE_MS = 5_000;
const WARN_MS = 200;

export interface EventLoopLag {
  p99_ms: number;
  max_ms: number;
}

let histogram: IntervalHistogram | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let latest: EventLoopLag = { p99_ms: 0, max_ms: 0 };

function roundMs(ns: number): number {
  if (!Number.isFinite(ns) || ns < 0) return 0;
  return Math.round(ns / 1e6);
}

function read(h: IntervalHistogram): EventLoopLag {
  return { p99_ms: roundMs(h.percentile(99)), max_ms: roundMs(h.max) };
}

function sample(): void {
  if (!histogram) return;
  const lag = read(histogram);
  latest = lag;
  if (lag.max_ms > WARN_MS) {
    logger.warn({ p99_ms: lag.p99_ms, max_ms: lag.max_ms }, 'Event loop lag');
  }
  histogram.reset();
}

export function startEventLoopMonitor(): void {
  if (histogram) return;
  histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  histogram.enable();
  timer = setInterval(sample, SAMPLE_MS);
  timer.unref?.();
}

export function stopEventLoopMonitor(): void {
  if (timer) clearInterval(timer);
  timer = null;
  histogram?.disable();
  histogram = null;
  latest = { p99_ms: 0, max_ms: 0 };
}

/** The last completed window, or the live histogram when a window is open. */
export function eventLoopLag(): EventLoopLag {
  if (!histogram) return latest;
  const live = read(histogram);
  return {
    p99_ms: Math.max(latest.p99_ms, live.p99_ms),
    max_ms: Math.max(latest.max_ms, live.max_ms),
  };
}

export function resetEventLoopMonitorForTest(): void {
  stopEventLoopMonitor();
}

/** Run one sample now. Tests use this instead of waiting out the 5 s window. */
export function sampleEventLoopForTest(): void {
  sample();
}
