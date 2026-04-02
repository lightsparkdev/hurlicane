import { Router } from 'express';
import express from 'express';
import * as queries from '../db/queries.js';
import { verifySignature } from '../eye/signature.js';
import { dispatch, getRecentEvents, getDedupStats, startDedupCleanup, stopDedupCleanup, resetState, startMergeConflictPoll, stopMergeConflictPoll } from '../eye/handlers.js';
import { createDirectClient } from '../eye/directClient.js';
import type { EyeConfig } from '../eye/types.js';

const router = Router();

// ─── In-process Eye state ───────────────────────────────────────────────────

let eyeActive = false;
let eyeStartedAt: number | null = null;
let eventsReceived = 0;
let jobsCreated = 0;

const client = createDirectClient();

export function isEyeActive(): boolean {
  return eyeActive;
}

// ─── Config persistence ────────────────────────────────────────────────────

interface TemplateFilter {
  field: string;
  op: 'eq' | 'neq';
  value: string;
}

interface TemplateBinding {
  templateId: string;
  filters: TemplateFilter[];
}

interface EyeSettings {
  webhookSecret: string;
  author: string;
  eventTemplates: Record<string, TemplateBinding[]>;
  disabledEvents: string[];
  globalFilters: TemplateFilter[];
}

function loadSettings(): EyeSettings {
  let disabledEvents: string[] = [];
  try {
    const raw = queries.getNote('setting:eye:disabledEvents')?.value;
    if (raw) disabledEvents = JSON.parse(raw);
  } catch { /* ignore bad JSON */ }

  let eventTemplates: Record<string, TemplateBinding[]> = {};
  try {
    const raw = queries.getNote('setting:eye:eventTemplates')?.value;
    if (raw) {
      const parsed = JSON.parse(raw);
      for (const [key, val] of Object.entries(parsed)) {
        if (Array.isArray(val)) {
          eventTemplates[key] = (val as any[]).map(item => {
            if (typeof item === 'string') return { templateId: item, filters: [] };
            return item as TemplateBinding;
          });
        } else if (typeof val === 'string' && val) {
          eventTemplates[key] = [{ templateId: val, filters: [] }];
        }
      }
    }
  } catch { /* ignore bad JSON */ }

  if (Object.keys(eventTemplates).length === 0) {
    const legacyTemplateId = queries.getNote('setting:eye:templateId')?.value;
    if (legacyTemplateId) {
      const binding: TemplateBinding = { templateId: legacyTemplateId, filters: [] };
      eventTemplates = {
        check_suite: [binding],
        check_run: [binding],
        pull_request_review: [binding],
        issue_comment: [binding],
      };
    }
  }

  let globalFilters: TemplateFilter[] = [];
  try {
    const raw = queries.getNote('setting:eye:globalFilters')?.value;
    if (raw) globalFilters = JSON.parse(raw);
  } catch { /* ignore bad JSON */ }

  return {
    webhookSecret: queries.getNote('setting:eye:webhookSecret')?.value ?? '',
    author: queries.getNote('setting:eye:author')?.value ?? '',
    eventTemplates,
    disabledEvents,
    globalFilters,
  };
}

function saveSettings(settings: EyeSettings): void {
  queries.upsertNote('setting:eye:webhookSecret', settings.webhookSecret, null);
  queries.upsertNote('setting:eye:author', settings.author, null);
  queries.upsertNote('setting:eye:eventTemplates', JSON.stringify(settings.eventTemplates), null);
  queries.upsertNote('setting:eye:disabledEvents', JSON.stringify(settings.disabledEvents), null);
  queries.upsertNote('setting:eye:globalFilters', JSON.stringify(settings.globalFilters ?? []), null);
}

// ─── Webhook handler (mounted with raw body parsing) ────────────────────────

export function createWebhookHandler() {
  const webhookRouter = Router();

  webhookRouter.post(
    ['/webhook', '/github-webhook'],
    express.raw({ type: 'application/json' }),
    (req, res) => {
      if (!eyeActive) {
        res.status(503).json({ error: 'Eye is not active' });
        return;
      }

      const settings = loadSettings();
      const signature = req.headers['x-hub-signature-256'] as string | undefined;
      const rawBody = req.body as Buffer;

      if (!verifySignature(settings.webhookSecret, rawBody, signature)) {
        console.warn('[eye] invalid signature, rejecting');
        res.status(401).json({ error: 'invalid signature' });
        return;
      }

      const eventType = req.headers['x-github-event'] as string | undefined;
      if (!eventType) {
        res.status(400).json({ error: 'missing X-GitHub-Event header' });
        return;
      }

      let payload: any;
      try {
        payload = JSON.parse(rawBody.toString('utf-8'));
      } catch {
        res.status(400).json({ error: 'invalid JSON body' });
        return;
      }

      eventsReceived++;

      // Fire-and-forget: ack immediately, process async
      res.status(200).json({ ok: true, event: eventType });

      const config: EyeConfig = {
        webhookSecret: settings.webhookSecret,
        author: settings.author,
      };

      dispatch(eventType, payload, config, client).then(result => {
        if (result) {
          jobsCreated += result.count;
          console.log(`[eye] ${eventType}: ${result.title} (${result.count} job${result.count > 1 ? 's' : ''})`);
        }
      }).catch(err => {
        console.error(`[eye] error processing ${eventType}:`, err);
      });
    }
  );

  return webhookRouter;
}

// ─── API Routes ─────────────────────────────────────────────────────────────

// GET /api/eye — return saved config + state
router.get('/', (_req, res) => {
  const settings = loadSettings();
  res.json({
    settings,
    running: eyeActive,
  });
});

// PUT /api/eye — save config
router.put('/', (req, res) => {
  const { webhookSecret, author, eventTemplates, disabledEvents, globalFilters } = req.body;
  const settings: EyeSettings = {
    webhookSecret: String(webhookSecret ?? ''),
    author: String(author ?? ''),
    eventTemplates: (eventTemplates && typeof eventTemplates === 'object') ? eventTemplates : {},
    disabledEvents: Array.isArray(disabledEvents) ? disabledEvents : [],
    globalFilters: Array.isArray(globalFilters) ? globalFilters : [],
  };
  saveSettings(settings);
  res.json({ settings });
});

// GET /api/eye/prompts — return templateId + disabled events
router.get('/prompts', (_req, res) => {
  const settings = loadSettings();
  res.json({
    eventTemplates: settings.eventTemplates,
    disabledEvents: settings.disabledEvents,
    globalFilters: settings.globalFilters,
    botName: queries.getNote('setting:botName')?.value ?? '',
  });
});

// POST /api/eye/start — activate Eye webhook handling
router.post('/start', (_req, res) => {
  if (eyeActive) {
    res.status(409).json({ error: 'Eye is already running' });
    return;
  }

  const settings = loadSettings();
  if (!settings.webhookSecret) {
    res.status(400).json({ error: 'Webhook secret is required. Configure it first.' });
    return;
  }
  if (!settings.author) {
    res.status(400).json({ error: 'Author is required. Configure it first.' });
    return;
  }

  eyeActive = true;
  eyeStartedAt = Date.now();
  eventsReceived = 0;
  jobsCreated = 0;
  resetState();
  startDedupCleanup();
  startMergeConflictPoll(
    { webhookSecret: settings.webhookSecret, author: settings.author },
    client,
  );

  console.log(`[eye] activated (author: ${settings.author})`);
  res.json({ ok: true });
});

// POST /api/eye/stop — deactivate Eye webhook handling
router.post('/stop', (_req, res) => {
  if (!eyeActive) {
    res.json({ ok: true, message: 'Eye was not running' });
    return;
  }

  eyeActive = false;
  stopDedupCleanup();
  stopMergeConflictPoll();
  console.log('[eye] deactivated');
  res.json({ ok: true });
});

// GET /api/eye/status — return in-process status (no proxy needed)
router.get('/status', (_req, res) => {
  if (!eyeActive) {
    res.status(502).json({ error: 'Eye is not active' });
    return;
  }

  const settings = loadSettings();
  res.json({
    uptime_ms: eyeStartedAt ? Date.now() - eyeStartedAt : 0,
    events_received: eventsReceived,
    jobs_created: jobsCreated,
    dedup: getDedupStats(),
    recent_events: getRecentEvents(),
    config: {
      author: settings.author,
      orchestratorUrl: '(in-process)',
    },
  });
});

// GET /api/eye/logs — no longer needed (logs go to stdout), but keep for compat
router.get('/logs', (_req, res) => {
  res.json({ logs: [] });
});

// ─── Exported for shutdown ──────────────────────────────────────────────────

export function stopEye(): void {
  if (eyeActive) {
    eyeActive = false;
    stopDedupCleanup();
    stopMergeConflictPoll();
  }
}

export default router;
