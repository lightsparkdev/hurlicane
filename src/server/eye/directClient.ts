/**
 * In-process OrchestratorClient — replaces the HTTP-based client from eye/orchestrator.ts.
 * Calls DB queries and internal functions directly instead of making HTTP round-trips.
 */
import { randomUUID } from 'crypto';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import type { CreateJobRequest, Repo, Worktree } from '../../shared/types.js';
import type { OrchestratorClient, EyePrompts, TemplateBinding } from './types.js';
import { execSync } from 'child_process';
import path from 'path';

const WORKTREES_DIR = path.resolve('data', 'worktrees');

// ─── Smart title generation (extracted from jobs API) ─────────────────────

const TITLE_MAX = 45;

function autoTitle(description: string): string {
  const firstLine = description.trim().split('\n')[0].trim();
  return firstLine.length > TITLE_MAX ? firstLine.slice(0, TITLE_MAX - 1) + '…' : firstLine;
}

async function generateSmartTitle(description: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return autoTitle(description);

  try {
    const prompt = `Write a title for this task in ${TITLE_MAX} characters or fewer. Be semantic and descriptive — capture the essence, not just the first few words. Use title case. No quotes, no punctuation at the end, no explanation.\n\nTask:\n${description.slice(0, 1000)}`;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 30,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json() as any;
      const text = data.content?.[0]?.type === 'text' ? data.content[0].text?.trim() : null;
      if (text && text.length > 0) {
        return text.length > TITLE_MAX ? text.slice(0, TITLE_MAX - 1) + '…' : text;
      }
    }
  } catch {
    // Fall through to auto title
  }
  return autoTitle(description);
}

// ─── Direct client implementation ─────────────────────────────────────────

export function createDirectClient(): OrchestratorClient {
  return {
    async createJob(req: CreateJobRequest): Promise<{ id: string; title: string } | null> {
      try {
        const tpl = req.templateId ? queries.getTemplateById(req.templateId) : null;
        const isReadonly = (req.readonly || !!tpl?.is_readonly) ? 1 : 0;
        const titleSource = req.description || tpl?.content || '';
        const title = req.title?.trim() || (titleSource ? await generateSmartTitle(titleSource) : 'Untitled');

        // Merge context: template context as base, request context overrides
        let mergedContext: string | null = null;
        if (tpl?.context || req.context) {
          const tplCtx = tpl?.context ? JSON.parse(tpl.context) : {};
          const merged = { ...tplCtx, ...req.context };
          if (Object.keys(merged).length > 0) mergedContext = JSON.stringify(merged);
        }

        const job = queries.insertJob({
          id: randomUUID(),
          title,
          description: req.description ?? '',
          context: mergedContext,
          priority: req.priority ?? tpl?.priority ?? 0,
          repo_id: req.repoId ?? tpl?.repo_id ?? null,
          branch: req.branch ?? null,
          max_turns: req.maxTurns ?? 50,
          model: req.model ?? tpl?.model ?? null,
          template_id: req.templateId ?? null,
          depends_on: req.dependsOn?.length ? JSON.stringify(req.dependsOn) : null,
          is_interactive: req.interactive !== undefined ? (req.interactive ? 1 : 0) : (tpl?.is_interactive ?? 0),
          is_readonly: isReadonly,
          project_id: req.projectId ?? tpl?.project_id ?? null,
          scheduled_at: req.scheduledAt ?? null,
          repeat_interval_ms: req.repeatIntervalMs ?? null,
          retry_policy: req.retryPolicy ?? tpl?.retry_policy ?? 'none',
          max_retries: req.maxRetries ?? tpl?.max_retries ?? 0,
          retry_count: 0,
          original_job_id: null,
          completion_checks: req.completionChecks?.length
            ? JSON.stringify(req.completionChecks)
            : tpl?.completion_checks ?? null,
        });

        socket.emitJobNew(job);
        console.log(`[eye] created job: ${job.title} (${job.id})`);
        return { id: job.id, title: job.title };
      } catch (err) {
        console.error('[eye] createJob failed:', err);
        return null;
      }
    },

    async getRepoByName(name: string): Promise<Repo | null> {
      return queries.getRepoByName(name);
    },

    async listRepos(): Promise<Repo[]> {
      return queries.listRepos();
    },

    async getWorktreeByBranch(branch: string): Promise<Worktree | null> {
      return queries.getWorktreeByBranch(branch) ?? null;
    },

    async createWorktree(branch: string, repoId: string, trackExisting = true): Promise<Worktree | null> {
      const sanitized = branch
        .replace(/[^a-zA-Z0-9._\-/]+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^[-./]+|[-./]+$/g, '');
      if (!sanitized) return null;

      const repo = queries.getRepoById(repoId);
      if (!repo) return null;

      try {
        const shortId = randomUUID().slice(0, 8);
        const worktreeDir = path.join(WORKTREES_DIR, shortId);
        const baseBranch = repo.default_branch || 'main';

        try { execSync(`git fetch origin ${JSON.stringify(baseBranch)}`, { cwd: repo.path, timeout: 30_000, stdio: 'pipe' }); } catch { /* ignore */ }
        try { execSync(`git rev-parse ${JSON.stringify(baseBranch)}`, { cwd: repo.path, timeout: 5_000, stdio: 'pipe' }); } catch {
          execSync('git commit --allow-empty -m "Initial commit"', { cwd: repo.path, timeout: 10_000, stdio: 'pipe' });
        }
        try { execSync('git worktree prune', { cwd: repo.path, timeout: 10_000, stdio: 'pipe' }); } catch { /* ignore */ }

        // Remove old worktree holding this branch
        try {
          const wtList = execSync('git worktree list --porcelain', { cwd: repo.path, timeout: 10_000, stdio: 'pipe' }).toString();
          for (const entry of wtList.split('\n\n')) {
            const branchMatch = entry.match(/^branch refs\/heads\/(.+)$/m);
            const pathMatch = entry.match(/^worktree (.+)$/m);
            if (branchMatch && pathMatch && branchMatch[1] === sanitized && pathMatch[1] !== repo.path) {
              try { execSync(`git worktree remove --force ${JSON.stringify(pathMatch[1])}`, { cwd: repo.path, timeout: 15_000, stdio: 'pipe' }); } catch { /* ignore */ }
              const oldWt = queries.getWorktreeByPath(pathMatch[1]);
              if (oldWt) queries.markWorktreeCleaned(oldWt.id);
            }
          }
        } catch { /* ignore */ }

        if (trackExisting) {
          try { execSync('git fetch origin', { cwd: repo.path, timeout: 30_000, stdio: 'pipe' }); } catch { /* ignore */ }
          try {
            execSync(`git worktree add ${JSON.stringify(worktreeDir)} ${JSON.stringify(sanitized)}`, { cwd: repo.path, timeout: 30_000 });
          } catch {
            const remoteRef = `origin/${sanitized}`;
            execSync(`git worktree add --detach ${JSON.stringify(worktreeDir)} ${JSON.stringify(remoteRef)}`, { cwd: repo.path, timeout: 30_000 });
            execSync(`git checkout -B ${JSON.stringify(sanitized)} ${JSON.stringify(remoteRef)}`, { cwd: worktreeDir, timeout: 10_000 });
          }
        } else {
          const remoteBase = `origin/${baseBranch}`;
          execSync(`git worktree add ${JSON.stringify(worktreeDir)} -b ${JSON.stringify(sanitized)} ${JSON.stringify(remoteBase)}`, { cwd: repo.path, timeout: 30_000 });
        }

        return queries.insertWorktree({ id: shortId, repo_id: repo.id, agent_id: '', job_id: '', path: worktreeDir, branch: sanitized });
      } catch (err) {
        console.error('[eye] createWorktree failed:', err);
        return null;
      }
    },

    async cleanupBranch(branch: string, merged?: boolean): Promise<{ found: boolean; cancelledJobs: number } | null> {
      const { cancelledAgents } = await import('../orchestrator/AgentRunner.js');
      const { getFileLockRegistry } = await import('../orchestrator/FileLockRegistry.js');

      const wt = queries.getWorktreeByBranch(branch);
      if (!wt) return { found: false, cancelledJobs: 0 };

      const activeJobs = wt.repo_id ? queries.listActiveJobsByRepoBranch(wt.repo_id, wt.branch) : [];
      let cancelledJobCount = 0;
      for (const job of activeJobs) {
        const agents = queries.getAgentsWithJobByJobId(job.id);
        for (const agent of agents) {
          if (['starting', 'running', 'waiting_user'].includes(agent.status)) {
            cancelledAgents.add(agent.id);
            if (agent.pid) {
              try { process.kill(-agent.pid, 'SIGTERM'); } catch { /* already gone */ }
            }
            queries.updateAgent(agent.id, { status: 'cancelled', finished_at: Date.now() });
            getFileLockRegistry().releaseAll(agent.id);
            const updated = queries.getAgentWithJob(agent.id);
            if (updated) socket.emitAgentUpdate(updated);
          }
        }
        queries.updateJobStatus(job.id, 'cancelled');
        const updatedJob = queries.getJobById(job.id);
        if (updatedJob) socket.emitJobUpdate(updatedJob);
        cancelledJobCount++;
      }

      const repo = queries.getRepoById(wt.repo_id);
      if (repo) {
        try { execSync(`git worktree remove --force ${JSON.stringify(wt.path)}`, { cwd: repo.path, timeout: 30_000 }); } catch { /* already gone */ }
      }
      queries.markWorktreeCleaned(wt.id);

      if (cancelledJobCount > 0) {
        console.log(`[eye] cleaned up branch ${branch}: cancelled ${cancelledJobCount} jobs`);
      }
      return { found: true, cancelledJobs: cancelledJobCount };
    },

    async getPrompts(): Promise<EyePrompts> {
      let disabledEvents: string[] = [];
      try {
        const raw = queries.getNote('setting:eye:disabledEvents')?.value;
        if (raw) disabledEvents = JSON.parse(raw);
      } catch { /* ignore */ }

      let eventTemplates: Record<string, TemplateBinding[]> = {};
      try {
        const raw = queries.getNote('setting:eye:eventTemplates')?.value;
        if (raw) {
          const parsed = JSON.parse(raw);
          for (const [key, val] of Object.entries(parsed)) {
            if (Array.isArray(val)) {
              eventTemplates[key] = (val as any[]).map(item =>
                typeof item === 'string' ? { templateId: item, filters: [] } : item as TemplateBinding
              );
            } else if (typeof val === 'string' && val) {
              eventTemplates[key] = [{ templateId: val, filters: [] }];
            }
          }
        }
      } catch { /* ignore */ }

      let globalFilters: import('./types.js').TemplateFilter[] = [];
      try {
        const raw = queries.getNote('setting:eye:globalFilters')?.value;
        if (raw) globalFilters = JSON.parse(raw);
      } catch { /* ignore */ }

      return {
        eventTemplates,
        disabledEvents,
        globalFilters,
        botName: queries.getNote('setting:botName')?.value ?? '',
      };
    },
  };
}
