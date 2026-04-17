import { randomUUID } from 'crypto';
import { execSync, execFileSync } from 'child_process';
import { existsSync, statSync } from 'fs';
import path from 'path';
import { captureWithContext, Sentry } from '../instrument.js';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import type { Job, Workflow, WorkflowPhase, StopMode } from '../../shared/types.js';
import { effectiveMaxTurns, isCodexModel } from '../../shared/types.js';
import { buildAssessPrompt, buildWorkflowRepairPrompt, buildSimplifiedAssessRepairPrompt, type InlineWorkflowContext } from './WorkflowPrompts.js';
import { getAvailableModel, getFallbackModel, getAlternateProviderModel, getModelProvider, markModelRateLimited, markProviderRateLimited } from './ModelClassifier.js';
import { classifyJobFailure, isFallbackEligibleFailure, isSameModelRetryEligible, shouldMarkProviderUnavailable } from './FailureClassifier.js';
import { nudgeQueue } from './WorkQueueManager.js';
import { logResilienceEvent } from './ResilienceLogger.js';
import { errMsg } from '../../shared/errors.js';
import { validateTransition } from './StateTransitions.js';
import { tryAcquireRecoverySlot, RecoveryKeys } from './WorkflowRecovery.js';
import { getPhaseConfig } from './WorkflowPhaseConfig.js';

// ─── Sub-module imports ────────────────────────────────────────────────────
import { parseMilestones, meetsCompletionThreshold, recoverPlanFromAgentOutput } from './WorkflowMilestoneParser.js';
import { ensureWorktreeBranch, verifyWorktreeHealth, createWorkflowWorktree, restoreWorkflowWorktree } from './WorkflowWorktreeManager.js';
import { pushAndCreatePr as _pushAndCreatePr, finalizeWorkflow as _finalizeWorkflow, reconcileBlockedPRs as _reconcileBlockedPRs } from './WorkflowPRCreator.js';
import { diagnoseWriteNoteInOutput, formatWriteNoteDiagnostic, writeBlockedDiagnostic } from './WorkflowBlockedDiagnostics.js';

// ─── Re-exports (preserve public API — all import sites continue to work) ──
export { parseMilestones, meetsCompletionThreshold, recoverPlanFromAgentOutput, extractPlanFromText } from './WorkflowMilestoneParser.js';
export { ensureWorktreeBranch, verifyWorktreeHealth, cleanupWorktree } from './WorkflowWorktreeManager.js';
export { countBranchCommits, getPrCreationOutcome, _buildPrBody } from './WorkflowPRCreator.js';
export type { WorkflowPrCreationOutcome } from './WorkflowPRCreator.js';
export { diagnoseWriteNoteInOutput, writeBlockedDiagnostic, BLOCKED_LOG_DIR } from './WorkflowBlockedDiagnostics.js';
export type { WriteNoteDiagnostic } from './WorkflowBlockedDiagnostics.js';

// ─── Module-level state ────────────────────────────────────────────────────

const _processedJobs = new Set<string>();
const _reconciledJobIds = new Map<string, number>();
const RECONCILED_JOB_WINDOW_MS = 60_000;

function pruneReconciledJobIds(now: number): void {
  for (const [jobId, reconciledAt] of _reconciledJobIds) {
    if (now - reconciledAt >= RECONCILED_JOB_WINDOW_MS) {
      _reconciledJobIds.delete(jobId);
    }
  }
}

// ─── Core Lifecycle ─────────────────────────────────────────────────────────

/**
 * Called from AgentRunner.handleJobCompletion after a job's status is finalized.
 * If the job belongs to a workflow, advances to the next phase or completes the workflow.
 */
export function onJobCompleted(job: Job, { force = false }: { force?: boolean } = {}): void {
  if (!job.workflow_id) return;
  if (!force && _processedJobs.has(job.id)) return;
  _processedJobs.add(job.id);
  if (_processedJobs.size > 500) {
    const iter = _processedJobs.values();
    for (let i = 0; i < 250; i++) iter.next();
    const keep = new Set<string>();
    for (const v of iter) keep.add(v);
    _processedJobs.clear();
    for (const v of keep) _processedJobs.add(v);
  }

  try {
    _onJobCompleted(job);
  } catch (err) {
    console.error(`[workflow] error handling job completion for job ${job.id} (workflow=${job.workflow_id}, phase=${job.workflow_phase}, cycle=${job.workflow_cycle}):`, err);
    captureWithContext(err, { job_id: job.id, workflow_id: job.workflow_id ?? undefined, component: 'WorkflowManager' });
  }
}

function _onJobCompleted(job: Job): void {
  const workflow = queries.getWorkflowById(job.workflow_id!);
  if (!workflow || workflow.status !== 'running') return;

  if (job.status === 'cancelled') {
    const reason = `Phase '${job.workflow_phase}' job ${job.id.slice(0, 8)} was cancelled`;
    console.log(`[workflow ${workflow.id}] ${reason} — marking workflow blocked`);
    updateAndEmit(workflow.id, { status: 'blocked', current_phase: job.workflow_phase ?? 'idle', blocked_reason: reason });
    return;
  }

  if (job.status === 'failed') {
    handleFailedJob(job, workflow);
    return;
  }

  let planNote = queries.getNote(RecoveryKeys.plan(workflow.id));
  let milestones = parseMilestones(planNote?.value ?? '');

  switch (job.workflow_phase) {
    case 'assess': {
      try {
        const contractNote = queries.getNote(RecoveryKeys.contract(workflow.id));
        let missingArtifacts = [
          !planNote?.value ? 'plan' : null,
          !contractNote?.value ? 'contract' : null,
        ].filter(Boolean) as string[];

        if (missingArtifacts.includes('plan')) {
          const recovered = recoverPlanFromAgentOutput(job, workflow.id);
          if (recovered) {
            planNote = queries.getNote(RecoveryKeys.plan(workflow.id));
            milestones = parseMilestones(planNote?.value ?? '');
            missingArtifacts = missingArtifacts.filter(a => a !== 'plan');
            console.log(`[workflow ${workflow.id}] recovered plan from agent output (${milestones.total} milestones)`);
          }
        }

        if (missingArtifacts.length > 0) {
          const writeNoteDiag = diagnoseWriteNoteInOutput(job);
          const diagContext = formatWriteNoteDiagnostic(writeNoteDiag);
          console.warn(`[workflow ${workflow.id}] assess missing ${missingArtifacts.join(', ')}: ${writeNoteDiag.status}${writeNoteDiag.status === 'called_but_failed' ? ` — ${writeNoteDiag.failureSummary}` : ''}`);
          if (spawnRepairJob(workflow, 'assess', job.workflow_cycle ?? 0, missingArtifacts, diagContext)) return;
          const assessReason = `Assess phase completed but missing ${missingArtifacts.join(', ')}`;
          console.log(`[workflow ${workflow.id}] ${assessReason} — marking blocked`);
          updateAndEmit(workflow.id, { status: 'blocked', current_phase: 'assess' as WorkflowPhase, blocked_reason: assessReason });
          return;
        }
        if (milestones.total === 0) {
          if (spawnRepairJob(workflow, 'assess', job.workflow_cycle ?? 0, ['plan'])) return;
          const zeroReason = 'Assess phase produced a plan with no milestones';
          console.log(`[workflow ${workflow.id}] ${zeroReason} — marking blocked`);
          updateAndEmit(workflow.id, { status: 'blocked', current_phase: 'assess' as WorkflowPhase, blocked_reason: zeroReason });
          return;
        }
        updateAndEmit(workflow.id, { milestones_total: milestones.total, milestones_done: milestones.done, current_cycle: 1 });
        spawnPhaseJob(queries.getWorkflowById(workflow.id)!, 'review', 1);
      } catch (err) {
        const errorMessage = errMsg(err);
        console.error(`[workflow ${workflow.id}] error in assess handler (cycle ${job.workflow_cycle}):`, err);
        captureWithContext(err, { job_id: job.id, workflow_id: workflow.id, component: 'WorkflowManager' });
        updateAndEmit(workflow.id, { status: 'blocked', current_phase: 'assess' as WorkflowPhase, blocked_reason: `Internal error in assess handler: ${errorMessage}` });
      }
      break;
    }

    case 'review': {
      try {
        if (!planNote?.value) {
          if (spawnRepairJob(workflow, 'review', job.workflow_cycle ?? workflow.current_cycle, ['plan'])) return;
          const reviewReason = 'Review phase completed but plan note was deleted or empty';
          console.log(`[workflow ${workflow.id}] ${reviewReason} — marking blocked`);
          updateAndEmit(workflow.id, { status: 'blocked', current_phase: 'review' as WorkflowPhase, blocked_reason: reviewReason });
          return;
        }
        updateAndEmit(workflow.id, { milestones_total: milestones.total, milestones_done: milestones.done });
        if (planNote?.value) {
          const fixLines = planNote.value.split('\n').filter(line => /^- \[ \] \*\*Fix/.test(line));
          if (fixLines.length > 0) {
            queries.upsertNote(RecoveryKeys.reviewFeedback(workflow.id, job.workflow_cycle ?? workflow.current_cycle), fixLines.join('\n'), null);
          }
        }
        const updated = queries.getWorkflowById(workflow.id)!;
        if (milestones.total > 0 && meetsCompletionThreshold(milestones, updated.completion_threshold)) {
          if (updated.start_command) {
            console.log(`[workflow ${workflow.id}] milestones meet completion threshold after review — spawning verify agent before finalization`);
            spawnPhaseJob(updated, 'verify', updated.current_cycle);
          } else {
            console.log(`[workflow ${workflow.id}] milestones meet completion threshold (${milestones.done}/${milestones.total}, threshold ${updated.completion_threshold}) after review — marking complete`);
            updateAndEmit(workflow.id, { status: 'complete', current_phase: 'idle' as WorkflowPhase });
            finalizeWorkflow(queries.getWorkflowById(workflow.id)!).catch(err => console.error(`[workflow ${workflow.id}] finalizeWorkflow error:`, err));
          }
        } else {
          spawnPhaseJob(updated, 'implement', updated.current_cycle);
        }
      } catch (err) {
        const errorMessage = errMsg(err);
        console.error(`[workflow ${workflow.id}] error in review handler (cycle ${job.workflow_cycle}):`, err);
        captureWithContext(err, { job_id: job.id, workflow_id: workflow.id, component: 'WorkflowManager' });
        updateAndEmit(workflow.id, { status: 'blocked', current_phase: 'review' as WorkflowPhase, blocked_reason: `Internal error in review handler: ${errorMessage}` });
      }
      break;
    }

    case 'implement': {
      try {
        handleImplementCompleted(job, workflow, milestones);
      } catch (err) {
        const errorMessage = errMsg(err);
        console.error(`[workflow ${workflow.id}] error in implement handler (cycle ${job.workflow_cycle}):`, err);
        captureWithContext(err, { job_id: job.id, workflow_id: workflow.id, component: 'WorkflowManager' });
        updateAndEmit(workflow.id, { status: 'blocked', current_phase: 'implement' as WorkflowPhase, blocked_reason: `Internal error in implement handler: ${errorMessage}` });
      }
      break;
    }

    case 'verify': {
      try {
        const cycle = job.workflow_cycle ?? workflow.current_cycle;
        const resultNote = queries.getNote(RecoveryKeys.verifyResult(workflow.id, cycle));
        const resultContent = resultNote?.value ?? '';
        // Match "## Verify Result: PASS" on its own line (not "PASS | FAIL" template text)
        const passed = /^## Verify Result:\s*PASS\s*$/mi.test(resultContent);

        // Persist verify run record for dashboard
        const previousRuns = queries.getVerifyRunsForCycle(workflow.id, cycle);
        const attempt = previousRuns.length + 1;
        queries.insertVerifyRun({
          id: randomUUID(),
          workflow_id: workflow.id,
          cycle,
          attempt,
          command: 'verify-agent',
          exit_code: passed ? 0 : 1,
          stdout: resultContent || null,
          stderr: null,
          duration_ms: null,
          created_at: Date.now(),
        });

        if (passed) {
          console.log(`[workflow ${workflow.id}] verify agent PASSED (cycle ${cycle}, attempt ${attempt}) — finalizing workflow`);
          queries.deleteNote(RecoveryKeys.verifyFailure(workflow.id, cycle));
          updateAndEmit(workflow.id, { status: 'complete', current_phase: 'idle' as WorkflowPhase });
          finalizeWorkflow(queries.getWorkflowById(workflow.id)!).catch(err => console.error(`[workflow ${workflow.id}] finalizeWorkflow error:`, err));
        } else {
          const maxRetries = workflow.max_verify_retries;
          console.log(`[workflow ${workflow.id}] verify agent FAILED (cycle ${cycle}, attempt ${attempt}) — ${attempt}/${maxRetries + 1} failures`);

          // Persist failure note for the next implement prompt
          queries.upsertNote(RecoveryKeys.verifyFailure(workflow.id, cycle), resultContent, null);

          if (attempt <= maxRetries) {
            console.log(`[workflow ${workflow.id}] verify failure ${attempt}/${maxRetries} — re-spawning implement for cycle ${cycle} (verify retry)`);
            spawnPhaseJob(queries.getWorkflowById(workflow.id)!, 'implement', cycle);
          } else {
            const summary = resultContent.slice(0, 300) || '(no result note)';
            const verifyFailReason = `verify_failed: Verify agent failed ${attempt} time(s) on cycle ${cycle}: ${summary}`;
            console.log(`[workflow ${workflow.id}] ${verifyFailReason} — marking blocked`);
            updateAndEmit(workflow.id, {
              status: 'blocked',
              current_phase: 'verify' as WorkflowPhase,
              blocked_reason: verifyFailReason,
            });
          }
        }
      } catch (err) {
        const errorMessage = errMsg(err);
        console.error(`[workflow ${workflow.id}] error in verify handler (cycle ${job.workflow_cycle}):`, err);
        captureWithContext(err, { job_id: job.id, workflow_id: workflow.id, component: 'WorkflowManager' });
        updateAndEmit(workflow.id, { status: 'blocked', current_phase: 'verify' as WorkflowPhase, blocked_reason: `Internal error in verify handler: ${errorMessage}` });
      }
      break;
    }

    default:
      console.warn(`[workflow ${workflow.id}] unknown phase '${job.workflow_phase}' on job ${job.id}`);
  }
}

// ─── Failed Job Handling ──────────────────────────────────────────────────

function handleFailedJob(job: Job, workflow: Workflow): void {
  const phase = job.workflow_phase as WorkflowPhase;
  const cycle = job.workflow_cycle ?? workflow.current_cycle;

  const agents = queries.getAgentsWithJobByJobId(job.id);
  const lastAgent = agents[0];
  if (lastAgent) {
    const hasNoTurns = !lastAgent.num_turns || lastAgent.num_turns === 0;
    const hasNoCost = !lastAgent.cost_usd || lastAgent.cost_usd === 0;
    let hasNoLogOutput = false;
    try {
      const logPath = path.join(process.cwd(), 'data', 'agent-logs', `${lastAgent.id}.ndjson`);
      if (!existsSync(logPath)) {
        hasNoLogOutput = true;
      } else {
        const stat = statSync(logPath);
        hasNoLogOutput = stat.size === 0;
      }
    } catch {
      hasNoLogOutput = true;
    }

    if (hasNoTurns && hasNoCost && hasNoLogOutput) {
      console.log(`[workflow ${workflow.id}] job ${job.id.slice(0, 8)} failed before starting (infrastructure failure) — not counting as cycle`);
      logResilienceEvent('infrastructure_failure_no_cycle_increment', 'workflow', workflow.id, { job_id: job.id, agent_id: lastAgent.id, phase, cycle, reason: 'Agent had 0 turns, 0 cost, no log output' });
      spawnPhaseJob(queries.getWorkflowById(workflow.id)!, phase, cycle);
      return;
    }
  }

  const currentModel = job.model ?? workflow.implementer_model;
  const failureKind = classifyJobFailure(job.id);

  if (isFallbackEligibleFailure(failureKind)) {
    markModelRateLimited(currentModel, 5 * 60 * 1000);
    if (shouldMarkProviderUnavailable(failureKind)) {
      markProviderRateLimited(getModelProvider(currentModel), 5 * 60 * 1000);
    }
    const fallbackModel = getWorkflowFallbackModel(workflow, phase, currentModel);
    if (fallbackModel && fallbackModel !== currentModel) {
      const recoveryKey = RecoveryKeys.modelFallback(workflow.id, phase, cycle);
      const outcome = tryAcquireRecoverySlot(workflow.id, recoveryKey, `fallback=${fallbackModel},from=${currentModel},failure=${failureKind}`);
      if (outcome === 'active_duplicate') {
        console.log(`[workflow ${workflow.id}] phase '${phase}' model-fallback already spawned (idempotency key exists) — skipping duplicate`);
        return;
      }
      if (outcome === 'acquired') {
        console.log(`[workflow ${workflow.id}] phase '${job.workflow_phase}' failed on ${currentModel} (${failureKind}) → retrying with ${fallbackModel}`);
        spawnPhaseJob(workflow, phase, cycle, fallbackModel);
        return;
      }
      // outcome === 'stale_exhausted' — fall through to noFallbackReason below
      console.log(`[workflow ${workflow.id}] phase '${phase}' model-fallback recovery already failed (stale note, no active job) — blocking`);
    }
    const noFallbackReason = queries.getNote(RecoveryKeys.modelFallback(workflow.id, phase as string, cycle))
      ? `Phase '${job.workflow_phase}' job ${job.id.slice(0, 8)} failed (${failureKind}) — model-fallback recovery exhausted`
      : `Phase '${job.workflow_phase}' failed on ${currentModel} (${failureKind}) — no fallback model available`;
    console.log(`[workflow ${workflow.id}] ${noFallbackReason}`);
    updateAndEmit(workflow.id, { status: 'blocked', current_phase: job.workflow_phase ?? 'idle', blocked_reason: noFallbackReason });
    return;
  }
  if (isSameModelRetryEligible(failureKind)) {
    const attemptsKey = RecoveryKeys.cliAttempts(workflow.id, phase, cycle);
    const attempts = parseInt(queries.getNote(attemptsKey)?.value ?? '0', 10);
    const MAX_CLI_RETRIES = 3;
    if (attempts < MAX_CLI_RETRIES) {
      const cliRetryKey = RecoveryKeys.cliRetry(workflow.id, phase, cycle, attempts + 1);
      const outcome = tryAcquireRecoverySlot(workflow.id, cliRetryKey, `model=${currentModel},failure=${failureKind},attempt=${attempts + 1}`);
      if (outcome === 'active_duplicate') {
        console.log(`[workflow ${workflow.id}] phase '${phase}' cli-retry-${attempts + 1} already spawned (idempotency key exists) — skipping`);
        return;
      }
      if (outcome === 'acquired') {
        queries.upsertNote(attemptsKey, String(attempts + 1), null);
        console.log(`[workflow ${workflow.id}] phase '${phase}' hit ${failureKind} on ${currentModel} — same-model retry ${attempts + 1}/${MAX_CLI_RETRIES}`);
        spawnPhaseJob(workflow, phase, cycle);
        return;
      }
      // outcome === 'stale_exhausted' — fall through to alt-provider below
      console.log(`[workflow ${workflow.id}] phase '${phase}' cli-retry-${attempts + 1} recovery already failed (stale note, no active job) — trying next option`);
    }
    const altModel = getAlternateProviderModel(currentModel);
    if (altModel) {
      const altProviderKey = RecoveryKeys.altProvider(workflow.id, phase, cycle);
      const outcome = tryAcquireRecoverySlot(workflow.id, altProviderKey, `alt=${altModel},from=${currentModel},failure=${failureKind}`);
      if (outcome === 'active_duplicate') {
        console.log(`[workflow ${workflow.id}] phase '${phase}' alt-provider already spawned (idempotency key exists) — skipping`);
        return;
      }
      if (outcome === 'acquired') {
        console.log(`[workflow ${workflow.id}] phase '${phase}' exhausted ${MAX_CLI_RETRIES} retries on ${currentModel} (${failureKind}) → switching provider to ${altModel}`);
        spawnPhaseJob(workflow, phase, cycle, altModel);
        return;
      }
      // outcome === 'stale_exhausted' — fall through to final block below
      console.log(`[workflow ${workflow.id}] phase '${phase}' alt-provider recovery already failed (stale note, no active job) — will block`);
    }
    console.log(`[workflow ${workflow.id}] phase '${phase}' hit ${failureKind} on ${currentModel} — exhausted ${MAX_CLI_RETRIES} retries, no alternate provider available`);
  }

  const failReason = `Phase '${job.workflow_phase}' job ${job.id.slice(0, 8)} failed (${failureKind})`;
  console.log(`[workflow ${workflow.id}] ${failReason} — marking workflow blocked`);
  updateAndEmit(workflow.id, { status: 'blocked', current_phase: job.workflow_phase ?? 'idle', blocked_reason: failReason });
}

// ─── Implement Phase Completion ──────────────────────────────────────────────

function handleImplementCompleted(job: Job, workflow: Workflow, milestones: { total: number; done: number }): void {
  updateAndEmit(workflow.id, { milestones_total: milestones.total, milestones_done: milestones.done });
  const updated = queries.getWorkflowById(workflow.id)!;
  advanceAfterImplement(job, workflow, updated, milestones);
}

/**
 * Advance the workflow after a successful implement phase (or after verify passes).
 * Contains the completion-threshold / max-cycles / zero-progress logic.
 */
function advanceAfterImplement(job: Job, workflow: Workflow, updated: Workflow, milestones: { total: number; done: number }): void {
  if (milestones.total > 0 && meetsCompletionThreshold(milestones, updated.completion_threshold)) {
    // If verify command is configured, run verification before finalizing
    if (updated.start_command) {
      console.log(`[workflow ${workflow.id}] milestones meet completion threshold (${milestones.done}/${milestones.total}) — spawning verify agent before finalization`);
      spawnPhaseJob(updated, 'verify', updated.current_cycle);
      return;
    }
    console.log(`[workflow ${workflow.id}] milestones meet completion threshold (${milestones.done}/${milestones.total}, threshold ${updated.completion_threshold}) — marking complete`);
    updateAndEmit(workflow.id, { status: 'complete', current_phase: 'idle' as WorkflowPhase });
    finalizeWorkflow(queries.getWorkflowById(workflow.id)!).catch(err => console.error(`[workflow ${workflow.id}] finalizeWorkflow error:`, err));
  } else if (updated.current_cycle >= updated.max_cycles) {
    console.log(`[workflow ${workflow.id}] reached max cycles (${updated.max_cycles}) with ${milestones.done}/${milestones.total} milestones — marking blocked (not complete)`);
    updateAndEmit(workflow.id, { status: 'blocked', current_phase: 'idle' as WorkflowPhase, blocked_reason: `Reached max cycles (${updated.max_cycles}) with ${milestones.done}/${milestones.total} milestones complete` });
    if (milestones.done > 0) {
      const latestWf = queries.getWorkflowById(workflow.id)!;
      pushAndCreatePr(latestWf, true);
    }
  } else {
    handleZeroProgressAndAdvance(job, workflow, updated, milestones);
  }
}

function handleZeroProgressAndAdvance(job: Job, workflow: Workflow, updated: Workflow, milestones: { total: number; done: number }): void {
  const jobContext = job.context ? JSON.parse(job.context) : {};

  // If this cycle has failed verify runs, this implement was spawned to fix verify failures.
  // Skip zero-progress detection — just advance to the next cycle.
  const verifyRuns = queries.getVerifyRunsForCycle(workflow.id, updated.current_cycle);
  if (verifyRuns.some(r => r.exit_code !== 0)) {
    const nextCycle = updated.current_cycle + 1;
    updateAndEmit(workflow.id, { current_cycle: nextCycle });
    spawnPhaseJob(queries.getWorkflowById(workflow.id)!, 'review', nextCycle);
    return;
  }

  const preImplKey = RecoveryKeys.preImplementMilestones(workflow.id, updated.current_cycle);
  const preImplNote = queries.getNote(preImplKey);
  const zeroProgressKey = RecoveryKeys.zeroProgressCount(workflow.id);

  if (preImplNote) {
    const preImplDone = parseInt(preImplNote.value, 10);
    const delta = Math.max(0, milestones.done - preImplDone);

    const hasWorkEvidence = delta === 0 && milestones.done >= preImplDone
      ? detectCycleEvidence(job, updated, updated.current_cycle)
      : false;

    if (milestones.done >= preImplDone && !hasWorkEvidence) {
      queries.upsertNote(RecoveryKeys.cycleProgress(workflow.id, updated.current_cycle), String(delta), null);
    }

    if (delta > 0) {
      queries.upsertNote(zeroProgressKey, '0', null);
    } else if (hasWorkEvidence) {
      console.log(`[workflow ${workflow.id}] cycle ${updated.current_cycle} has work evidence (commits or worklog) but no milestone check-off — treating as reviewer rejection, not zero-progress`);
      queries.upsertNote(zeroProgressKey, '0', null);
    } else if (milestones.done >= preImplDone) {
      const replanKey = RecoveryKeys.replanAttempted(workflow.id, updated.current_cycle);
      const replanNote = queries.getNote(replanKey);
      if (!replanNote) {
        queries.upsertNote(replanKey, '1', null);
        console.log(`[workflow ${workflow.id}] zero progress on cycle ${updated.current_cycle} — spawning re-review for plan restructuring`);
        spawnPhaseJob(queries.getWorkflowById(workflow.id)!, 'review', updated.current_cycle);
        return;
      }

      const prevCount = parseInt(queries.getNote(zeroProgressKey)?.value ?? '0', 10);
      const newCount = prevCount + 1;
      const MAX_ZERO_PROGRESS = 2;
      if (newCount >= MAX_ZERO_PROGRESS) {
        const zpReason = `${newCount} consecutive implement cycles with no milestone progress (${milestones.done}/${milestones.total} complete)`;
        console.log(`[workflow ${workflow.id}] ${zpReason} — marking blocked`);
        updateAndEmit(workflow.id, { status: 'blocked', current_phase: 'implement' as WorkflowPhase, blocked_reason: zpReason });
        return;
      }
      queries.upsertNote(zeroProgressKey, String(newCount), null);
      console.log(`[workflow ${workflow.id}] zero-progress implement cycle ${newCount}/${MAX_ZERO_PROGRESS} (${milestones.done}/${milestones.total})`);
    }

    // Diminishing returns detector
    const cycle = updated.current_cycle;
    if (cycle >= 3) {
      const cp1 = queries.getNote(RecoveryKeys.cycleProgress(workflow.id, cycle));
      const cp2 = queries.getNote(RecoveryKeys.cycleProgress(workflow.id, cycle - 1));
      const cp3 = queries.getNote(RecoveryKeys.cycleProgress(workflow.id, cycle - 2));
      if (cp1 && cp2 && cp3) {
        const avg = (parseFloat(cp1.value) + parseFloat(cp2.value) + parseFloat(cp3.value)) / 3;
        if (avg < 0.3) {
          const freshWf = queries.getWorkflowById(workflow.id)!;
          if (freshWf.status !== 'blocked') {
            const drReason = `Diminishing returns: average ${avg.toFixed(2)} milestones/cycle over last 3 cycles (${milestones.done}/${milestones.total} complete)`;
            console.log(`[workflow ${workflow.id}] ${drReason} — marking blocked`);
            updateAndEmit(workflow.id, { status: 'blocked', current_phase: 'implement' as WorkflowPhase, blocked_reason: drReason });
            return;
          }
        }
      }
    }
  }

  if (jobContext.is_repair) {
    spawnPhaseJob(queries.getWorkflowById(workflow.id)!, 'review', updated.current_cycle);
    return;
  }

  const nextCycle = updated.current_cycle + 1;
  updateAndEmit(workflow.id, { current_cycle: nextCycle });
  spawnPhaseJob(queries.getWorkflowById(workflow.id)!, 'review', nextCycle);
}

// ─── Cycle Evidence Detection ─────────────────────────────────────────────────

function detectCycleEvidence(job: Job, workflow: Workflow, cycleNum: number): boolean {
  const agents = queries.getAgentsWithJobByJobId(job.id);
  const newestAgent = agents[0];
  const gitDir = workflow.worktree_path ?? workflow.work_dir;

  if (newestAgent?.base_sha && gitDir && existsSync(gitDir)) {
    try {
      const countStr = execSync(
        `git rev-list ${JSON.stringify(newestAgent.base_sha)}..HEAD --count`,
        { cwd: gitDir, stdio: 'pipe', timeout: 5000 },
      ).toString().trim();
      if (parseInt(countStr, 10) > 0) {
        console.log(`[workflow ${workflow.id}] cycle ${cycleNum} evidence: ${countStr} commit(s) found since ${newestAgent.base_sha.slice(0, 8)}`);
        return true;
      }
    } catch { /* git error — fall through */ }
  }

  const worklogNote = queries.getNote(RecoveryKeys.worklog(workflow.id, cycleNum));
  if (worklogNote && isSubstantiveWorklog(worklogNote.value)) {
    console.log(`[workflow ${workflow.id}] cycle ${cycleNum} evidence: substantive worklog entry found`);
    return true;
  }

  return false;
}

const WORKLOG_METADATA_LABEL = /^\*\*(Owner|Timestamp):\*\*/;

function isSubstantiveWorklog(content: string): boolean {
  if (!content.trim()) return false;
  return content.split('\n').some(l => {
    const t = l.trim();
    return t.length > 0 && !t.startsWith('#') && !WORKLOG_METADATA_LABEL.test(t);
  });
}

// ─── Phase Job Spawning ─────────────────────────────────────────────────────

function repairAttemptsKey(workflowId: string, phase: 'assess' | 'review', cycle: number): string {
  return RecoveryKeys.repairAttempts(workflowId, phase, cycle);
}

const REPAIR_LEVELS = [
  { label: 'quick repair', turnsMultiplier: 1.0 },
  { label: 'diagnostic repair', turnsMultiplier: 1.5 },
  { label: 'full re-assess repair', turnsMultiplier: 2.0 },
] as const;
const MAX_REPAIR_ATTEMPTS = REPAIR_LEVELS.length;

function spawnRepairJob(workflow: Workflow, phase: 'assess' | 'review', cycle: number, missingArtifacts: string[], diagnosticContext?: string): boolean {
  const attemptsKey = repairAttemptsKey(workflow.id, phase, cycle);
  const existingAttempts = parseInt(queries.getNote(attemptsKey)?.value ?? '0', 10);
  if (existingAttempts >= MAX_REPAIR_ATTEMPTS) return false;

  const level = REPAIR_LEVELS[existingAttempts];
  queries.upsertNote(attemptsKey, String(existingAttempts + 1), null);
  let model = phase === 'review' ? workflow.reviewer_model : workflow.implementer_model;
  if (isCodexModel(model)) {
    console.log(`[workflow ${workflow.id}] repair job requires reliable MCP — falling back from Codex to Claude`);
    model = 'claude-sonnet-4-6';
  }
  if (phase === 'assess' && existingAttempts >= 1) {
    console.log(`[workflow ${workflow.id}] assess repair attempt ${existingAttempts + 1} — escalating to claude-opus-4-6 for reliable MCP`);
    model = 'claude-opus-4-6';
  }
  const stopMode = phase === 'review' ? workflow.stop_mode_review : workflow.stop_mode_assess;
  const stopValue = phase === 'review' ? workflow.stop_value_review : workflow.stop_value_assess;
  const baseTurns = effectiveMaxTurns(stopMode, stopValue);
  const maxTurns = Math.ceil(baseTurns * level.turnsMultiplier);
  const useSimplifiedPrompt = phase === 'assess' && existingAttempts >= 2
    && missingArtifacts.length === 1 && missingArtifacts[0] === 'plan';
  const prompt = useSimplifiedPrompt
    ? buildSimplifiedAssessRepairPrompt(workflow, missingArtifacts, diagnosticContext)
    : buildWorkflowRepairPrompt(workflow, phase, cycle, missingArtifacts, diagnosticContext);
  const job = queries.insertJob({
    id: randomUUID(),
    title: `[Workflow C${cycle}] ${phase.charAt(0).toUpperCase() + phase.slice(1)} ${level.label}`,
    description: prompt,
    context: JSON.stringify({ is_repair: true }),
    priority: 0, model, template_id: workflow.template_id,
    work_dir: workflow.worktree_path ?? workflow.work_dir,
    max_turns: maxTurns, stop_mode: stopMode, stop_value: stopValue,
    project_id: workflow.project_id, use_worktree: 0,
    workflow_id: workflow.id, workflow_cycle: cycle, workflow_phase: phase,
  });

  try { socket.emitJobNew(job); } catch (emitErr) { console.warn(`[workflow ${workflow.id}] socket.emitJobNew failed for repair job ${job.id.slice(0, 8)}:`, emitErr); }
  nudgeQueue();
  updateAndEmit(workflow.id, { current_phase: phase, current_cycle: cycle, status: 'running' });
  console.log(`[workflow ${workflow.id}] spawned ${phase} ${level.label} (${existingAttempts + 1}/${MAX_REPAIR_ATTEMPTS}, ${maxTurns} turns) for missing ${missingArtifacts.join(', ')}`);
  return true;
}

export function preReadWorkflowContext(workflowId: string, opts: { cycle?: number } = {}): InlineWorkflowContext {
  const plan = queries.getNote(RecoveryKeys.plan(workflowId));
  const contract = queries.getNote(RecoveryKeys.contract(workflowId));
  const worklogNotes = queries.listNotes(RecoveryKeys.worklogPrefix(workflowId));
  const recentDiff = queries.getLastImplementDiff(workflowId);

  let diffSummary: string | undefined;
  const workflow = queries.getWorkflowById(workflowId);
  if (workflow?.worktree_path && existsSync(workflow.worktree_path)) {
    try {
      const stat = execSync('git diff --stat $(git merge-base HEAD main) HEAD 2>/dev/null', {
        cwd: workflow.worktree_path, timeout: 5000,
      }).toString().trim();
      if (stat) diffSummary = stat;
    } catch { /* skip */ }
  }

  const reviewFeedbackNotes = queries.listNotes(RecoveryKeys.reviewFeedbackPrefix(workflowId));
  const reviewHistory = reviewFeedbackNotes.length > 0
    ? reviewFeedbackNotes.map(n => `**${n.key.split('/').pop()}:**\n${n.value}`).join('\n\n')
    : undefined;

  // Load the latest failed verify run for this cycle (if we know the cycle)
  let verifyFailure: InlineWorkflowContext['verifyFailure'] = null;
  const cycle = opts.cycle ?? workflow?.current_cycle;
  if (cycle !== undefined && cycle > 0) {
    const failureNote = queries.getNote(RecoveryKeys.verifyFailure(workflowId, cycle));
    if (failureNote?.value) {
      verifyFailure = failureNote.value;
    }
  }

  return {
    plan: plan?.value ?? undefined,
    contract: contract?.value ?? undefined,
    worklogs: worklogNotes.map(n => ({ key: n.key, value: n.value })),
    recentDiff: recentDiff ?? undefined,
    diffSummary,
    reviewHistory,
    verifyFailure,
  };
}

function blockIfMissingRequiredWorktree(workflow: Workflow, phase: WorkflowPhase, opts: { throwOnBlock?: boolean } = {}): boolean {
  const missing = getMissingRequiredWorktreeFields(workflow);
  if (workflow.use_worktree && missing.length > 0) {
    const subject = missing.join(' and ');
    const verb = missing.length === 1 ? 'is' : 'are';
    const reason = `Worktree required (use_worktree=1) but ${subject} ${verb} null — cannot spawn ${phase} job`;
    console.log(`[workflow ${workflow.id}] ${reason} — marking blocked`);
    updateAndEmit(workflow.id, { status: 'blocked', current_phase: phase, blocked_reason: reason });
    if (opts.throwOnBlock) throw new Error(reason);
    return true;
  }
  return false;
}

function getMissingRequiredWorktreeFields(workflow: Workflow): string[] {
  const missing: string[] = [];
  if (!workflow.worktree_path) missing.push('worktree_path');
  if (!workflow.worktree_branch) missing.push('worktree_branch');
  return missing;
}

function getExpectedWorkflowWorktree(workflow: Workflow): { worktree_path: string; worktree_branch: string } | null {
  if (!workflow.work_dir) return null;
  const shortId = workflow.id.slice(0, 8);
  const slug = workflow.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  const worktree_branch = `workflow/${slug}-${shortId}`;
  const repoName = path.basename(workflow.work_dir);
  const worktree_path = path.resolve(workflow.work_dir, '..', '.orchestrator-worktrees', repoName, `wf-${shortId}`);
  return { worktree_path, worktree_branch };
}

function blockForWorktreeRepairFailure(
  workflow: Workflow,
  phase: WorkflowPhase,
  reason: string,
  opts: { throwOnBlock?: boolean } = {},
): null {
  console.log(`[workflow ${workflow.id}] ${reason} — marking blocked`);
  updateAndEmit(workflow.id, { status: 'blocked', current_phase: phase, blocked_reason: reason });
  if (opts.throwOnBlock) throw new Error(reason);
  return null;
}

function ensureWorkflowWorktreeReadyForPhase(
  workflow: Workflow,
  phase: WorkflowPhase,
  opts: { throwOnBlock?: boolean } = {},
): Workflow | null {
  if (!workflow.use_worktree) return workflow;

  let activeWorkflow = workflow;
  const missingBefore = getMissingRequiredWorktreeFields(activeWorkflow);
  if (missingBefore.length === 0) return activeWorkflow;

  const expected = getExpectedWorkflowWorktree(activeWorkflow);
  if (!expected || !activeWorkflow.work_dir) {
    return blockForWorktreeRepairFailure(
      activeWorkflow,
      phase,
      `Worktree metadata repair failed before ${phase}: missing ${missingBefore.join(' and ')} and work_dir is unavailable`,
      opts,
    );
  }

  console.warn(
    `[workflow ${workflow.id}] missing ${missingBefore.join(' and ')} before ${phase} — rehydrating worktree metadata`,
  );
  activeWorkflow = queries.updateWorkflow(activeWorkflow.id, {
    worktree_path: activeWorkflow.worktree_path ?? expected.worktree_path,
    worktree_branch: activeWorkflow.worktree_branch ?? expected.worktree_branch,
  }) ?? activeWorkflow;
  activeWorkflow = queries.getWorkflowById(activeWorkflow.id) ?? activeWorkflow;

  const hydratedMissing = getMissingRequiredWorktreeFields(activeWorkflow);
  if (hydratedMissing.length > 0) {
    return blockForWorktreeRepairFailure(
      activeWorkflow,
      phase,
      `Worktree metadata repair failed before ${phase}: missing ${hydratedMissing.join(' and ')} after rehydration`,
      opts,
    );
  }

  let healthCheck = verifyWorktreeHealth(activeWorkflow.worktree_path!, activeWorkflow.worktree_branch!, activeWorkflow.work_dir);
  if (!healthCheck.ok) {
    console.warn(
      `[workflow ${workflow.id}] worktree health check failed after metadata rehydration — attempting restore: ${healthCheck.error}`,
    );
    try {
      restoreWorkflowWorktree(activeWorkflow);
    } catch (err) {
      return blockForWorktreeRepairFailure(
        activeWorkflow,
        phase,
        `Worktree metadata repair failed before ${phase}: ${errMsg(err)}`,
        opts,
      );
    }

    activeWorkflow = queries.getWorkflowById(activeWorkflow.id) ?? activeWorkflow;
    const missingAfterRestore = getMissingRequiredWorktreeFields(activeWorkflow);
    if (missingAfterRestore.length > 0) {
      return blockForWorktreeRepairFailure(
        activeWorkflow,
        phase,
        `Worktree metadata repair failed before ${phase}: missing ${missingAfterRestore.join(' and ')} after restore`,
        opts,
      );
    }

    healthCheck = verifyWorktreeHealth(activeWorkflow.worktree_path!, activeWorkflow.worktree_branch!, activeWorkflow.work_dir);
    if (!healthCheck.ok) {
      return blockForWorktreeRepairFailure(
        activeWorkflow,
        phase,
        `Worktree metadata repair failed before ${phase}: ${healthCheck.error}`,
        opts,
      );
    }
  }

  return activeWorkflow;
}

function spawnPhaseJob(workflow: Workflow, phase: WorkflowPhase, cycle: number, modelOverride?: string): void {
  const activeWorkflow = ensureWorkflowWorktreeReadyForPhase(workflow, phase);
  if (!activeWorkflow) return;

  const phaseLabels: Record<string, string> = { assess: 'Assess', review: 'Review', implement: 'Implement', verify: 'Verify' };
  const label = phaseLabels[phase] ?? phase;

  const inlineContext = (phase === 'review' || phase === 'implement' || phase === 'verify')
    ? preReadWorkflowContext(activeWorkflow.id, { cycle }) : undefined;

  const phaseConfig = getPhaseConfig(phase);
  let model = phaseConfig.overrides?.model ?? (phaseConfig.modelKey ? (activeWorkflow[phaseConfig.modelKey] as string) : 'claude-sonnet-4-6');
  let stopMode = (phaseConfig.overrides?.stopMode ?? (phaseConfig.stopModeKey ? activeWorkflow[phaseConfig.stopModeKey] : 'turns')) as StopMode;
  let stopValue = (phaseConfig.overrides?.stopValue ?? (phaseConfig.stopValueKey ? activeWorkflow[phaseConfig.stopValueKey] : null)) as number | null;
  const prompt = phaseConfig.buildPrompt(activeWorkflow, cycle, inlineContext);

  // Apply post-resolution hook (e.g. assess phase falls back from Codex to Claude)
  model = phaseConfig.postResolve?.(model) ?? model;

  if (modelOverride) model = modelOverride;
  model = getWorkflowFallbackModel(activeWorkflow, phase, model) ?? model;

  if (activeWorkflow.worktree_path && activeWorkflow.worktree_branch) {
    const branchCheck = ensureWorktreeBranch(activeWorkflow.worktree_path, activeWorkflow.worktree_branch);
    if (!branchCheck.ok) {
      const reason = `Worktree branch verification failed before ${phase}: ${branchCheck.error}`;
      console.log(`[workflow ${activeWorkflow.id}] ${reason} — marking blocked`);
      updateAndEmit(activeWorkflow.id, { status: 'blocked', current_phase: phase, blocked_reason: reason });
      return;
    }
  }

  if (phase === 'implement') {
    const planNote = queries.getNote(RecoveryKeys.plan(activeWorkflow.id));
    const milestones = parseMilestones(planNote?.value ?? '');
    queries.upsertNote(RecoveryKeys.preImplementMilestones(activeWorkflow.id, cycle), String(milestones.done), null);
    if (planNote?.value) {
      const firstUnchecked = planNote.value.split('\n').find(l => /^- \[ \]/.test(l));
      if (firstUnchecked) {
        const pathMatches = firstUnchecked.match(/(?:^|[\s`"'(])([a-zA-Z0-9_./-]+\.\w{1,5})(?=[\s`"'),]|$)/g);
        if (pathMatches) {
          const filePaths = pathMatches.map(m => m.trim().replace(/^[`"'(]/, ''));
          const conflicts = queries.claimFiles(activeWorkflow.id, filePaths);
          if (conflicts.length > 0) {
            console.warn(`[workflow ${activeWorkflow.id}] file claim conflicts: ${conflicts.map(c => `${c.file_path} (held by ${c.workflow_id})`).join(', ')}`);
          }
        }
      }
    }
  }

  const job = queries.insertJob({
    id: randomUUID(),
    title: `[Workflow C${cycle}] ${label}${modelOverride ? ' (fallback)' : ''}`,
    description: prompt, context: null, priority: 0, model,
    template_id: activeWorkflow.template_id,
    work_dir: activeWorkflow.worktree_path ?? activeWorkflow.work_dir,
    max_turns: effectiveMaxTurns(stopMode, stopValue),
    stop_mode: stopMode, stop_value: stopValue,
    project_id: activeWorkflow.project_id, use_worktree: 0,
    workflow_id: activeWorkflow.id, workflow_cycle: cycle, workflow_phase: phase,
  });

  try { socket.emitJobNew(job); } catch (emitErr) { console.warn(`[workflow ${activeWorkflow.id}] socket.emitJobNew failed for job ${job.id.slice(0, 8)}:`, emitErr); }
  nudgeQueue();
  updateAndEmit(activeWorkflow.id, { current_phase: phase, current_cycle: cycle });
  console.log(`[workflow ${activeWorkflow.id}] spawned ${phase} job ${job.id.slice(0, 8)} (cycle ${cycle}, model: ${model})`);
}

function getWorkflowFallbackModel(workflow: Workflow, phase: WorkflowPhase, currentModel: string): string | null {
  if (getAvailableModel(currentModel) === currentModel) return null;
  const candidates = new Set<string>();
  const directFallback = getFallbackModel(currentModel);
  if (directFallback && directFallback !== currentModel) candidates.add(directFallback);
  if (phase === 'review') candidates.add(workflow.reviewer_model);
  candidates.add(workflow.implementer_model);
  candidates.add('claude-sonnet-4-6[1m]');
  candidates.add('claude-opus-4-7[1m]');
  candidates.add('claude-opus-4-6[1m]');
  candidates.add('claude-haiku-4-5-20251001');
  candidates.add('codex');
  for (const candidate of candidates) {
    if (!candidate || candidate === currentModel) continue;
    const available = getAvailableModel(candidate);
    if (available && available !== currentModel) return available;
  }
  return null;
}

export function reconcileRunningWorkflows(): void {
  const ACTIVE = new Set(['queued', 'assigned', 'running']);
  const now = Date.now();
  pruneReconciledJobIds(now);
  for (const workflow of queries.listWorkflows()) {
    if (workflow.status !== 'running') continue;

    if (workflow.worktree_path && workflow.worktree_branch) {
      const healthCheck = verifyWorktreeHealth(workflow.worktree_path, workflow.worktree_branch, workflow.work_dir);
      if (!healthCheck.ok) {
        const reason = `Startup worktree health check failed: ${healthCheck.error}`;
        console.warn(`[workflow ${workflow.id}] ${reason} — marking blocked`);
        logResilienceEvent('worktree_startup_check', 'workflow', workflow.id, {
          worktree_path: workflow.worktree_path, branch: workflow.worktree_branch, error: healthCheck.error, outcome: 'blocked',
        });
        updateAndEmit(workflow.id, { status: 'blocked', blocked_reason: reason });
        continue;
      }
    }

    const jobs = queries.getJobsForWorkflow(workflow.id);
    const hasActiveJob = jobs.some(job => ACTIVE.has(job.status));
    if (hasActiveJob) continue;

    // Verify is now a job-based phase — the generic reconciliation below handles it

    if (workflow.current_phase === 'idle') {
      updateAndEmit(workflow.id, { status: 'blocked', blocked_reason: 'Workflow marked running but no active phase job exists' });
      continue;
    }

    const expectedCycle = workflow.current_phase === 'assess' ? 0 : workflow.current_cycle;
    const latestPhaseJob = jobs
      .filter(job => job.workflow_phase === workflow.current_phase && job.workflow_cycle === expectedCycle)
      .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];

    if (!latestPhaseJob) {
      updateAndEmit(workflow.id, { status: 'blocked', blocked_reason: `Workflow stuck in ${workflow.current_phase} with no phase job to resume` });
      continue;
    }

    if (latestPhaseJob.status === 'done' || latestPhaseJob.status === 'failed' || latestPhaseJob.status === 'cancelled') {
      const lastReconciledAt = _reconciledJobIds.get(latestPhaseJob.id);
      if (lastReconciledAt !== undefined && now - lastReconciledAt < RECONCILED_JOB_WINDOW_MS) {
        continue;
      }
      _reconciledJobIds.set(latestPhaseJob.id, now);

      const before = queries.getWorkflowById(workflow.id);
      onJobCompleted(latestPhaseJob, { force: true });
      const after = queries.getWorkflowById(workflow.id);
      const progressed = !!after && (
        after.status !== 'running' || after.current_phase !== before?.current_phase
        || after.current_cycle !== before?.current_cycle
        || queries.getJobsForWorkflow(workflow.id).some(job => ACTIVE.has(job.status))
      );
      if (progressed) {
        console.log(`[workflow-gap] recovered workflow ${workflow.id.slice(0, 8)}: ${before?.current_phase}/${before?.current_cycle} → ${after!.current_phase}/${after!.current_cycle}`);
        logResilienceEvent('gap_detector_recovery', 'workflow', workflow.id, {
          from_phase: before?.current_phase, from_cycle: before?.current_cycle,
          to_phase: after!.current_phase, to_cycle: after!.current_cycle,
          to_status: after!.status, trigger_job_id: latestPhaseJob.id, trigger_job_status: latestPhaseJob.status,
        });
      } else {
        let blockedReason: string;
        if (latestPhaseJob.status === 'failed') {
          const kind = classifyJobFailure(latestPhaseJob.id);
          blockedReason = `Workflow stuck: Phase '${workflow.current_phase}' job ${latestPhaseJob.id.slice(0, 8)} failed (${kind})`;
        } else {
          blockedReason = `Workflow stuck after ${latestPhaseJob.status} ${workflow.current_phase} job ${latestPhaseJob.id.slice(0, 8)}`;
        }
        updateAndEmit(workflow.id, { status: 'blocked', blocked_reason: blockedReason });
      }
    }
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function startWorkflow(workflow: Workflow): Job | null {
  if (workflow.work_dir) {
    if (!existsSync(workflow.work_dir)) {
      const reason = `Pre-flight failed: work_dir does not exist: ${workflow.work_dir}`;
      console.warn(`[workflow ${workflow.id}] ${reason}`);
      updateAndEmit(workflow.id, { status: 'blocked', blocked_reason: reason });
      return null;
    }
    try {
      execSync('git status --porcelain', { cwd: workflow.work_dir, timeout: 5000, stdio: 'pipe' });
    } catch (err) {
      const reason = `Pre-flight failed: git is not functional in ${workflow.work_dir}: ${errMsg(err)}`;
      console.warn(`[workflow ${workflow.id}] ${reason}`);
      updateAndEmit(workflow.id, { status: 'blocked', blocked_reason: reason });
      return null;
    }
  }

  let activeWorkflow = workflow;
  if (workflow.use_worktree && workflow.work_dir) {
    const result = createWorkflowWorktree(workflow, updateAndEmit);
    if (!result) return null;
    activeWorkflow = result;
  }

  const prompt = buildAssessPrompt(activeWorkflow);
  let assessModel = activeWorkflow.implementer_model;
  if (isCodexModel(assessModel)) {
    console.log(`[workflow ${activeWorkflow.id}] assess phase requires reliable MCP — falling back from Codex to Claude`);
    assessModel = 'claude-sonnet-4-6';
  }
  assessModel = getWorkflowFallbackModel(activeWorkflow, 'assess', assessModel) ?? assessModel;
  const job = queries.insertJob({
    id: randomUUID(), title: `[Workflow C0] Assess`, description: prompt,
    context: null, priority: 0, model: assessModel,
    template_id: activeWorkflow.template_id,
    work_dir: activeWorkflow.worktree_path ?? activeWorkflow.work_dir,
    max_turns: effectiveMaxTurns(activeWorkflow.stop_mode_assess, activeWorkflow.stop_value_assess),
    stop_mode: activeWorkflow.stop_mode_assess, stop_value: activeWorkflow.stop_value_assess,
    project_id: activeWorkflow.project_id, use_worktree: 0,
    workflow_id: activeWorkflow.id, workflow_cycle: 0, workflow_phase: 'assess',
  });

  try { socket.emitJobNew(job); } catch (emitErr) { console.warn(`[workflow ${activeWorkflow.id}] socket.emitJobNew failed for job ${job.id.slice(0, 8)}:`, emitErr); }
  nudgeQueue();
  updateAndEmit(activeWorkflow.id, { current_phase: 'assess' as WorkflowPhase, current_cycle: 0 });
  console.log(`[workflow ${activeWorkflow.id}] started — assess job ${job.id.slice(0, 8)}`);
  return job;
}

export function resumeWorkflow(workflow: Workflow, options: { phase?: WorkflowPhase; cycle?: number } = {}): Job {
  if (workflow.status !== 'blocked') throw new Error(`Cannot resume workflow in status '${workflow.status}'`);
  const current = queries.getWorkflowById(workflow.id)!;

  if (current.worktree_path && current.worktree_branch) {
    const healthCheck = verifyWorktreeHealth(current.worktree_path, current.worktree_branch, current.work_dir);
    if (!healthCheck.ok) throw new Error(`Worktree health check failed before resuming: ${healthCheck.error}`);
  }

  // Lighter rehydration: if worktree_path exists on disk but worktree_branch is missing,
  // just rehydrate the branch metadata without recreating the entire worktree.
  // IMPORTANT: Verify the directory is actually a valid git worktree, not just any directory.
  if (current.use_worktree && current.worktree_path && !current.worktree_branch && existsSync(current.worktree_path)) {
    let isValidWorktree = false;
    try {
      execFileSync('git', ['-C', current.worktree_path, 'rev-parse', '--is-inside-work-tree'], { stdio: 'pipe', timeout: 5000 });
      isValidWorktree = true;
    } catch {
      console.log(`[workflow ${current.id}] worktree_path exists but is not a valid git worktree -- restoring`);
    }
    if (isValidWorktree) {
      const expected = getExpectedWorkflowWorktree(current);
      if (expected) {
        queries.updateWorkflow(current.id, { worktree_branch: expected.worktree_branch });
        console.log(`[workflow ${current.id}] rehydrated worktree branch ${expected.worktree_branch} for existing worktree`);
      }
    } else if (current.work_dir) {
      restoreWorkflowWorktree(current);
    }
  } else if (current.use_worktree && getMissingRequiredWorktreeFields(current).length > 0 && current.work_dir) {
    restoreWorkflowWorktree(current);
  }

  const resumeState = queries.getWorkflowById(workflow.id)!;
  const phase = options.phase ?? (resumeState.current_phase === 'idle' ? 'assess' : resumeState.current_phase);
  const cycle = options.cycle ?? resumeState.current_cycle;

  blockIfMissingRequiredWorktree(resumeState, phase, { throwOnBlock: true });
  updateAndEmit(workflow.id, { status: 'running', blocked_reason: null });
  queries.upsertNote(RecoveryKeys.zeroProgressCount(workflow.id), '0', null);
  for (let c = current.current_cycle; c >= 1 && c > current.current_cycle - 3; c--) {
    queries.deleteNote(RecoveryKeys.cycleProgress(workflow.id, c));
    queries.deleteNote(RecoveryKeys.replanAttempted(workflow.id, c));
  }

  if (options.phase || options.cycle) {
    updateAndEmit(workflow.id, { current_phase: phase, current_cycle: cycle });
    console.log(`[workflow ${workflow.id}] partial recovery: resuming from ${phase} cycle ${cycle}`);
  }

  const updated = queries.getWorkflowById(workflow.id)!;

  const inlineContext = (phase === 'review' || phase === 'implement' || phase === 'verify')
    ? preReadWorkflowContext(updated.id, { cycle }) : undefined;

  const phaseConfig = getPhaseConfig(phase);
  let model = phaseConfig.overrides?.model ?? (phaseConfig.modelKey ? (updated[phaseConfig.modelKey] as string) : 'claude-sonnet-4-6');
  const stopMode = (phaseConfig.overrides?.stopMode ?? (phaseConfig.stopModeKey ? updated[phaseConfig.stopModeKey] : 'turns')) as StopMode;
  const stopValue = (phaseConfig.overrides?.stopValue ?? (phaseConfig.stopValueKey ? updated[phaseConfig.stopValueKey] : null)) as number | null;
  const prompt = phaseConfig.buildPrompt(updated, cycle, inlineContext);

  // Apply post-resolution hook (e.g. assess phase falls back from Codex to Claude)
  model = phaseConfig.postResolve?.(model) ?? model;

  model = getWorkflowFallbackModel(updated, phase as WorkflowPhase, model) ?? model;
  const job = queries.insertJob({
    id: randomUUID(),
    title: `[Workflow C${cycle}] ${phase.charAt(0).toUpperCase() + phase.slice(1)} (resumed)`,
    description: prompt, context: null, priority: 0, model,
    template_id: updated.template_id,
    work_dir: updated.worktree_path ?? updated.work_dir,
    max_turns: effectiveMaxTurns(stopMode, stopValue),
    stop_mode: stopMode, stop_value: stopValue,
    project_id: updated.project_id, use_worktree: 0,
    workflow_id: updated.id, workflow_cycle: cycle, workflow_phase: phase as WorkflowPhase,
  });

  try { socket.emitJobNew(job); } catch (emitErr) { console.warn(`[workflow ${workflow.id}] socket.emitJobNew failed for job ${job.id.slice(0, 8)}:`, emitErr); }
  nudgeQueue();
  console.log(`[workflow ${workflow.id}] resumed — ${phase} job ${job.id.slice(0, 8)} (cycle ${cycle})`);
  return job;
}

// ─── Wrappers for sub-modules that need updateAndEmit ─────────────────────

export function pushAndCreatePr(workflow: Workflow, isDraft: boolean): string | null {
  return _pushAndCreatePr(workflow, isDraft, updateAndEmit);
}

export async function finalizeWorkflow(workflow: Workflow): Promise<void> {
  return _finalizeWorkflow(workflow, updateAndEmit);
}

export async function reconcileBlockedPRs(): Promise<void> {
  return _reconcileBlockedPRs(updateAndEmit);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function _resetForTest(): void {
  _processedJobs.clear();
  _reconciledJobIds.clear();
}

// Test-only export so unit tests can verify classification of nested/prefixed
// blocked_reason strings without needing a full workflow harness.
export const _isOperationalBlockedReasonForTest = isOperationalBlockedReason;

const OPERATIONAL_BLOCK_SUBSTRINGS = [
  'Reached max cycles', 'no milestone progress', 'Diminishing returns',
  'PR creation failed', 'Draft PR creation failed', 'was cancelled',
  'no fallback model available',
  'verify_failed',
] as const;

const OPERATIONAL_FAILED_KINDS = new Set([
  'timeout', 'mcp_disconnect', 'out_of_memory', 'disk_full', 'context_overflow', 'codex_cli_crash',
  'launch_environment', 'rate_limit', 'provider_overload',
]);

function isOperationalBlockedReason(reason: string): boolean {
  if (OPERATIONAL_BLOCK_SUBSTRINGS.some(pattern => reason.includes(pattern))) return true;
  // Match `Phase 'X' job <sha> failed (<kind>)` anywhere in the reason, not
  // just at the start. Nested/cascaded reasons (e.g. a Sentry-fix workflow
  // that failed because its target had an operational failure) prefix this
  // pattern with strings like `WorkflowBlocked: Workflow blocked: Sentry fix
  // [repo]: BrokenPipeErr — ` which previously defeated the `^...$`-anchored
  // match and caused the outer Sentry-fix workflow to be captured — spawning
  // ANOTHER Sentry-fix workflow in a cascade (see HURLICANE-5J, -9E). If any
  // `Phase ... failed (kind)` fragment in the reason is operational, treat
  // the whole reason as operational.
  const failedMatch = reason.match(/Phase '[^']+' job [0-9a-f]{8} failed \(([^)]+)\)/);
  if (!failedMatch) return false;
  return OPERATIONAL_FAILED_KINDS.has(failedMatch[1]);
}

function updateAndEmit(id: string, fields: Parameters<typeof queries.updateWorkflow>[1]): void {
  let previousStatus: string | undefined;
  if (fields.status) {
    const current = queries.getWorkflowById(id);
    previousStatus = current?.status;
    try {
      validateTransition('workflow', previousStatus, fields.status, id);
    } catch (err) {
      console.warn((err as Error).message);
    }
  }
  const updated = queries.updateWorkflow(id, fields);
  if (!updated) {
    console.warn(`[workflow] updateAndEmit: workflow ${id} not found — DB update returned null`);
    return;
  }
  try { socket.emitWorkflowUpdate(updated); } catch (emitErr) {
    console.warn(`[workflow] updateAndEmit: socket.emitWorkflowUpdate failed for workflow ${id}:`, emitErr);
  }
  if (fields.status === 'blocked' && previousStatus !== 'blocked') {
    const reason = fields.blocked_reason ?? updated.blocked_reason ?? 'unknown';
    const isOperational = isOperationalBlockedReason(reason);
    if (!isOperational) {
      const err = new Error(`Workflow blocked: ${updated.title} — ${reason}`);
      err.name = 'WorkflowBlocked';
      const wfJobs = queries.getJobsForWorkflow(updated.id);
      const lastFailed = [...wfJobs].reverse().find((j: Job) => j.status === 'failed');
      let lastFailedError = '';
      let lastFailedAgentId = '';
      if (lastFailed) {
        const failedAgents = queries.getAgentsWithJobByJobId(lastFailed.id);
        const failedAgent = failedAgents[0];
        lastFailedError = failedAgent?.error_message ?? '';
        lastFailedAgentId = failedAgent?.id ?? '';
      }
      Sentry.captureException(err, {
        tags: { component: 'WorkflowManager', workflow_id: updated.id },
        extra: {
          title: updated.title, blocked_reason: reason, phase: updated.current_phase,
          cycle: updated.current_cycle, max_cycles: updated.max_cycles,
          milestones: `${updated.milestones_done}/${updated.milestones_total}`,
          implementer_model: updated.implementer_model, reviewer_model: updated.reviewer_model,
          worktree_branch: updated.worktree_branch ?? 'none',
          last_failed_job: lastFailed ? `${lastFailed.title} (${lastFailed.id.slice(0, 8)})` : 'none',
          last_failed_agent: lastFailedAgentId ? lastFailedAgentId.slice(0, 8) : 'none',
          last_failed_error: lastFailedError.slice(0, 500) || 'no error recorded',
          total_jobs: wfJobs.length, failed_jobs: wfJobs.filter((j: Job) => j.status === 'failed').length,
        },
      });
    }
    try { writeBlockedDiagnostic(updated); } catch { /* best effort */ }
  }
}
