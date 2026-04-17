// Sentry init is preloaded via `node --import ./dist/server/instrument.js`.
import * as Sentry from '@sentry/node';
import { serverLogger, socketLogger } from './lib/logger.js';
import { createServer } from 'http';
import express from 'express';
import compression from 'compression';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb, closeDb } from './db/database.js';
import { initSocketManager } from './socket/SocketManager.js';
import apiRouter from './api/router.js';
import { createMcpApp, closeAllMcpSessions } from './mcp/McpServer.js';
import { startWorkQueue, stopWorkQueue, setMaxConcurrent } from './orchestrator/WorkQueueManager.js';
import { startWatchdog, stopWatchdog } from './orchestrator/StuckJobWatchdog.js';
import { startHealthMonitor, stopHealthMonitor } from './orchestrator/HealthMonitor.js';
import { startWorktreeCleanup, stopWorktreeCleanup } from './orchestrator/WorktreeCleanup.js';
import { startKBConsolidator, stopKBConsolidator } from './orchestrator/KBConsolidator.js';
import { startGitHubPoller, stopGitHubPoller } from './integrations/GitHubPoller.js';
import { runRecovery, startWorkflowGapDetector, stopWorkflowGapDetector } from './orchestrator/recovery.js';
import { rehydrateCooldownState } from './orchestrator/ModelClassifier.js';
import { startResourceMonitor, stopResourceMonitor, setQueueControls } from './orchestrator/ResourceMonitor.js';
import { startDbBackup, stopDbBackup, runBackupNow } from './orchestrator/DbBackup.js';
import { runStartupMaintenance } from './orchestrator/StartupMaintenance.js';
import { writeInput, resizePty, resizeAndSnapshot, saveSnapshot, isTmuxSessionAlive } from './orchestrator/PtyManager.js';
import * as queries from './db/queries.js';
import type { QueueSnapshot } from '../shared/types.js';

const log = serverLogger();
const sockLog = socketLogger();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 3456);
const MCP_PORT = Number(process.env.MCP_PORT ?? 3947);
const DB_PATH = process.env.DB_PATH ?? path.join(process.cwd(), 'data', 'orchestrator.db');

// ── Global error handlers ────────────────────────────────────────────────────
// Log uncaught errors but EXIT for fatal ones (e.g. EADDRINUSE from a duplicate
// server process). Without exit, a zombie process keeps running WorkQueue and
// dispatching agents whose socket events go nowhere.
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  log.error({ err }, 'Uncaught exception');
  Sentry.captureException(err);
  if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
    log.fatal({ err }, 'Fatal: port in use');
    process.exit(1);
  }
});
process.on('unhandledRejection', (reason) => {
  log.error({ err: reason }, 'Unhandled rejection');
  Sentry.captureException(reason);
});

async function main() {
  // 1. Init database
  initDb(DB_PATH);
  log.info({ dbPath: DB_PATH }, 'DB initialized');

  // Populate FTS index for any existing output rows not yet indexed
  queries.rebuildFts();

  // Prune old agent logs / orphaned output rows, checkpoint WAL, and VACUUM
  // if the DB has grown past the threshold. Runs once, non-fatal on failure.
  runStartupMaintenance();

  // Rehydrate rate-limit cooldown state from DB so cooldowns survive restarts
  rehydrateCooldownState();

  // 2. Main Express app
  const app = express();
  app.use(cors());
  app.use(compression());
  app.use(express.json());

  // REST API
  app.use('/api', apiRouter);

  // Sentry request handler — adds request context to all events
  Sentry.setupExpressErrorHandler(app);

  // Serve built client in production
  const clientDist = path.join(__dirname, '../../dist/client');
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });

  // 4. HTTP server + Socket.io
  const httpServer = createServer(app);
  const io = initSocketManager(httpServer);

  // Send snapshot on connect; also respond to explicit re-requests (e.g. after StrictMode remount or HMR)
  // Short-TTL cache so multiple rapid connections (HMR, tabs) don't each run the full query set.
  let snapshotCache: { data: QueueSnapshot; expires: number } | null = null;
  const SNAPSHOT_CACHE_TTL = 1500; // 1.5s

  const buildSnapshot = () => {
    const now = Date.now();
    if (snapshotCache && now < snapshotCache.expires) return snapshotCache.data;
    const data = {
      jobs: queries.listJobsSlim(),
      agents: queries.getAgentsWithJobForSnapshot(),
      locks: queries.getAllActiveLocks(),
      templates: queries.listTemplates(),
      projects: queries.listProjects(),
      batchTemplates: queries.listBatchTemplates(),
      debates: queries.listDebates(),
      workflows: queries.listWorkflows(),
      discussions: queries.listDiscussions(),
      proposals: queries.listProposals(),
    };
    snapshotCache = { data, expires: now + SNAPSHOT_CACHE_TTL };
    return data;
  };

  io.on('connection', (socket) => {
    try { socket.emit('queue:snapshot', buildSnapshot()); } catch (err) { sockLog.error({ err }, 'snapshot error'); }

    socket.on('request:snapshot', () => {
      try { socket.emit('queue:snapshot', buildSnapshot()); } catch (err) { sockLog.error({ err }, 'snapshot error'); }
    });

    socket.on('pty:input', ({ agent_id, data }) => { try { writeInput(agent_id, data); } catch (err) { sockLog.error({ err, agentId: agent_id }, 'pty:input error'); } });
    socket.on('pty:resize', ({ agent_id, cols, rows }) => { try { resizePty(agent_id, cols, rows); } catch (err) { sockLog.error({ err, agentId: agent_id }, 'pty:resize error'); } });
    socket.on('pty:resize-and-snapshot', async ({ agent_id, cols, rows }) => {
      try {
        const snapshot = await resizeAndSnapshot(agent_id, cols, rows);
        if (snapshot) {
          socket.emit('pty:snapshot-refresh', { agent_id, snapshot });
        }
      } catch (err) {
        sockLog.error({ err, agentId: agent_id }, 'pty:resize-and-snapshot error');
      }
    });
  });

  // Recovery may emit socket updates; run it only after SocketManager exists.
  runRecovery();

  // 5. MCP server on separate port
  const mcpApp = createMcpApp();
  const mcpServer = mcpApp.listen(MCP_PORT, () => {
    log.info({ mcpPort: MCP_PORT }, 'MCP server listening');
  });
  // Disable idle timeouts on the MCP server. Node.js defaults (keepAliveTimeout=5s,
  // headersTimeout=60s, requestTimeout=300s) close HTTP connections mid-flight on
  // long-running tools like wait_for_jobs, leaving agents hung.
  mcpServer.keepAliveTimeout = 0;
  mcpServer.headersTimeout = 0;
  mcpServer.requestTimeout = 0;
  // Enable TCP keepalive probes so the OS doesn't silently drop idle connections
  // during long wait_for_jobs polls (no bytes flow while the server-side loop runs).
  mcpServer.on('connection', (socket) => {
    socket.setKeepAlive(true, 30_000);
  });

  // 6. Start work queue + stuck-job watchdog
  startWorkQueue();
  startWatchdog();
  startHealthMonitor();
  startWorktreeCleanup();
  startWorkflowGapDetector();
  startKBConsolidator();
  startGitHubPoller();
  startResourceMonitor();
  startDbBackup(DB_PATH);
  setQueueControls(stopWorkQueue, startWorkQueue);

  // Restore persisted settings
  const savedMax = queries.getNote('setting:maxConcurrentAgents');
  if (savedMax) setMaxConcurrent(Number(savedMax.value));

  // 7. Start main server
  httpServer.listen(PORT, () => {
    log.info({ port: PORT }, 'Orchestrator listening');
  });

  // 8. Graceful shutdown with connection draining
  let shuttingDown = false;


  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'Shutting down gracefully');

    // Hard-exit watchdog: if shutdown takes >30s, force it
    // (increased from 10s to allow running agents time to reach a checkpoint)
    const watchdog = setTimeout(() => {
      log.error('Shutdown timed out');
      process.exit(1);
    }, 30_000);
    watchdog.unref(); // don't let this alone keep the process alive

    // Phase 1: Stop dispatching new jobs but keep monitors running briefly
    // so in-flight agents can still report status and release locks.
    stopWorkQueue();
    log.info('Stopped work queue');

    // Phase 2: Notify all running agents to finish gracefully.
    // Send SIGTERM to give them a chance to commit work-in-progress.
    try {
      const runningAgents = queries.listAllRunningAgents();
      if (runningAgents.length > 0) {
        log.info({ count: runningAgents.length }, 'Sending SIGTERM');
        for (const agent of runningAgents) {
          if (agent.pid != null) {
            try { process.kill(agent.pid, 'SIGTERM'); } catch { /* already gone */ }
          }
        }
        // Give agents a brief window to wrap up (e.g. finish current tool call)
        const DRAIN_TIMEOUT_MS = 5_000;
        await new Promise(resolve => setTimeout(resolve, DRAIN_TIMEOUT_MS));
      }
    } catch (err) {
      log.error({ err }, 'Agent drain error');
    }

    // Phase 3: Stop all periodic monitors
    stopWatchdog();
    stopHealthMonitor();
    stopWorktreeCleanup();
    stopWorkflowGapDetector();
    stopKBConsolidator();
    stopGitHubPoller();
    stopResourceMonitor();
    stopDbBackup();

    // Run a final backup before closing the database
    runBackupNow();

    // Phase 4: Save tmux snapshots for all running agents so recovery on restart
    // has the latest terminal state.
    try {
      const runningAgents = queries.listAllRunningAgents();
      let snapshotCount = 0;
      for (const agent of runningAgents) {
        if (isTmuxSessionAlive(agent.id)) {
          saveSnapshot(agent.id);
          snapshotCount++;
        }
      }
      if (snapshotCount > 0) {
        log.info({ count: snapshotCount }, 'Saved snapshots');
      }
    } catch (err) {
      log.error({ err }, 'Snapshot error');
    }

    // Phase 5: Stop accepting new HTTP connections; wait for in-flight requests to drain
    // closeAllConnections() force-destroys keep-alive sockets so close() resolves
    // quickly instead of waiting for client timeouts, which was the cause of
    // EADDRINUSE errors on fast restart (agents hold MCP keepalive connections).
    httpServer.closeAllConnections?.();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));

    // Close all active MCP sessions so clients get a clean disconnect
    await closeAllMcpSessions();

    // Close the MCP server
    mcpServer.closeAllConnections?.();
    await new Promise<void>((resolve) => mcpServer.close(() => resolve()));

    // Disconnect all Socket.io clients
    io.close();

    // Close the database
    closeDb();

    // Flush Sentry events before exit
    await Sentry.flush(2000).catch(() => {});

    clearTimeout(watchdog);
    log.info('Shutdown complete');
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM').catch(err => { log.error({ err }, 'Shutdown error'); process.exit(1); }));
  process.on('SIGINT',  () => shutdown('SIGINT').catch(err => { log.error({ err }, 'Shutdown error'); process.exit(1); }));
}

main().catch((err) => {
  log.fatal({ err }, 'Fatal startup error');
  process.exit(1);
});
