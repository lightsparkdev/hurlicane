// @ts-ignore — node:sqlite is experimental in Node ≥22 and has no @types yet
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!_db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return _db;
}

export function initDb(dbPath: string): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);

  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  db.exec(schema);

  // Additive migrations — safe to run repeatedly
  const jobCols: string[] = (db.prepare('PRAGMA table_info(jobs)').all() as any[]).map((r: any) => r.name);
  if (!jobCols.includes('model')) {
    db.exec('ALTER TABLE jobs ADD COLUMN model TEXT');
  }
  if (!jobCols.includes('template_id')) {
    db.exec('ALTER TABLE jobs ADD COLUMN template_id TEXT REFERENCES templates(id)');
  }
  if (!jobCols.includes('flagged')) {
    db.exec('ALTER TABLE jobs ADD COLUMN flagged INTEGER NOT NULL DEFAULT 0');
  }
  if (!jobCols.includes('depends_on')) {
    db.exec('ALTER TABLE jobs ADD COLUMN depends_on TEXT');
  }
  if (!jobCols.includes('is_interactive')) {
    db.exec('ALTER TABLE jobs ADD COLUMN is_interactive INTEGER NOT NULL DEFAULT 0');
  }
  if (!jobCols.includes('use_worktree')) {
    db.exec('ALTER TABLE jobs ADD COLUMN use_worktree INTEGER NOT NULL DEFAULT 0');
  }
  if (!jobCols.includes('archived_at')) {
    db.exec('ALTER TABLE jobs ADD COLUMN archived_at INTEGER');
  }

  // Projects table
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    )
  `);

  if (!jobCols.includes('project_id')) {
    db.exec('ALTER TABLE jobs ADD COLUMN project_id TEXT REFERENCES projects(id)');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_archived ON jobs(archived_at)');

  const agentCols: string[] = (db.prepare('PRAGMA table_info(agents)').all() as any[]).map((r: any) => r.name);
  if (!agentCols.includes('parent_agent_id')) {
    db.exec('ALTER TABLE agents ADD COLUMN parent_agent_id TEXT');
  }
  if (!agentCols.includes('base_sha')) {
    db.exec('ALTER TABLE agents ADD COLUMN base_sha TEXT');
  }
  if (!agentCols.includes('diff')) {
    db.exec('ALTER TABLE agents ADD COLUMN diff TEXT');
  }
  if (!agentCols.includes('cost_usd')) {
    db.exec('ALTER TABLE agents ADD COLUMN cost_usd REAL');
  }
  if (!agentCols.includes('duration_ms')) {
    db.exec('ALTER TABLE agents ADD COLUMN duration_ms INTEGER');
  }
  if (!agentCols.includes('num_turns')) {
    db.exec('ALTER TABLE agents ADD COLUMN num_turns INTEGER');
  }
  if (!agentCols.includes('pending_wait_ids')) {
    db.exec('ALTER TABLE agents ADD COLUMN pending_wait_ids TEXT');
  }

  // FTS5 virtual table for full-text search across agent output
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS output_fts USING fts5(
      text_content,
      agent_id UNINDEXED
    )
  `);

  const tplCols: string[] = (db.prepare('PRAGMA table_info(templates)').all() as any[]).map((r: any) => r.name);
  if (!tplCols.includes('work_dir')) {
    db.exec('ALTER TABLE templates ADD COLUMN work_dir TEXT');
  }
  if (!tplCols.includes('model')) {
    db.exec('ALTER TABLE templates ADD COLUMN model TEXT');
  }

  // Batch templates
  db.exec(`
    CREATE TABLE IF NOT EXISTS batch_templates (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      items      TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Notes (shared scratchpad across all agents)
  const notesCols: string[] = (db.prepare('PRAGMA table_info(notes)').all() as any[]).map((r: any) => r.name);
  if (notesCols.length === 0) {
    db.exec(`
      CREATE TABLE notes (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        agent_id   TEXT,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  // Debates table
  db.exec(`
    CREATE TABLE IF NOT EXISTS debates (
      id            TEXT PRIMARY KEY,
      title         TEXT NOT NULL,
      task          TEXT NOT NULL,
      claude_model  TEXT NOT NULL,
      codex_model   TEXT NOT NULL,
      max_rounds    INTEGER NOT NULL DEFAULT 3,
      current_round INTEGER NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'running',
      consensus     TEXT,
      project_id    TEXT NOT NULL REFERENCES projects(id),
      work_dir      TEXT,
      max_turns     INTEGER NOT NULL DEFAULT 50,
      template_id   TEXT REFERENCES templates(id),
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    )
  `);

  // Debate columns on jobs
  if (!jobCols.includes('debate_id')) {
    db.exec('ALTER TABLE jobs ADD COLUMN debate_id TEXT REFERENCES debates(id)');
  }
  if (!jobCols.includes('debate_loop')) {
    db.exec('ALTER TABLE jobs ADD COLUMN debate_loop INTEGER');
  }
  if (!jobCols.includes('debate_round')) {
    db.exec('ALTER TABLE jobs ADD COLUMN debate_round INTEGER');
  }
  if (!jobCols.includes('debate_role')) {
    db.exec('ALTER TABLE jobs ADD COLUMN debate_role TEXT');
  }
  if (!jobCols.includes('scheduled_at')) {
    db.exec('ALTER TABLE jobs ADD COLUMN scheduled_at INTEGER');
  }
  if (!jobCols.includes('repeat_interval_ms')) {
    db.exec('ALTER TABLE jobs ADD COLUMN repeat_interval_ms INTEGER');
  }
  if (!jobCols.includes('retry_policy')) {
    db.exec("ALTER TABLE jobs ADD COLUMN retry_policy TEXT NOT NULL DEFAULT 'none'");
  }
  if (!jobCols.includes('max_retries')) {
    db.exec('ALTER TABLE jobs ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 0');
  }
  if (!jobCols.includes('retry_count')) {
    db.exec('ALTER TABLE jobs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0');
  }
  if (!jobCols.includes('original_job_id')) {
    db.exec('ALTER TABLE jobs ADD COLUMN original_job_id TEXT');
  }
  if (!jobCols.includes('completion_checks')) {
    db.exec('ALTER TABLE jobs ADD COLUMN completion_checks TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_debate ON jobs(debate_id, debate_round)');

  // Post-debate action columns
  const debateCols: string[] = (db.prepare('PRAGMA table_info(debates)').all() as any[]).map((r: any) => r.name);
  if (!debateCols.includes('post_action_prompt')) {
    db.exec('ALTER TABLE debates ADD COLUMN post_action_prompt TEXT');
  }
  if (!debateCols.includes('post_action_role')) {
    db.exec('ALTER TABLE debates ADD COLUMN post_action_role TEXT');
  }
  if (!debateCols.includes('post_action_job_id')) {
    db.exec('ALTER TABLE debates ADD COLUMN post_action_job_id TEXT');
  }
  if (!debateCols.includes('post_action_verification')) {
    db.exec('ALTER TABLE debates ADD COLUMN post_action_verification INTEGER NOT NULL DEFAULT 0');
  }
  if (!debateCols.includes('verification_review_job_id')) {
    db.exec('ALTER TABLE debates ADD COLUMN verification_review_job_id TEXT');
  }
  if (!debateCols.includes('verification_response_job_id')) {
    db.exec('ALTER TABLE debates ADD COLUMN verification_response_job_id TEXT');
  }
  if (!debateCols.includes('verification_round')) {
    db.exec('ALTER TABLE debates ADD COLUMN verification_round INTEGER NOT NULL DEFAULT 0');
  }
  if (!debateCols.includes('loop_count')) {
    db.exec('ALTER TABLE debates ADD COLUMN loop_count INTEGER NOT NULL DEFAULT 1');
  }
  if (!debateCols.includes('current_loop')) {
    db.exec('ALTER TABLE debates ADD COLUMN current_loop INTEGER NOT NULL DEFAULT 0');
  }

  // ── Feature 6: Agent Health Monitoring ──────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_warnings (
      id         TEXT PRIMARY KEY,
      agent_id   TEXT NOT NULL,
      type       TEXT NOT NULL,
      message    TEXT NOT NULL,
      dismissed  INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_agent_warnings_agent ON agent_warnings(agent_id, dismissed)');

  // ── Feature 4: Worktree Cleanup ───────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS worktrees (
      id         TEXT PRIMARY KEY,
      agent_id   TEXT NOT NULL,
      job_id     TEXT NOT NULL,
      path       TEXT NOT NULL,
      branch     TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      cleaned_at INTEGER
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_worktrees_job ON worktrees(job_id)');

  // ── Feature 1: Mid-Task Nudge ─────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS nudges (
      id           TEXT PRIMARY KEY,
      agent_id     TEXT NOT NULL,
      message      TEXT NOT NULL,
      delivered    INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL,
      delivered_at INTEGER
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_nudges_agent ON nudges(agent_id, delivered)');

  // ── Feature 5: Knowledge Base ─────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_base (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL,
      content    TEXT NOT NULL,
      tags       TEXT,
      source     TEXT,
      agent_id   TEXT,
      project_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(
      title,
      content,
      kb_id UNINDEXED
    )
  `);

  // last_hit_at column on knowledge_base — tracks when entries are actually matched/used
  const kbCols: string[] = (db.prepare('PRAGMA table_info(knowledge_base)').all() as any[]).map((r: any) => r.name);
  if (!kbCols.includes('last_hit_at')) {
    db.exec('ALTER TABLE knowledge_base ADD COLUMN last_hit_at INTEGER');
  }

  // ── Feature 3: Multi-Model Review Pipeline ────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS reviews (
      id              TEXT PRIMARY KEY,
      parent_job_id   TEXT NOT NULL,
      reviewer_job_id TEXT,
      model           TEXT NOT NULL,
      verdict         TEXT,
      summary         TEXT,
      created_at      INTEGER NOT NULL,
      completed_at    INTEGER
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_reviews_parent ON reviews(parent_job_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_reviews_reviewer ON reviews(reviewer_job_id)');

  if (!jobCols.includes('review_config')) {
    db.exec('ALTER TABLE jobs ADD COLUMN review_config TEXT');
  }
  if (!jobCols.includes('review_status')) {
    db.exec('ALTER TABLE jobs ADD COLUMN review_status TEXT');
  }
  if (!jobCols.includes('review_parent_job_id')) {
    db.exec('ALTER TABLE jobs ADD COLUMN review_parent_job_id TEXT');
  }
  if (!jobCols.includes('created_by_agent_id')) {
    db.exec('ALTER TABLE jobs ADD COLUMN created_by_agent_id TEXT');
  }
  if (!jobCols.includes('pre_debate_id')) {
    db.exec('ALTER TABLE jobs ADD COLUMN pre_debate_id TEXT REFERENCES debates(id)');
  }
  if (!jobCols.includes('pre_debate_summary')) {
    db.exec('ALTER TABLE jobs ADD COLUMN pre_debate_summary TEXT');
  }

  // ── Eye: Discussions ───────────────────────────────────────────────────────
  db.exec(`CREATE TABLE IF NOT EXISTS discussions (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, topic TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'question', priority TEXT NOT NULL DEFAULT 'medium',
    context TEXT, status TEXT NOT NULL DEFAULT 'open',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_discussions_status ON discussions(status)');
  db.exec(`CREATE TABLE IF NOT EXISTS discussion_messages (
    id TEXT PRIMARY KEY, discussion_id TEXT NOT NULL REFERENCES discussions(id),
    role TEXT NOT NULL, content TEXT NOT NULL, requires_reply INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_disc_msgs_discussion ON discussion_messages(discussion_id)');
  // Migration: add requires_reply to existing discussion_messages tables
  const discMsgCols: string[] = (db.prepare('PRAGMA table_info(discussion_messages)').all() as any[]).map((r: any) => r.name);
  if (!discMsgCols.includes('requires_reply')) {
    db.exec('ALTER TABLE discussion_messages ADD COLUMN requires_reply INTEGER NOT NULL DEFAULT 1');
  }

  // ── Eye: Proposals ────────────────────────────────────────────────────────
  db.exec(`CREATE TABLE IF NOT EXISTS proposals (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, title TEXT NOT NULL,
    summary TEXT NOT NULL, rationale TEXT NOT NULL, confidence REAL NOT NULL,
    estimated_complexity TEXT NOT NULL, category TEXT NOT NULL,
    evidence TEXT, implementation_plan TEXT,
    status TEXT NOT NULL DEFAULT 'pending', execution_job_id TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status)');

  const proposalCols: string[] = (db.prepare('PRAGMA table_info(proposals)').all() as any[]).map((r: any) => r.name);
  if (!proposalCols.includes('codex_confirmed')) {
    db.exec('ALTER TABLE proposals ADD COLUMN codex_confirmed INTEGER');
  }
  if (!proposalCols.includes('codex_confidence')) {
    db.exec('ALTER TABLE proposals ADD COLUMN codex_confidence REAL');
  }
  if (!proposalCols.includes('codex_reasoning')) {
    db.exec('ALTER TABLE proposals ADD COLUMN codex_reasoning TEXT');
  }
  db.exec(`CREATE TABLE IF NOT EXISTS proposal_messages (
    id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL REFERENCES proposals(id),
    role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_prop_msgs_proposal ON proposal_messages(proposal_id)');

  // ── Eye: PR Reviews ────────────────────────────────────────────────────────
  db.exec(`CREATE TABLE IF NOT EXISTS pr_reviews (
    id TEXT PRIMARY KEY, pr_number INTEGER NOT NULL, pr_url TEXT NOT NULL,
    pr_title TEXT NOT NULL, pr_author TEXT, repo TEXT NOT NULL,
    summary TEXT NOT NULL, comments TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'draft',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_pr_reviews_status ON pr_reviews(status)');
  // Migration: add github_review_id if not present
  try { db.exec('ALTER TABLE pr_reviews ADD COLUMN github_review_id TEXT'); } catch { /* already exists */ }

  db.exec(`CREATE TABLE IF NOT EXISTS pr_review_messages (
    id TEXT PRIMARY KEY, review_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL, created_at INTEGER NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_pr_review_msgs_review ON pr_review_messages(review_id)');

  // ── Performance indexes ────────────────────────────────────────────────────
  db.exec('CREATE INDEX IF NOT EXISTS idx_agents_job_id ON agents(job_id)');
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_context_eye ON jobs(status) WHERE json_extract(context, '$.eye') = 1");

  _db = db;
  return db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
