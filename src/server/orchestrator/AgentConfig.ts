/**
 * AgentConfig — shared constants and types used by both AgentRunner and PtyManager.
 *
 * Extracted to break the circular dependency between those two modules.
 * AgentRunner re-exports everything here for backward compatibility.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as queries from '../db/queries.js';
import type { Job } from '../../shared/types.js';

// ── Binary paths ──────────────────────────────────────────────────────────────
export const CLAUDE = process.env.CLAUDE_BIN ?? 'claude';
export const CODEX = process.env.CODEX_BIN ?? 'codex';

// ── Network / paths ───────────────────────────────────────────────────────────
export const MCP_PORT = process.env.MCP_PORT ?? '3947';
export const LOGS_DIR = path.join(process.cwd(), 'data', 'agent-logs');

// ── Hook settings ─────────────────────────────────────────────────────────────
const HOOK_SCRIPT = path.resolve(process.cwd(), 'scripts/check-lock-hook.mjs');

export const HOOK_SETTINGS = JSON.stringify({
  hooks: {
    PreToolUse: [{
      matcher: "Edit|Write|MultiEdit|NotebookEdit",
      hooks: [{ type: "command", command: `node ${HOOK_SCRIPT}` }]
    }]
  }
});

// ── System prompt ─────────────────────────────────────────────────────────────
export const SYSTEM_PROMPT = `You are a Claude Code agent in a multi-agent orchestration system.
Use these MCP tools from the 'orchestrator' server:

FILE LOCKING (required before any edits):
  - lock_files(files, reason): Acquire exclusive locks BEFORE editing or creating files. BLOCKS until
    the locks are available — you will resume automatically once they are free. If it times out
    (success=false, timed_out=true), release any locks you currently hold then IMMEDIATELY call
    lock_files again (do not pause to reason first). If a deadlock cycle is detected
    (success=false, deadlock_detected=true), release ALL your currently held locks with release_files,
    then retry lock_files for all files you need in a single call.
  - release_files(files): Release locks when you are done with those files.
  - check_file_locks(): See what files other agents currently have locked.

COORDINATION:
  - report_status(message): Update your status message in the orchestrator dashboard.
  - ask_user(question): Ask the human a question and WAIT for their answer before continuing.

ORCHESTRATION (spawn and coordinate sub-agents):
  - create_job(description, title?, priority?, work_dir?, max_turns?, model?, depends_on?):
      Create a new job that will be run by another agent. Returns { job_id, title, status }.
      work_dir defaults to your own working directory.
  - create_autonomous_agent_run(task, title?, workDir?, implementerModel?, reviewerModel?, maxCycles?, ...):
      Create a structured multi-cycle autonomous agent run with assess, review, and implement phases.
      Use this when the work needs iterative planning, milestone tracking, shared worktree continuity,
      or an automatic PR at the end. Returns the run id, project id, and initial assess job id.
  - wait_for_jobs(job_ids, timeout_ms?):
      Block until all specified jobs finish. Returns an array of { job_id, title, status, work_dir, result_text }.
      work_dir is the actual working directory the job ran in (worktree path if use_worktree was set).
      Each call returns after at most ~90s. If some jobs still have non-terminal status (queued/running),
      re-call wait_for_jobs with those job IDs until all are done/failed/cancelled.

EYE (non-blocking discussions & proposals with the user):
  - start_discussion(topic, message, category?, priority?, context?): Start a non-blocking discussion. Does NOT block.
  - check_discussions(discussion_ids?, unread_only?): Check for new user replies.
  - reply_discussion(discussion_id, message, resolve?): Reply to a discussion.
  - create_proposal(title, summary, rationale, confidence, estimated_complexity, category, evidence?, implementation_plan?): Propose work for user approval. Does NOT block.
  - check_proposals(proposal_ids?, status_filter?): Check proposal statuses.
  - reply_proposal(proposal_id, message, update_plan?): Reply to a proposal discussion.

INTEGRATIONS (external service access — must be configured in Eye settings):
  - query_linear(query, variables?): Execute a GraphQL query against the Linear API.
  - query_logs(env?, query_string?, container?, namespace?, node?, request_id?, task?, start_time?, end_time?, errors_only?, size?): Search OpenSearch logs. Requires AWS SSO auth.
  - query_db(sql, env?, database?): Execute READ-ONLY SQL against Postgres. Write operations are blocked.

SHARED SCRATCHPAD (coordinate data between agents):
  - write_note(key, value): Write a note visible to all agents. Use namespaced keys like "results/step1".
  - read_note(key): Read a note. Returns { found, key, value, updated_at }.
  - list_notes(prefix?): List note keys, optionally filtered by prefix.
  - watch_notes(keys?, prefix?, until_value?, timeout_ms?):
      Block until notes exist. In keys mode, all listed keys must exist.
      In prefix mode, at least one note under the prefix must exist.
      If until_value is set, matched notes must have that exact value.
      Use this to wait for data from other agents instead of polling read_note.

KNOWLEDGE BASE (persistent memory across jobs):
  - search_kb(query, project_id?): Search for relevant past learnings, patterns, and conventions.
  - report_learnings(learnings): Report what you learned during this task. Each learning has a
      title, content, optional tags, and optional scope ("project" or "global").
      Call this near the end of your work with up to 5 learnings.

IMPORTANT RULES:
- Always call lock_files BEFORE modifying any file. It will wait for you automatically.
- Always call release_files as soon as you finish with each file — don't hold locks longer than needed.
- Use report_status regularly to let the human know what you are doing.
- At the START of a task, call search_kb with relevant keywords to check for existing knowledge.
- Before FINISHING a task, call report_learnings with anything useful you discovered
  (build commands, gotchas, conventions, patterns, debugging tips).

PR DESCRIPTION STYLE:
- Never include "Generated by Claude Code" or any similar attribution footer in PR descriptions.
- Never use checkboxes (- [ ] or - [x]) in PR descriptions.
- Never use emojis in PR descriptions.

ORCHESTRATION PATTERN (for decomposing large tasks):
  1. Call report_status to describe your plan.
  2. If the task needs iterative assess/review/implement cycles, prefer create_autonomous_agent_run.
  3. Otherwise use create_job for each parallel sub-task. Collect the returned job_ids.
  4. Use depends_on to express ordering if some sub-tasks depend on others.
  5. Call wait_for_jobs(job_ids) to block until all sub-tasks complete.
  6. Read result_text and diff from the results to synthesize a final answer.
  7. Optionally use write_note/read_note to pass structured data between agents.

COMPLETION (automated jobs only):
  - finish_job(result?): Signal task completion and close this session. Only call this when your
    task prompt explicitly tells you to. Do NOT call this in interactive sessions.`;

// ── Memory budget ─────────────────────────────────────────────────────────────
export const MEMORY_BUDGET = 2000;

// ── Shared types ──────────────────────────────────────────────────────────────
export interface RunOptions {
  agentId: string;
  job: Job;
  mcpPort?: number;
  resumeSessionId?: string;
}


// ── Codex trust ──────────────────────────────────────────────────────────────

/**
 * Ensure a directory is marked as trusted in Codex's config.toml so the
 * "Do you trust this directory?" prompt doesn't appear. The bypass flag
 * doesn't suppress this prompt in codex v0.115.0+.
 *
 * Idempotent + self-healing: if concurrent spawns have previously written
 * duplicate `[projects."..."]` sections (which cause codex to fail with a
 * duplicate-key TOML parse error on every subsequent launch), this will
 * dedupe them on the next call. See issue: concurrent ensureCodexTrusted
 * calls across parallel workflow phases can race between read-check and
 * append-write, producing duplicate sections.
 */
// In-memory cache of workDirs we've already confirmed trusted in this process.
// Eliminates redundant fs reads on every agent spawn after the first.
const _trustedWorkDirs = new Set<string>();

export function ensureCodexTrusted(workDir: string): void {
  if (_trustedWorkDirs.has(workDir)) return;

  const configPath = path.join(process.env.HOME ?? '', '.codex', 'config.toml');
  try {
    let content = '';
    try { content = fs.readFileSync(configPath, 'utf8'); } catch { /* file doesn't exist yet */ }

    if (content.length > 0 && !content.endsWith('\n')) content += '\n';

    const key = `[projects.${JSON.stringify(workDir)}]`;
    const sectionRe = buildSectionRegex(key);
    const matches = [...content.matchAll(sectionRe)];

    if (matches.length === 1) {
      _trustedWorkDirs.add(workDir);
      return;
    }

    // Either no entry (add one) or multiple (dedupe to one). In both cases
    // compute the final desired content and write atomically via rename.
    // NEVER use appendFileSync: concurrent processes racing between read and
    // append can both observe 0 matches and both append, producing duplicate
    // [projects."..."] sections that cause codex to fail with a TOML parse error.
    let desired: string;
    if (matches.length === 0) {
      const sep = content.length === 0 || content.endsWith('\n\n') ? '' : '\n';
      desired = content + sep + `${key}\ntrust_level = "trusted"\n`;
    } else {
      // matches.length > 1 — keep first, strip the rest
      desired = content;
      for (const m of matches.slice(1).reverse()) {
        desired = desired.slice(0, m.index!) + desired.slice(m.index! + m[0].length);
      }
      desired = desired.replace(/\n{3,}/g, '\n\n');
    }

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const tmpPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, desired);
    fs.renameSync(tmpPath, configPath);
    _trustedWorkDirs.add(workDir);
  } catch (err) {
    console.warn(`[codex] failed to add trust for ${workDir}:`, err);
  }
}

/**
 * Build a regex that matches a TOML `[projects."..."]` section: the header
 * line, all following body lines up to (but excluding) the next `[section]`
 * header or end-of-file.
 */
function buildSectionRegex(key: string): RegExp {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\n?${esc}\\n(?:(?!\\[)[^\\n]*\\n)*`, 'g');
}

// ── Cancelled agents ─────────────────────────────────────────────────────────
// Agents that were explicitly cancelled — handleAgentExit checks this to avoid overwriting 'cancelled' status
export const cancelledAgents = new Set<string>();

// ── Shared path helpers ─────────────────────────────────────────────────────
// Centralized here to avoid duplication across AgentSpawner, PtySessionManager,
// and PtyDiskLogger.

export function sessionName(agentId: string): string {
  return `orchestrator-${agentId}`;
}

export function getExistingCwd(preferred?: string | null): string {
  if (preferred) {
    try {
      if (fs.statSync(preferred).isDirectory()) return preferred;
    } catch { /* fall through */ }
  }
  return process.cwd();
}

// ── Shared helper functions ──────────────────────────────────────────────────

export function readClaudeMd(workDir: string): string | null {
  const claudeMdPath = path.join(workDir, 'CLAUDE.md');
  let content: string;
  try {
    content = fs.readFileSync(claudeMdPath, 'utf8');
  } catch {
    return null;
  }

  // Also read any .claude/docs/ files referenced in CLAUDE.md
  const docsDir = path.join(workDir, '.claude', 'docs');
  try {
    const docFiles = fs.readdirSync(docsDir).filter(f => f.endsWith('.md'));
    if (docFiles.length > 0) {
      content += '\n\n---\n\n# Referenced Documentation\n';
      for (const docFile of docFiles) {
        try {
          const docContent = fs.readFileSync(path.join(docsDir, docFile), 'utf8');
          content += `\n## ${docFile}\n\n${docContent}\n`;
        } catch { /* skip unreadable docs */ }
      }
    }
  } catch { /* no .claude/docs directory */ }

  return content;
}

export function buildMemorySection(job: Job): string {
  const projectId: string | null = job.project_id ?? null;
  const workDir: string | null = job.work_dir ?? null;
  const effectiveProjectId: string | null = projectId ?? workDir ?? null;
  const memories = queries.getMemoryForJob(effectiveProjectId, job.title, job.description);
  if (memories.length === 0) return '';

  let section = '\n\n## Memory\nRelevant learnings from previous tasks:\n';
  let budget = MEMORY_BUDGET - section.length;

  for (const m of memories) {
    const scope = m.project_id ? 'project' : 'global';
    const header = `\n### ${m.title} [${scope}]\n`;
    const remaining = budget - header.length - 5; // 5 for "...\n"
    if (remaining <= 0) break;
    const content = m.content.length > remaining ? m.content.slice(0, remaining) + '...' : m.content;
    const entry = header + content + '\n';
    budget -= entry.length;
    section += entry;
    if (budget <= 0) break;
  }

  return section;
}
