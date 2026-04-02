import { execSync } from 'child_process';
import type { EyeConfig, OrchestratorClient } from './types.js';
import type { CreateJobRequest } from '../../shared/types.js';
import { processEvent, extractFilterFields, filtersPass } from './middleware.js';

// ─── Recent Events Log ─────────────────────────────────────────────────────

export type Decision = 'ignored' | 'ran';

export interface EyeEvent {
  ts: number;
  event_type: string;
  action: string;
  repo: string;
  author: string;
  decision: Decision;
  job_title: string | null;
  detail: string | null;
}

const MAX_EVENTS = 200;
let recentEvents: EyeEvent[] = [];

function logEvent(e: EyeEvent): void {
  recentEvents.push(e);
  if (recentEvents.length > MAX_EVENTS) recentEvents.shift();
}

export function getRecentEvents(): EyeEvent[] {
  return recentEvents;
}

// ─── Dedup ──────────────────────────────────────────────────────────────────

const DEDUP_TTL_MS = 10 * 60 * 1000;

const seen = new Map<string, number>();
let dedupInterval: ReturnType<typeof setInterval> | null = null;

function isDuplicate(key: string): boolean {
  const now = Date.now();
  const ts = seen.get(key);
  if (ts && now - ts < DEDUP_TTL_MS) return true;
  seen.set(key, now);
  return false;
}

function clearDedupPrefix(prefix: string): void {
  for (const key of seen.keys()) {
    if (key.startsWith(prefix)) seen.delete(key);
  }
}

/** Start the periodic dedup cleanup. Called when Eye is activated. */
export function startDedupCleanup(): void {
  if (dedupInterval) return;
  dedupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, ts] of seen) {
      if (now - ts >= DEDUP_TTL_MS) seen.delete(key);
    }
  }, 60_000);
  dedupInterval.unref();
}

/** Stop the periodic dedup cleanup and reset state. Called when Eye is deactivated. */
export function stopDedupCleanup(): void {
  if (dedupInterval) {
    clearInterval(dedupInterval);
    dedupInterval = null;
  }
}

/** Reset all in-memory state (events log, dedup map). */
/** Cancel and clear any pending review debounce buffers matching a prefix (e.g. "owner/repo#123:"). */
function clearReviewBuffers(prefix: string): void {
  for (const [key, buf] of reviewBuffers) {
    if (key.startsWith(prefix)) {
      clearTimeout(buf.timer);
      reviewBuffers.delete(key);
    }
  }
}

export function resetState(): void {
  recentEvents = [];
  seen.clear();
  for (const [key, buf] of reviewBuffers) {
    clearTimeout(buf.timer);
    reviewBuffers.delete(key);
  }
  for (const [key, buf] of prUpdateBuffers) {
    clearTimeout(buf.timer);
    prUpdateBuffers.delete(key);
  }
  for (const [key, buf] of ciFailureBuffers) {
    clearTimeout(buf.timer);
    ciFailureBuffers.delete(key);
  }
  firedCiCommits.clear();
  firedMergeConflicts.clear();
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildJob(
  _config: EyeConfig,
  title: string,
  description: string,
  priority: number,
  context?: Record<string, string>,
): CreateJobRequest {
  return {
    title,
    description,
    priority,
    model: 'claude-opus-4-6',
    context,
  };
}

// ─── Review Debounce ─────────────────────────────────────────────────────────
// Greptile (and similar tools) post each inline comment as a separate
// pull_request_review webhook. We buffer reviews per PR+reviewer for a short
// window, then emit a single combined job.

const REVIEW_DEBOUNCE_MS = 5_000;

// ─── PR Update Debounce ──────────────────────────────────────────────────────
// Combines pull_request_review and issue_comment events per PR into a single
// debounced event. Users can subscribe to "pr_update" instead of handling
// reviews and comments separately.

const PR_UPDATE_DEBOUNCE_MS = 10_000;

// ─── CI Failure Debounce ─────────────────────────────────────────────────────
// Multiple check_suite / check_run failure webhooks often arrive in quick
// succession for the same commit. We batch them per commit SHA into a single job.

const CI_FAILURE_DEBOUNCE_MS = 60_000;

interface BufferedReview {
  reviewId: string;
  state: string;
  body: string;
  inlineComments: string;
}

interface ReviewBuffer {
  timer: ReturnType<typeof setTimeout>;
  reviews: BufferedReview[];
  repo: string;
  prNum: number;
  branch: string;
  reviewer: string;
  config: EyeConfig;
  botPrefix?: string;
  // Stored so the debounce flush can create the job
  dispatchContext: {
    client: OrchestratorClient;
    eventType: string;
    payload: any;  // last payload (used for filter field extraction)
  };
}

const reviewBuffers = new Map<string, ReviewBuffer>();

function flushReviewBuffer(key: string): void {
  const buf = reviewBuffers.get(key);
  if (!buf) return;
  reviewBuffers.delete(key);

  const { reviews, repo, prNum, branch, reviewer, config, dispatchContext } = buf;
  if (reviews.length === 0) return;

  // Highest priority wins (changes_requested > others)
  const hasChangesRequested = reviews.some(r => r.state === 'changes_requested');
  const priority = hasChangesRequested ? 4 : 1;
  const title = hasChangesRequested
    ? `Address review on ${repo}#${prNum}`
    : `Review commented on ${repo}#${prNum}`;

  const parts = [
    `${reviewer} left ${reviews.length} review${reviews.length > 1 ? 's' : ''} on ${repo}#${prNum} (branch: ${branch}).`,
  ];

  for (const r of reviews) {
    if (r.body) parts.push(`\nReview comment (${r.state}):\n${r.body}`);
    if (r.inlineComments) parts.push(`\nInline comments:\n${r.inlineComments}`);
  }

  if (hasChangesRequested) {
    parts.push(`\nAddress the requested changes and push a fix.`);
  } else {
    parts.push(`\nReview and respond or address the comments as needed.`);
  }

  const reviewIds = reviews.map(r => r.reviewId).join(',');
  const job = buildJob(config, title, parts.join('\n'), priority, {
    repo, pr: String(prNum), branch, reviewer, review_id: reviewIds,
  });

  const { client, eventType, payload } = dispatchContext;
  processEvent(client, config, eventType, payload, job).then(result => {
    const action = payload.action ?? '';
    const author = payload.sender?.login ?? '';
    if (result) {
      logEvent({ ts: Date.now(), event_type: eventType, action, repo, author, decision: 'ran', job_title: result.title, detail: `count=${result.count}, reviews=${reviews.length}` });
    } else {
      logEvent({ ts: Date.now(), event_type: eventType, action, repo, author, decision: 'ignored', job_title: null, detail: 'no bindings matched filters or job creation failed' });
    }
  }).catch(err => {
    console.error('[eye] failed to flush review buffer:', err);
  });
}

function bufferReview(
  payload: any,
  config: EyeConfig,
  botPrefix: string | undefined,
  client: OrchestratorClient,
): string {
  const review = payload.review;
  const pr = payload.pull_request;
  const repo = payload.repository?.full_name;
  if (!review || !pr || !repo) return 'missing review/pr/repo';
  if (payload.action !== 'submitted') return `action "${payload.action}" (want "submitted")`;

  const reviewer = review.user?.login ?? 'unknown';
  const prNum = pr.number;
  const state = review.state ?? 'unknown';
  const dedupKey = `review:${repo}#${prNum}:${review.id}`;
  if (isDuplicate(dedupKey)) return 'duplicate';

  const inlineComments = fetchReviewComments(repo, prNum, review.id, botPrefix);

  const bufferKey = `${repo}#${prNum}:${reviewer}`;
  const existing = reviewBuffers.get(bufferKey);

  const bufferedReview: BufferedReview = {
    reviewId: String(review.id),
    state,
    body: review.body ?? '',
    inlineComments,
  };

  if (existing) {
    // Reset the timer and add this review
    clearTimeout(existing.timer);
    existing.reviews.push(bufferedReview);
    existing.dispatchContext.payload = payload;  // keep latest payload
    existing.timer = setTimeout(() => flushReviewBuffer(bufferKey), REVIEW_DEBOUNCE_MS);
  } else {
    const timer = setTimeout(() => flushReviewBuffer(bufferKey), REVIEW_DEBOUNCE_MS);
    reviewBuffers.set(bufferKey, {
      timer,
      reviews: [bufferedReview],
      repo,
      prNum,
      branch: pr.head?.ref ?? '',
      reviewer,
      config,
      botPrefix,
      dispatchContext: { client, eventType: 'pull_request_review', payload },
    });
  }

  return 'debounced';
}

// ─── PR Update Debounce Buffers ──────────────────────────────────────────────

interface PrUpdateItem {
  kind: 'review' | 'comment';
  author: string;
  body: string;
  /** For reviews: inline comments fetched from the API */
  inlineComments?: string;
  /** For reviews: the review state (changes_requested, commented, approved) */
  reviewState?: string;
}

interface PrUpdateBuffer {
  timer: ReturnType<typeof setTimeout>;
  items: PrUpdateItem[];
  repo: string;
  prNum: number;
  branch: string;
  config: EyeConfig;
  botPrefix?: string;
  dispatchContext: {
    client: OrchestratorClient;
    lastPayload: any;
  };
}

const prUpdateBuffers = new Map<string, PrUpdateBuffer>();

function flushPrUpdateBuffer(key: string): void {
  const buf = prUpdateBuffers.get(key);
  if (!buf) return;
  prUpdateBuffers.delete(key);

  const { items, repo, prNum, branch, config, dispatchContext } = buf;
  if (items.length === 0) return;

  const hasChangesRequested = items.some(i => i.reviewState === 'changes_requested');
  const reviews = items.filter(i => i.kind === 'review');
  const comments = items.filter(i => i.kind === 'comment');

  const priority = hasChangesRequested ? 4 : 2;
  const title = hasChangesRequested
    ? `Address feedback on ${repo}#${prNum}`
    : `PR activity on ${repo}#${prNum}`;

  const parts = [`Activity on ${repo}#${prNum} (branch: ${branch}):`];

  for (const r of reviews) {
    const stateLabel = r.reviewState ?? 'review';
    parts.push(`\n${r.author} left a ${stateLabel} review:`);
    if (r.body) parts.push(r.body);
    if (r.inlineComments) parts.push(`Inline comments:\n${r.inlineComments}`);
  }

  for (const c of comments) {
    parts.push(`\n${c.author} commented:`);
    parts.push(c.body || '(empty)');
  }

  if (hasChangesRequested) {
    parts.push(`\nAddress the requested changes and push a fix.`);
  } else {
    parts.push(`\nReview and respond to the feedback as needed.`);
  }

  const job = buildJob(config, title, parts.join('\n'), priority, {
    repo, pr: String(prNum), branch,
  });

  const { client, lastPayload } = dispatchContext;
  processEvent(client, config, 'pr_update', lastPayload, job).then(result => {
    const action = lastPayload.action ?? '';
    const author = lastPayload.sender?.login ?? '';
    if (result) {
      logEvent({ ts: Date.now(), event_type: 'pr_update', action: 'debounced', repo, author, decision: 'ran', job_title: result.title, detail: `count=${result.count}, reviews=${reviews.length}, comments=${comments.length}` });
    } else {
      logEvent({ ts: Date.now(), event_type: 'pr_update', action: 'debounced', repo, author, decision: 'ignored', job_title: null, detail: 'no bindings matched filters or job creation failed' });
    }
  }).catch(err => {
    console.error('[eye] failed to flush pr_update buffer:', err);
  });
}

function bufferPrUpdate(
  kind: 'review' | 'comment',
  payload: any,
  config: EyeConfig,
  botPrefix: string | undefined,
  client: OrchestratorClient,
): string {
  const repo = payload.repository?.full_name;
  if (!repo) return 'no repo in payload';

  let prNum: number;
  let branch = '';
  let author = '';
  let body = '';
  let inlineComments: string | undefined;
  let reviewState: string | undefined;

  if (kind === 'review') {
    const review = payload.review;
    const pr = payload.pull_request;
    if (!review || !pr) return 'missing review/pr';
    if (payload.action !== 'submitted') return `action "${payload.action}" (want "submitted")`;
    prNum = pr.number;
    branch = pr.head?.ref ?? '';
    author = review.user?.login ?? 'unknown';
    body = review.body ?? '';
    reviewState = review.state ?? 'unknown';
    inlineComments = fetchReviewComments(repo, prNum, review.id, botPrefix);
  } else {
    if (payload.action !== 'created') return `action "${payload.action}" (want "created")`;
    const comment = payload.comment;
    const issue = payload.issue;
    if (!comment || !issue) return 'missing comment/issue';
    if (!issue.pull_request) return 'not a PR comment';
    prNum = issue.number;
    author = comment.user?.login ?? 'unknown';
    body = comment.body ?? '';
    try {
      branch = execSync(
        `gh pr view ${prNum} --repo ${repo} --json headRefName --jq .headRefName`,
        { timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] },
      ).toString().trim() || '';
    } catch { /* ignore */ }
  }

  const item: PrUpdateItem = { kind, author, body, inlineComments, reviewState };

  const bufferKey = `pr_update:${repo}#${prNum}`;
  const existing = prUpdateBuffers.get(bufferKey);

  if (existing) {
    clearTimeout(existing.timer);
    existing.items.push(item);
    existing.dispatchContext.lastPayload = payload;
    existing.timer = setTimeout(() => flushPrUpdateBuffer(bufferKey), PR_UPDATE_DEBOUNCE_MS);
  } else {
    const timer = setTimeout(() => flushPrUpdateBuffer(bufferKey), PR_UPDATE_DEBOUNCE_MS);
    prUpdateBuffers.set(bufferKey, {
      timer,
      items: [item],
      repo,
      prNum,
      branch,
      config,
      botPrefix,
      dispatchContext: { client, lastPayload: payload },
    });
  }

  return 'debounced';
}

function clearPrUpdateBuffers(prefix: string): void {
  for (const [key, buf] of prUpdateBuffers) {
    if (key.startsWith(`pr_update:${prefix}`)) {
      clearTimeout(buf.timer);
      prUpdateBuffers.delete(key);
    }
  }
}

// ─── CI Failure Debounce Buffers ─────────────────────────────────────────────

interface CiFailureItem {
  kind: 'check_suite' | 'check_run';
  name: string;
  conclusion: string;
  id: string;
}

interface CiFailureBuffer {
  timer: ReturnType<typeof setTimeout>;
  items: CiFailureItem[];
  repo: string;
  prNum: number;
  branch: string;
  headSha: string;
  config: EyeConfig;
  dispatchContext: {
    client: OrchestratorClient;
    lastPayload: any;
  };
}

const ciFailureBuffers = new Map<string, CiFailureBuffer>();

// Track commit SHAs that have already fired a CI failure event so we only fire once per commit.
const firedCiCommits = new Set<string>();

function flushCiFailureBuffer(key: string): void {
  const buf = ciFailureBuffers.get(key);
  if (!buf) return;
  ciFailureBuffers.delete(key);

  const { items, repo, prNum, branch, headSha, config, dispatchContext } = buf;
  if (items.length === 0) return;

  // Mark this commit as fired so no further CI failure events fire for it.
  if (headSha) firedCiCommits.add(`${repo}#${prNum}:${headSha}`);

  const failNames = items.map(i => i.name).join(', ');
  const shortSha = headSha ? headSha.slice(0, 7) : 'unknown';
  const title = `CI: ${items.length} check${items.length > 1 ? 's' : ''} failed on ${repo}#${prNum} (${shortSha})`;
  const parts = [
    `CI checks failed on ${repo}#${prNum} (branch: ${branch}, commit: ${headSha || 'unknown'}):`,
  ];
  for (const i of items) {
    parts.push(`- ${i.name}: ${i.conclusion}`);
  }
  parts.push(`\nInvestigate the failure${items.length > 1 ? 's' : ''} and push a fix.`);

  const job = buildJob(config, title, parts.join('\n'), 5, {
    repo, pr: String(prNum), branch,
  });

  const { client, lastPayload } = dispatchContext;
  // Use check_suite as the event type for filter matching
  const eventType = items[items.length - 1].kind;
  processEvent(client, config, eventType, lastPayload, job).then(result => {
    const action = lastPayload.action ?? '';
    const author = lastPayload.sender?.login ?? '';
    if (result) {
      logEvent({ ts: Date.now(), event_type: eventType, action: 'debounced', repo, author, decision: 'ran', job_title: result.title, detail: `count=${result.count}, checks=${items.length} (${failNames})` });
    } else {
      logEvent({ ts: Date.now(), event_type: eventType, action: 'debounced', repo, author, decision: 'ignored', job_title: null, detail: 'no bindings matched filters or job creation failed' });
    }
  }).catch(err => {
    console.error('[eye] failed to flush ci_failure buffer:', err);
  });
}

function bufferCiFailure(
  eventType: 'check_suite' | 'check_run',
  payload: any,
  config: EyeConfig,
  client: OrchestratorClient,
): string {
  if (payload.action !== 'completed') return `action "${payload.action}" (want "completed")`;

  const source = eventType === 'check_suite' ? payload.check_suite : payload.check_run;
  if (!source) return `no ${eventType} in payload`;

  const conclusion = source.conclusion ?? 'unknown';
  if (conclusion !== 'failure' && conclusion !== 'timed_out') return `conclusion "${conclusion}" (not a failure)`;

  const repo = payload.repository?.full_name;
  if (!repo) return 'no repo in payload';

  const prs: any[] = source.pull_requests ?? [];
  if (prs.length === 0) return 'no linked PRs';
  const pr = prs[0];
  const prNum = pr.number;
  const branch = pr.head?.ref ?? '';
  const headSha: string = source.head_sha ?? '';

  const commitKey = `${repo}#${prNum}:${headSha}`;
  if (headSha && firedCiCommits.has(commitKey)) return `already fired for commit ${headSha.slice(0, 7)}`;

  const dedupKey = `ci:${repo}#${prNum}:${eventType === 'check_suite' ? 'suite' : 'run'}:${source.id}`;
  if (isDuplicate(dedupKey)) return 'duplicate';

  const name = (eventType === 'check_suite' ? source.app?.name : source.name) ?? 'CI';

  const item: CiFailureItem = { kind: eventType, name, conclusion, id: String(source.id) };

  const bufferKey = `ci_failure:${repo}#${prNum}:${headSha}`;
  const existing = ciFailureBuffers.get(bufferKey);

  if (existing) {
    clearTimeout(existing.timer);
    existing.items.push(item);
    existing.dispatchContext.lastPayload = payload;
    existing.timer = setTimeout(() => flushCiFailureBuffer(bufferKey), CI_FAILURE_DEBOUNCE_MS);
  } else {
    const timer = setTimeout(() => flushCiFailureBuffer(bufferKey), CI_FAILURE_DEBOUNCE_MS);
    ciFailureBuffers.set(bufferKey, {
      timer,
      items: [item],
      repo,
      prNum,
      branch,
      headSha,
      config,
      dispatchContext: { client, lastPayload: payload },
    });
  }

  return 'debounced';
}

function clearCiFailureBuffers(prefix: string): void {
  for (const [key, buf] of ciFailureBuffers) {
    if (key.startsWith(`ci_failure:${prefix}`)) {
      clearTimeout(buf.timer);
      ciFailureBuffers.delete(key);
    }
  }
}

// ─── Merge Conflict Polling ──────────────────────────────────────────────────
// Polls draft PRs (created within the last week) for merge conflicts and fires
// a single event per PR. Once fired for a given PR, it won't fire again until
// the conflict is resolved and reappears.

const MERGE_CONFLICT_POLL_MS = 5 * 60_000; // every 5 minutes

// Tracks repo#prNum keys that have already fired a merge_conflict event.
// Cleared when the PR is no longer in a conflicting state so it can re-fire.
const firedMergeConflicts = new Set<string>();

let mergeConflictInterval: ReturnType<typeof setInterval> | null = null;
let mergeConflictConfig: EyeConfig | null = null;
let mergeConflictClient: import('./types.js').OrchestratorClient | null = null;

interface ConflictingPR {
  repo: string;
  number: number;
  title: string;
  branch: string;
  baseBranch: string;
}

function ghJson(args: string): any | null {
  try {
    return JSON.parse(execSync(`gh ${args} 2>/dev/null`, { encoding: 'utf8', timeout: 30_000 }));
  } catch {
    return null;
  }
}

async function pollMergeConflicts(): Promise<void> {
  const config = mergeConflictConfig;
  const client = mergeConflictClient;
  if (!config || !client) return;

  const prompts = await client.getPrompts();
  if (prompts.disabledEvents.includes('merge_conflict')) return;

  const bindings = prompts.eventTemplates['merge_conflict'] ?? [];
  if (bindings.length === 0) return;

  const repos = await client.listRepos();
  if (repos.length === 0) return;

  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();

  for (const repo of repos) {
    const repoName = repo.name;
    try {
      // List open draft PRs by the configured author, created within the last week
      const prs = ghJson(
        `pr list --repo ${JSON.stringify(repoName)} --state open --author ${JSON.stringify(config.author)} --json number,title,headRefName,baseRefName,isDraft,mergeable,createdAt`
      );
      if (!prs || !Array.isArray(prs)) continue;

      for (const pr of prs) {
        if (!pr.isDraft) continue;
        if (pr.createdAt && pr.createdAt < oneWeekAgo) continue;

        const prKey = `${repoName}#${pr.number}`;

        // mergeable === 'CONFLICTING' means there's a merge conflict
        if (pr.mergeable === 'CONFLICTING') {
          if (firedMergeConflicts.has(prKey)) continue;

          firedMergeConflicts.add(prKey);

          const title = `Merge conflict on ${repoName}#${pr.number}`;
          const description = [
            `Draft PR ${repoName}#${pr.number} ("${pr.title}") has a merge conflict.`,
            `Branch: ${pr.headRefName} → ${pr.baseRefName}`,
            `\nResolve the merge conflict so CI can run.`,
          ].join('\n');

          const job = buildJob(config, title, description, 3, {
            repo: repoName,
            pr: String(pr.number),
            branch: pr.headRefName,
          });

          job.repoId = repo.id;
          job.branch = pr.headRefName;

          // Synthesize a minimal payload for processEvent filter matching
          const syntheticPayload = {
            repository: { full_name: repoName },
            sender: { login: config.author },
            pull_request: {
              number: pr.number,
              user: { login: config.author },
              draft: true,
              head: { ref: pr.headRefName },
              base: { ref: pr.baseRefName },
            },
          };

          const result = await processEvent(client, config, 'merge_conflict', syntheticPayload, job);
          if (result) {
            logEvent({ ts: Date.now(), event_type: 'merge_conflict', action: 'poll', repo: repoName, author: config.author, decision: 'ran', job_title: result.title, detail: `PR #${pr.number} has merge conflict` });
          } else {
            logEvent({ ts: Date.now(), event_type: 'merge_conflict', action: 'poll', repo: repoName, author: config.author, decision: 'ignored', job_title: null, detail: 'no bindings matched filters or job creation failed' });
          }
        } else {
          // Conflict resolved — allow re-firing if it comes back
          firedMergeConflicts.delete(prKey);
        }
      }
    } catch (err: any) {
      console.error(`[eye] merge conflict poll error for ${repoName}:`, err.message);
    }
  }
}

export function startMergeConflictPoll(config: EyeConfig, client: import('./types.js').OrchestratorClient): void {
  mergeConflictConfig = config;
  mergeConflictClient = client;
  if (mergeConflictInterval) return;
  // Run immediately, then on interval
  pollMergeConflicts().catch(err => console.error('[eye] merge conflict poll error:', err));
  mergeConflictInterval = setInterval(() => {
    pollMergeConflicts().catch(err => console.error('[eye] merge conflict poll error:', err));
  }, MERGE_CONFLICT_POLL_MS);
  mergeConflictInterval.unref();
  console.log('[eye] merge conflict polling started (every 5 minutes)');
}

export function stopMergeConflictPoll(): void {
  if (mergeConflictInterval) {
    clearInterval(mergeConflictInterval);
    mergeConflictInterval = null;
  }
  mergeConflictConfig = null;
  mergeConflictClient = null;
}

// ─── Event Handlers ─────────────────────────────────────────────────────────

type HandlerResult = CreateJobRequest | string;

function handleCheckSuite(payload: any, config: EyeConfig): HandlerResult {
  if (payload.action !== 'completed') return `action "${payload.action}" (want "completed")`;
  const suite = payload.check_suite;
  if (!suite) return 'no check_suite in payload';
  const repo = payload.repository?.full_name;
  if (!repo) return 'no repo in payload';
  const prs: any[] = suite.pull_requests ?? [];
  if (prs.length === 0) return 'no linked PRs';
  const pr = prs[0];
  const prNum = pr.number;
  const dedupKey = `ci:${repo}#${prNum}:suite:${suite.id}`;
  if (isDuplicate(dedupKey)) return 'duplicate';
  const name = suite.app?.name ?? 'CI';
  const conclusion = suite.conclusion ?? 'unknown';
  const title = `CI: ${name} ${conclusion} on ${repo}#${prNum}`;
  const description = [
    `CI check suite "${name}" completed on ${repo}#${prNum} (branch: ${pr.head?.ref ?? 'unknown'}).`,
    `Conclusion: ${conclusion}.`,
    conclusion === 'failure' ? `Investigate the failure and push a fix.` : `Review the results.`,
  ].join('\n');
  return buildJob(config, title, description, 5, {
    repo, pr: String(prNum), branch: pr.head?.ref ?? '', check_suite_id: String(suite.id),
  });
}

function handleCheckRun(payload: any, config: EyeConfig): HandlerResult {
  if (payload.action !== 'completed') return `action "${payload.action}" (want "completed")`;
  const run = payload.check_run;
  if (!run) return 'no check_run in payload';
  const repo = payload.repository?.full_name;
  if (!repo) return 'no repo in payload';
  const prs: any[] = run.pull_requests ?? [];
  if (prs.length === 0) return 'no linked PRs';
  const pr = prs[0];
  const prNum = pr.number;
  const dedupKey = `ci:${repo}#${prNum}:run:${run.id}`;
  if (isDuplicate(dedupKey)) return 'duplicate';
  const name = run.name ?? 'CI';
  const conclusion = run.conclusion ?? 'unknown';
  const title = `CI: ${name} ${conclusion} on ${repo}#${prNum}`;
  const description = [
    `CI check run "${name}" completed on ${repo}#${prNum} (branch: ${pr.head?.ref ?? 'unknown'}).`,
    `Conclusion: ${conclusion}.`,
    conclusion === 'failure' ? `Investigate the failure and push a fix.` : `Review the results.`,
  ].join('\n');
  return buildJob(config, title, description, 5, {
    repo, pr: String(prNum), branch: pr.head?.ref ?? '', check_run_id: String(run.id),
  });
}

async function checkAllSuitesPassed(payload: any, config: EyeConfig): Promise<void> {
  const suite = payload.check_suite;
  if (!suite || suite.conclusion !== 'success') return;
  const repo = payload.repository?.full_name;
  const sha = suite.head_sha;
  if (!repo || !sha) return;
  const prs: any[] = suite.pull_requests ?? [];
  if (prs.length === 0) return;
  const prNum = prs[0].number;
  const branch = prs[0].head?.ref ?? '';
  const dedupKey = `all-checks:${repo}#${prNum}:${sha}`;
  if (isDuplicate(dedupKey)) return;

  try {
    const output = execSync(
      `gh api repos/${repo}/commits/${sha}/check-suites --jq '.check_suites[] | (.status + ":" + (.conclusion // "null"))'`,
      { timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).toString().trim();
    const entries = output.split('\n').filter(Boolean);
    if (entries.length === 0) return;
    const allCompleted = entries.every(e => e.startsWith('completed:'));
    if (!allCompleted) return;
    const conclusions = entries.map(e => e.split(':')[1]);
    const allPassed = conclusions.every(c => c === 'success' || c === 'neutral');
    if (!allPassed) return;

    console.log(`[eye] all checks passed for ${repo}#${prNum} (${sha.slice(0, 7)})`);

    // Send Slack notification directly via the local API
    try {
      const port = process.env.PORT ?? 3000;
      await fetch(`http://localhost:${port}/api/slack/notify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'all_checks_passed', repo, pr: prNum, branch, sha: sha.slice(0, 7) }),
      });
    } catch (err) {
      console.error('[eye] failed to send all-checks-passed notification:', err);
    }

    logEvent({
      ts: Date.now(), event_type: 'check_suite', action: 'all_passed', repo,
      author: config.author, decision: 'ran',
      job_title: `All checks passed: ${repo}#${prNum}`,
      detail: `${conclusions.length} suites, sha=${sha.slice(0, 7)}`,
    });
  } catch (err) {
    console.error('[eye] failed to query check suites:', err);
  }
}

function fetchReviewComments(repo: string, prNum: number | string, reviewId: string | number, botPrefix?: string): string {
  try {
    const allCommentsJson = execSync(
      `gh api repos/${repo}/pulls/${prNum}/comments --paginate`,
      { timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).toString().trim();
    const allComments: any[] = allCommentsJson ? JSON.parse(allCommentsJson) : [];
    const lineById = new Map<number, { path: string; line: number | null }>();
    for (const c of allComments) {
      lineById.set(c.id, { path: c.path, line: c.line ?? c.original_line ?? c.start_line ?? null });
    }
    const reviewCommentsJson = execSync(
      `gh api repos/${repo}/pulls/${prNum}/reviews/${reviewId}/comments`,
      { timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).toString().trim();
    const reviewComments: any[] = reviewCommentsJson ? JSON.parse(reviewCommentsJson) : [];
    const filtered = botPrefix
      ? reviewComments.filter(c => !c.body?.trimStart().startsWith(botPrefix))
      : reviewComments;
    return filtered.map(c => {
      let line: number | string = c.line ?? c.original_line ?? c.start_line ?? c.position ?? '?';
      if (line === '?' && c.in_reply_to_id) {
        const parent = lineById.get(c.in_reply_to_id);
        if (parent?.line) line = parent.line;
      }
      return `${c.path}:${line} — ${c.body}`;
    }).join('\n');
  } catch {
    return '';
  }
}

function handlePullRequestReview(payload: any, config: EyeConfig, botPrefix?: string): HandlerResult {
  const review = payload.review;
  const pr = payload.pull_request;
  const repo = payload.repository?.full_name;
  if (!review || !pr || !repo) return 'missing review/pr/repo';
  if (payload.action !== 'submitted') return `action "${payload.action}" (want "submitted")`;
  const reviewer = review.user?.login;
  const prNum = pr.number;
  const state = review.state ?? 'unknown';
  const dedupKey = `review:${repo}#${prNum}:${review.id}`;
  if (isDuplicate(dedupKey)) return 'duplicate';
  const inlineComments = fetchReviewComments(repo, prNum, review.id, botPrefix);
  const priority = state === 'changes_requested' ? 4 : 1;
  const title = state === 'changes_requested'
    ? `Address review on ${repo}#${prNum}`
    : `Review ${state} on ${repo}#${prNum}`;
  const parts = [
    `${reviewer} left a ${state} review on ${repo}#${prNum} (branch: ${pr.head?.ref ?? 'unknown'}).`,
  ];
  if (review.body) parts.push(`\nReview comment:\n${review.body}`);
  if (inlineComments) parts.push(`\nInline comments:\n${inlineComments}`);
  if (state === 'changes_requested') {
    parts.push(`\nAddress the requested changes and push a fix.`);
  } else {
    parts.push(`\nReview and respond or address the comment as needed.`);
  }
  return buildJob(config, title, parts.join('\n'), priority, {
    repo, pr: String(prNum), branch: pr.head?.ref ?? '', reviewer: reviewer ?? '', review_id: String(review.id),
  });
}

async function handleIssueComment(payload: any, config: EyeConfig): Promise<HandlerResult> {
  if (payload.action !== 'created') return `action "${payload.action}" (want "created")`;
  const comment = payload.comment;
  const issue = payload.issue;
  const repo = payload.repository?.full_name;
  if (!comment || !issue || !repo) return 'missing comment/issue/repo';
  if (!issue.pull_request) return 'not a PR comment';
  const commenter = comment.user?.login;
  const prNum = issue.number;
  let branch = '';
  try {
    branch = execSync(
      `gh pr view ${prNum} --repo ${repo} --json headRefName --jq .headRefName`,
      { timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).toString().trim() || '';
  } catch (err: any) {
    console.warn(`[eye] failed to fetch PR branch for ${repo}#${prNum}:`, err.message);
  }
  const dedupKey = `comment:${repo}#${prNum}:${comment.id}`;
  if (isDuplicate(dedupKey)) return 'duplicate';
  const title = `Reply to comment on ${repo}#${prNum}`;
  const description = [
    `${commenter} commented on ${repo}#${prNum}${branch ? ` (branch: ${branch})` : ''}.`,
    `\nComment:\n${comment.body ?? '(empty)'}`,
    `\nReview and respond to the comment as needed.`,
  ].join('\n');
  return buildJob(config, title, description, 2, {
    repo, pr: String(prNum), branch, commenter: commenter ?? '', comment_id: String(comment.id),
  });
}

async function handlePullRequestMeta(payload: any, _config: EyeConfig, client: OrchestratorClient): Promise<null> {
  const pr = payload.pull_request;
  const repo = payload.repository?.full_name;
  if (!pr || !repo) return null;
  const prNum = pr.number;
  const prefix = `ci:${repo}#${prNum}:`;

  if (payload.action === 'synchronize') {
    clearDedupPrefix(prefix);
    clearReviewBuffers(`${repo}#${prNum}:`);
    clearPrUpdateBuffers(`${repo}#${prNum}`);
    clearCiFailureBuffers(`${repo}#${prNum}`);
    console.log(`[eye] reset CI dedup for ${repo}#${prNum}`);
    return null;
  }
  if (payload.action === 'converted_to_draft') {
    clearDedupPrefix(`ci:${repo}#${prNum}:`);
    clearDedupPrefix(`review:${repo}#${prNum}:`);
    clearDedupPrefix(`review-comment:${repo}#${prNum}:`);
    clearDedupPrefix(`comment:${repo}#${prNum}:`);
    clearReviewBuffers(`${repo}#${prNum}:`);
    clearPrUpdateBuffers(`${repo}#${prNum}`);
    clearCiFailureBuffers(`${repo}#${prNum}`);
    console.log(`[eye] cleaned dedup for ${repo}#${prNum} (converted to draft)`);
    return null;
  }
  if (payload.action === 'closed') {
    clearDedupPrefix(`ci:${repo}#${prNum}:`);
    clearDedupPrefix(`review:${repo}#${prNum}:`);
    clearDedupPrefix(`review-comment:${repo}#${prNum}:`);
    clearDedupPrefix(`comment:${repo}#${prNum}:`);
    clearReviewBuffers(`${repo}#${prNum}:`);
    clearPrUpdateBuffers(`${repo}#${prNum}`);
    clearCiFailureBuffers(`${repo}#${prNum}`);
    const branch = pr.head?.ref;
    const merged = pr.merged === true;
    if (branch) {
      const cleanup = await client.cleanupBranch(branch, merged);
      if (cleanup?.found) {
        console.log(`[eye] cleaned dedup + worktree for ${repo}#${prNum} (cancelled ${cleanup.cancelledJobs} jobs)`);
        return null;
      }
    }
    console.log(`[eye] cleaned dedup for ${repo}#${prNum}`);
    return null;
  }
  return null;
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────

export async function dispatch(
  eventType: string,
  payload: any,
  config: EyeConfig,
  client: OrchestratorClient,
): Promise<{ title: string; count: number } | null> {
  const repo = payload.repository?.full_name ?? '';
  const action = payload.action ?? '';
  const author = payload.sender?.login ?? '';

  if (eventType === 'pull_request') {
    return await handlePullRequestMeta(payload, config, client);
  }

  if (eventType === 'check_suite' && payload.check_suite?.conclusion === 'success') {
    checkAllSuitesPassed(payload, config).catch(err =>
      console.error('[eye] checkAllSuitesPassed error:', err)
    );
  }

  const prompts = await client.getPrompts();

  // Global filters — evaluated before handlers run. Events that don't pass are silently dropped.
  if (prompts.globalFilters.length > 0) {
    const fields = extractFilterFields(eventType, payload, config.author, prompts.botName);

    // For check_suite/check_run events the payload often lacks PR data.
    // Resolve pr_author via gh CLI so global filters like pr_author_is_self work.
    const prNum = payload.check_suite?.pull_requests?.[0]?.number
      ?? payload.check_run?.pull_requests?.[0]?.number
      ?? '';
    if ((eventType === 'check_suite' || eventType === 'check_run') && !fields['pr_author'] && repo && prNum) {
      try {
        const prAuthor = execSync(
          `gh pr view ${JSON.stringify(String(prNum))} --repo ${JSON.stringify(repo)} --json author --jq .author.login`,
          { timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] },
        ).toString().trim();
        if (prAuthor) {
          fields['pr_author'] = prAuthor;
          fields['pr_author_is_self'] = prAuthor === config.author ? 'true' : 'false';
        }
      } catch { /* gh CLI failed — leave unset */ }
    }

    if (!filtersPass(prompts.globalFilters, fields)) {
      logEvent({ ts: Date.now(), event_type: eventType, action, repo, author, decision: 'ignored', job_title: null, detail: 'rejected by global filters' });
      return null;
    }
  }

  const botPrefix = prompts.botName ? `[${prompts.botName.replace(/^\[|\]$/g, '')}]` : undefined;

  // PR Update debounce — if pr_update is enabled, buffer reviews and comments into it.
  // This runs independently of the per-event-type handling below, so users can subscribe
  // to pr_update alone, or to the individual types, or both.
  const prUpdateEnabled = !prompts.disabledEvents.includes('pr_update')
    && (prompts.eventTemplates['pr_update'] ?? []).length > 0;
  if (prUpdateEnabled && (eventType === 'pull_request_review' || eventType === 'issue_comment')) {
    const kind = eventType === 'pull_request_review' ? 'review' as const : 'comment' as const;
    const reason = bufferPrUpdate(kind, payload, config, botPrefix, client);
    logEvent({ ts: Date.now(), event_type: 'pr_update', action, repo, author, decision: 'ignored', job_title: null, detail: reason === 'debounced' ? 'debounced (waiting for more activity)' : reason });
  }

  if (prompts.disabledEvents.includes(eventType)) {
    logEvent({ ts: Date.now(), event_type: eventType, action, repo, author, decision: 'ignored', job_title: null, detail: 'event type disabled' });
    return null;
  }

  // Reviews are debounced — they bypass the normal handler→processEvent flow
  if (eventType === 'pull_request_review') {
    const reason = bufferReview(payload, config, botPrefix, client);
    if (reason === 'debounced') {
      logEvent({ ts: Date.now(), event_type: eventType, action, repo, author, decision: 'ignored', job_title: null, detail: 'debounced (waiting for more reviews)' });
    } else {
      logEvent({ ts: Date.now(), event_type: eventType, action, repo, author, decision: 'ignored', job_title: null, detail: reason });
    }
    return null;
  }

  // CI failures are debounced — multiple check_suite/check_run failures for the
  // same PR are batched into a single job.
  if (eventType === 'check_suite' || eventType === 'check_run') {
    const source = eventType === 'check_suite' ? payload.check_suite : payload.check_run;
    const conclusion = source?.conclusion ?? '';
    if (conclusion === 'failure' || conclusion === 'timed_out') {
      const reason = bufferCiFailure(eventType, payload, config, client);
      if (reason === 'debounced') {
        logEvent({ ts: Date.now(), event_type: eventType, action, repo, author, decision: 'ignored', job_title: null, detail: 'debounced (waiting for more CI results)' });
      } else {
        logEvent({ ts: Date.now(), event_type: eventType, action, repo, author, decision: 'ignored', job_title: null, detail: reason });
      }
      return null;
    }
  }

  let handlerResult: HandlerResult;
  switch (eventType) {
    case 'check_suite': handlerResult = handleCheckSuite(payload, config); break;
    case 'check_run': handlerResult = handleCheckRun(payload, config); break;
    case 'issue_comment': handlerResult = await handleIssueComment(payload, config); break;
    default:
      logEvent({ ts: Date.now(), event_type: eventType, action, repo, author, decision: 'ignored', job_title: null, detail: `unhandled event type "${eventType}"` });
      return null;
  }

  if (typeof handlerResult === 'string') {
    logEvent({ ts: Date.now(), event_type: eventType, action, repo, author, decision: 'ignored', job_title: null, detail: handlerResult });
    return null;
  }

  const result = await processEvent(client, config, eventType, payload, handlerResult);

  if (result) {
    logEvent({ ts: Date.now(), event_type: eventType, action, repo, author, decision: 'ran', job_title: result.title, detail: `count=${result.count}` });
  } else {
    logEvent({ ts: Date.now(), event_type: eventType, action, repo, author, decision: 'ignored', job_title: null, detail: 'no bindings matched filters or job creation failed' });
  }

  return result ? { title: result.title, count: result.count } : null;
}

export function getDedupStats(): { size: number } {
  return { size: seen.size };
}
