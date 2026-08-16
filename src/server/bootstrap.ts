import { listAgents } from './db.js';
import { getConfig } from './config.js';
import * as commandChat from './command-chat.js';
import * as codeReview from './code-review.js';
import * as teamManager from './team-manager.js';
import * as fileSharing from './file-sharing.js';
import * as notifications from './notifications.js';
import * as outputWatcher from './output-watcher.js';
import * as taskDispatcher from './task-dispatcher.js';
import { startHealthMonitor, stopHealthMonitor } from './health-monitor.js';
import { pruneOldArtifacts } from './artifact-manager.js';
import { reconcileStartupState, type StartupReconcileResult } from './startup-reconcile.js';
import logger from './logger.js';

/** Pick up out-of-band pending inserts (CLI fallback, scripts) that skipped HTTP. */
export const DISPATCH_POLL_MS = 10_000;

let artifactPruneTimer: ReturnType<typeof setInterval> | null = null;
let dispatchTimer: ReturnType<typeof setInterval> | null = null;

export interface BootstrapResult {
  agentCount: number;
  startupReconciliation: StartupReconcileResult;
}

export async function bootstrapApplication(): Promise<BootstrapResult> {
  ensureArtifactPruning();
  ensureDispatchPolling();

  commandChat.ensureChatTable();
  codeReview.ensureReviewTable();
  teamManager.ensureTeamTables();
  fileSharing.ensureFileSharingTable();
  teamManager.startAllCommsWatchers();
  notifications.getVapidPublicKey();

  const startupReconciliation = await reconcileStartupState();

  startHealthMonitor();

  return {
    agentCount: listAgents().length,
    startupReconciliation,
  };
}

export function shutdownApplication(): void {
  stopHealthMonitor();
  outputWatcher.stopAll();
  teamManager.stopAllCommsWatchers();

  if (artifactPruneTimer) {
    clearInterval(artifactPruneTimer);
    artifactPruneTimer = null;
  }

  if (dispatchTimer) {
    clearInterval(dispatchTimer);
    dispatchTimer = null;
  }
}

function ensureArtifactPruning(): void {
  if (artifactPruneTimer) return;

  artifactPruneTimer = setInterval(() => {
    const pruned = pruneOldArtifacts();
    if (pruned > 0) {
      logger.info({ pruned }, 'Pruned old artifacts');
    }
  }, 24 * 60 * 60 * 1000);
}

function ensureDispatchPolling(): void {
  if (dispatchTimer) return;

  dispatchTimer = setInterval(() => {
    try {
      if (!getConfig().autonomy.auto_dispatch) return;
      void taskDispatcher.dispatchNext();
    } catch (err) {
      logger.debug({ error: (err as Error).message }, 'Dispatch poll skipped');
    }
  }, DISPATCH_POLL_MS);
}
