/**
 * Startup maintenance: one-shot cleanup run on server boot.
 *
 * Fixes accumulating bloat that previously required manual intervention:
 *   - agent log files pile up in data/agent-logs (17k+ files, 845MB observed)
 *   - agent_output table grows unbounded (187k rows, 2GB DB observed)
 *   - SQLite WAL grows without automatic checkpoint
 *
 * Safe by construction: never touches agents, jobs, or workflows tied to a
 * currently-running workflow. Terminal agents older than the retention window
 * are pruned; their output rows follow; then checkpoint + conditional VACUUM.
 *
 * Designed to be cheap on a healthy system (few deletes, skip VACUUM if DB <
 * threshold) and recover-friendly on a bloated one.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getDb } from '../db/database.js';
import { maintenanceLogger } from '../lib/logger.js';

const LOGS_DIR = path.join(process.cwd(), 'data', 'agent-logs');
const LOG_RETENTION_DAYS = 7;
const VACUUM_THRESHOLD_MB = 500;

const log = maintenanceLogger();

interface PruneStats {
  agentsPruned: number;
  logFilesDeleted: number;
  outputRowsDeleted: number;
  vacuumedMb: number;
}

/**
 * Run once at startup. Returns stats for the log line; never throws.
 */
export function runStartupMaintenance(): PruneStats {
  const stats: PruneStats = {
    agentsPruned: 0,
    logFilesDeleted: 0,
    outputRowsDeleted: 0,
    vacuumedMb: 0,
  };

  try {
    const cutoffMs = Date.now() - LOG_RETENTION_DAYS * 86_400_000;
    const pruneIds = selectPruneableAgentIds(cutoffMs);
    stats.agentsPruned = pruneIds.length;

    if (pruneIds.length > 0) {
      stats.logFilesDeleted = deleteLogFiles(pruneIds);
      stats.outputRowsDeleted = deleteAgentOutput(pruneIds);
    }

    stats.vacuumedMb = maybeVacuum();

    log.info(stats, 'startup maintenance complete');
  } catch (err) {
    log.error({ err }, 'startup maintenance failed — continuing boot');
  }

  return stats;
}

/**
 * Agent IDs safe to prune: terminal, finished before cutoff, and whose parent
 * workflow (if any) is not currently running. Orphans (job deleted) are
 * pruneable too.
 */
function selectPruneableAgentIds(cutoffMs: number): string[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT a.id FROM agents a
    LEFT JOIN jobs j ON a.job_id = j.id
    LEFT JOIN workflows w ON j.workflow_id = w.id
    WHERE a.finished_at IS NOT NULL
      AND a.finished_at < ?
      AND (w.id IS NULL OR w.status != 'running')
  `).all(cutoffMs) as Array<{ id: string }>;
  return rows.map(r => r.id);
}

function deleteLogFiles(agentIds: string[]): number {
  let deleted = 0;
  for (const id of agentIds) {
    for (const ext of ['.ndjson', '.stderr', '.prompt', '.snapshot']) {
      try {
        fs.unlinkSync(path.join(LOGS_DIR, id + ext));
        deleted++;
      } catch {
        // missing file is fine
      }
    }
  }
  return deleted;
}

function deleteAgentOutput(agentIds: string[]): number {
  const db = getDb();
  // Batch in chunks of 500 to stay under SQLite parameter limits
  let total = 0;
  for (let i = 0; i < agentIds.length; i += 500) {
    const chunk = agentIds.slice(i, i + 500);
    const placeholders = chunk.map(() => '?').join(',');
    const info = db.prepare(`DELETE FROM agent_output WHERE agent_id IN (${placeholders})`).run(...chunk);
    total += (info.changes ?? 0) as number;
  }
  return total;
}

/**
 * Checkpoint WAL unconditionally (cheap), and VACUUM only if the main DB
 * is past the size threshold. VACUUM is expensive (rewrites the entire DB)
 * so we don't run it on every boot of a healthy server.
 */
function maybeVacuum(): number {
  const db = getDb();
  try {
    db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all();
  } catch (err) {
    log.warn({ err }, 'WAL checkpoint failed');
  }

  try {
    const dbPath = path.join(process.cwd(), 'data', 'orchestrator.db');
    const sizeMb = Math.round(fs.statSync(dbPath).size / 1_000_000);
    if (sizeMb < VACUUM_THRESHOLD_MB) return 0;

    log.info({ sizeMb, threshold: VACUUM_THRESHOLD_MB }, 'DB over threshold — running VACUUM');
    db.prepare('VACUUM').run();
    db.prepare('ANALYZE').run();
    const afterMb = Math.round(fs.statSync(dbPath).size / 1_000_000);
    return sizeMb - afterMb;
  } catch (err) {
    log.warn({ err }, 'VACUUM failed');
    return 0;
  }
}
