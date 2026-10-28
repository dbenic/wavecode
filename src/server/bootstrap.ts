import { listAgents } from './db.js';
import { getConfig } from './config.js';
import * as commandChat from './command-chat.js';
import * as codeReview from './code-review.js';
import * as peers from './peers.js';
import * as inboxWatch from './inbox-watch.js';
import * as releaseFreezes from './release-freezes.js';
import * as fixtures from './fixtures.js';
import * as releases from './releases.js';
import * as overlord from './overlord.js';
import * as productDesk from './product-desk.js';
import * as usageProbe from './usage-probe.js';
import * as teamManager from './team-manager.js';
import * as fileSharing from './file-sharing.js';
import * as notifications from './notifications.js';
import * as outputWatcher from './output-watcher.js';
import * as taskDispatcher from './task-dispatcher.js';
import { startHealthMonitor, stopHealthMonitor } from './health-monitor.js';
import { startEventLoopMonitor, stopEventLoopMonitor } from './event-loop.js';
import { pruneOldArtifacts } from './artifact-manager.js';
import { reconcileStartupState, type StartupReconcileResult } from './startup-reconcile.js';
import { rebindAgentSockets } from './session-manager.js';
import * as tmux from './tmux.js';
import { startLaneBoard, stopLaneBoard } from './dev-lanes.js';
import { startPerfMonitor } from './perf-monitor.js';
import { startModelGuard } from './model-switch.js';
import { startTestPortal } from './test-portal.js';
import { startPaneMigration } from './pane-migrate.js';
import { startEventRetention } from './event-retention.js';
import { startDeployReconciler, stopDeployReconciler } from './deploy-state.js';
import { startMergeQueueTimer, stopMergeQueueTimer } from './merge-queue.js';
import { startDeliveryTimer, stopDeliveryTimer } from './deliveries.js';
import * as replyCapture from './reply-capture.js';
import { startSlackBridge, stopSlackBridge } from './slack-bridge.js';
import { startOpsLanes, stopOpsLanes } from './ops-lanes.js';
import { closeAllPaneStreams, resetStalePipes } from './terminal-stream.js';
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
  peers.ensurePeerTables();
  releaseFreezes.ensureReleaseFreezeTable();
  releases.ensureReleaseTables();
  overlord.ensureOverlordTable();
  usageProbe.ensureUsageTable();
  teamManager.ensureTeamTables();
  fileSharing.ensureFileSharingTable();
  replyCapture.loadPendingReplies(); // prompts still unanswered at the last stop: their answers are captured after the restart
  teamManager.startAllCommsWatchers();
  notifications.getVapidPublicKey();

  await tmux.applyAgentPaneDefaults();
  await resetStalePipes(); // a pipe-pane left by an earlier daemon has no reader
  await rebindAgentSockets();
  startEventLoopMonitor();
  startPerfMonitor();
  startEventRetention();
  startModelGuard();
  startTestPortal();
  startPaneMigration();
  startLaneBoard();
  startDeployReconciler();
  startMergeQueueTimer();
  startDeliveryTimer();
  startOpsLanes();

  const startupReconciliation = await reconcileStartupState();

  startHealthMonitor();
  peers.startPeerPollers();
  inboxWatch.startInboxWatchers();
  releaseFreezes.startFreezeWatchers();
  fixtures.startFixtureWatchers();
  releases.startReleasePollers();
  releases.startStagingTipLog();
  overlord.startOverlord();
  productDesk.startDeskRefresh();
  usageProbe.startUsageProbe();
  startSlackBridge();

  return {
    agentCount: listAgents().length,
    startupReconciliation,
  };
}

export function shutdownApplication(): void {
  stopEventLoopMonitor();
  stopHealthMonitor();
  peers.stopPeerPollers();
  inboxWatch.stopInboxWatchers();
  releaseFreezes.stopFreezeWatchers();
  fixtures.stopFixtureWatchers();
  releases.stopReleasePollers();
  releases.stopStagingTipLog();
  overlord.stopOverlord();
  productDesk.stopDeskRefresh();
  usageProbe.stopUsageProbe();
  stopLaneBoard();
  stopDeployReconciler();
  stopMergeQueueTimer();
  stopDeliveryTimer();
  stopSlackBridge();
  stopOpsLanes();
  closeAllPaneStreams();
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
