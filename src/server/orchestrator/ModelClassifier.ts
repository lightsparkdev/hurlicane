import { readFileSync } from 'fs';
import { join } from 'path';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import type { Job } from '../../shared/types.js';
import { isCodexModel } from '../../shared/types.js';
import { CircuitBreaker } from './CircuitBreaker.js';

// The model used to do the classification itself — always Haiku, cheap and fast
const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';

const COMPLEXITY_TO_MODEL: Record<string, string> = {
  simple:  'claude-haiku-4-5-20251001',
  medium:  'claude-sonnet-4-6[1m]',
  complex: 'claude-opus-4-7[1m]',
};

// ─── Rate Limit Fallback Chain ──────────────────────────────────────────────
// When a model is rate-limited, fall through to the next available model.
// Both [1m] and non-[1m] variants of a family are listed so that a job
// explicitly pinned to either variant has a defined starting index for the
// fallback loop. Family aliasing (getModelFamily) already shares rate-limit
// state across variants, so the extra entries are a no-op at lookup time.
// Codex (GPT-5.4 via OpenAI) is the final fallback — different API provider,
// so Anthropic rate limits don't affect it.
const MODEL_FALLBACK_CHAIN: string[] = [
  'claude-opus-4-7[1m]',
  'claude-opus-4-7',
  'claude-opus-4-6[1m]',
  'claude-opus-4-6',
  'claude-sonnet-4-6[1m]',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
  'codex',
];

// Canonical model list for the circuit breaker. Kept as a distinct constant
// (not derived from MODEL_FALLBACK_CHAIN) so that any model that may be
// dispatched outside the fallback chain — e.g. a classifier-only model — is
// still tracked by the breaker.
export const KNOWN_MODELS: readonly string[] = [
  'claude-opus-4-7',
  'claude-opus-4-7[1m]',
  'claude-opus-4-6',
  'claude-opus-4-6[1m]',
  'claude-sonnet-4-6',
  'claude-sonnet-4-6[1m]',
  'claude-haiku-4-5-20251001',
  'codex',
] as const;

// Module-level singleton — WorkQueueManager checks isOpen() in its tick loop;
// ModelClassifier calls record* methods as events occur.
const _circuitBreaker = new CircuitBreaker(KNOWN_MODELS);
export function getCircuitBreaker(): CircuitBreaker { return _circuitBreaker; }

const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

const _rateLimitCooldowns = new Map<string, number>();
let _codexAuthAvailable: boolean | null = null;

export type ModelProvider = 'anthropic' | 'openai' | 'unknown';

function providerCooldownKey(provider: ModelProvider): string {
  return `ratelimit:provider:${provider}`;
}

export function getModelProvider(model: string | null): ModelProvider {
  if (!model) return 'unknown';
  if (isCodexModel(model)) return 'openai';
  if (model.startsWith('claude-')) return 'anthropic';
  return 'unknown';
}

export function markProviderRateLimited(provider: ModelProvider, cooldownMs = DEFAULT_COOLDOWN_MS): void {
  if (provider === 'unknown') return;
  const expiry = Date.now() + cooldownMs;
  _rateLimitCooldowns.set(providerCooldownKey(provider), expiry);
  queries.upsertNote(providerCooldownKey(provider), String(expiry), null);
  console.log(`[classifier] marked provider ${provider} as rate-limited for ${Math.round(cooldownMs / 1000)}s (until ${new Date(expiry).toISOString()})`);
}

export function clearProviderRateLimit(provider: ModelProvider): void {
  _rateLimitCooldowns.delete(providerCooldownKey(provider));
  try { queries.upsertNote(providerCooldownKey(provider), '0', null); } catch { /* ignore */ }
}

export function isProviderRateLimited(provider: ModelProvider): boolean {
  if (provider === 'unknown') return false;
  const key = providerCooldownKey(provider);
  const memExpiry = _rateLimitCooldowns.get(key);
  if (memExpiry) {
    if (Date.now() < memExpiry) return true;
    _rateLimitCooldowns.delete(key);
  }
  const note = queries.getNote(key);
  if (note) {
    const exp = parseInt(note.value, 10);
    if (!isNaN(exp) && Date.now() < exp) {
      _rateLimitCooldowns.set(key, exp);
      return true;
    }
  }
  return false;
}

/**
 * Return the rate-limit "family" for a model. Anthropic 429 rate limits
 * (input-tokens-per-minute and prompt-bytes-per-hour) are shared across
 * context-window variants of the same underlying model, so
 * `claude-sonnet-4-6` and `claude-sonnet-4-6[1m]` hit the same bucket.
 * Treating them as independent caused fallback-chain churn where a limit
 * on one variant would immediately re-trigger on its sibling.
 */
export function getModelFamily(model: string): string {
  if (isCodexModel(model)) return 'codex';
  // Strip any `[...]` suffix — e.g. `claude-sonnet-4-6[1m]` → `claude-sonnet-4-6`.
  return model.replace(/\[[^\]]*\]$/, '');
}

function familyVariants(model: string): string[] {
  const family = getModelFamily(model);
  const siblings = KNOWN_MODELS.filter(m => getModelFamily(m) === family);
  // Always include the requested model (even if it's not in KNOWN_MODELS) so
  // callers can rate-limit custom model IDs without surprise.
  return siblings.includes(model) ? [...siblings] : [...siblings, model];
}

export function markModelRateLimited(model: string, cooldownMs = DEFAULT_COOLDOWN_MS): void {
  const expiry = Date.now() + cooldownMs;
  const variants = familyVariants(model);
  for (const m of variants) {
    _rateLimitCooldowns.set(m, expiry);
    queries.upsertNote(`ratelimit:${m}`, String(expiry), null);
    getCircuitBreaker().recordModelLimited(m);
  }
  const tail = variants.length > 1 ? ` (+${variants.length - 1} family siblings)` : '';
  console.log(`[classifier] marked ${model}${tail} as rate-limited for ${Math.round(cooldownMs / 1000)}s (until ${new Date(expiry).toISOString()})`);
}

export function clearModelRateLimit(model: string): void {
  for (const m of familyVariants(model)) {
    _rateLimitCooldowns.delete(m);
    try { queries.upsertNote(`ratelimit:${m}`, '0', null); } catch { /* ignore */ }
    getCircuitBreaker().recordModelAvailable(m);
  }
}

export function isModelRateLimited(model: string): boolean {
  if (isProviderRateLimited(getModelProvider(model))) return true;
  const memExpiry = _rateLimitCooldowns.get(model);
  if (memExpiry) {
    if (Date.now() < memExpiry) return true;
    _rateLimitCooldowns.delete(model);
    // Cooldown expired — notify circuit breaker this model is available again
    getCircuitBreaker().recordModelAvailable(model);
  }
  const note = queries.getNote(`ratelimit:${model}`);
  if (note) {
    const exp = parseInt(note.value, 10);
    if (!isNaN(exp) && Date.now() < exp) {
      _rateLimitCooldowns.set(model, exp);
      return true;
    }
    // Persisted cooldown also expired — notify breaker
    getCircuitBreaker().recordModelAvailable(model);
  }
  return false;
}

function hasCodexAuth(): boolean {
  if (_codexAuthAvailable != null) return _codexAuthAvailable;
  try {
    const auth = JSON.parse(readFileSync(join(process.env.HOME ?? '~', '.codex', 'auth.json'), 'utf8'));
    _codexAuthAvailable = !!(auth.OPENAI_API_KEY ?? auth.api_key ?? auth.tokens?.access_token);
  } catch {
    _codexAuthAvailable = false;
  }
  return _codexAuthAvailable;
}

/**
 * Given a preferred model, return the best available model that isn't
 * currently rate-limited. Falls through MODEL_FALLBACK_CHAIN in order.
 * If no model is available, returns null.
 */
export function getAvailableModel(preferredModel: string): string | null {
  if (isCodexModel(preferredModel) && !hasCodexAuth()) {
    console.log(`[classifier] ${preferredModel} unavailable — no codex API key found`);
  } else if (!isModelRateLimited(preferredModel)) {
    return preferredModel;
  }
  const idx = MODEL_FALLBACK_CHAIN.indexOf(preferredModel);
  if (idx < 0) return null;
  for (let i = idx + 1; i < MODEL_FALLBACK_CHAIN.length; i++) {
    if (isCodexModel(MODEL_FALLBACK_CHAIN[i]) && !hasCodexAuth()) continue;
    if (!isModelRateLimited(MODEL_FALLBACK_CHAIN[i])) {
      console.log(`[classifier] ${preferredModel} rate-limited → falling back to ${MODEL_FALLBACK_CHAIN[i]}`);
      return MODEL_FALLBACK_CHAIN[i];
    }
  }
  console.log(`[classifier] no available fallback model for ${preferredModel}`);
  return null;
}

/**
 * Legacy convenience wrapper: prefers a real available model, otherwise returns
 * the originally requested model so existing callers remain total functions.
 */
export function getFallbackModel(preferredModel: string): string {
  return getAvailableModel(preferredModel) ?? preferredModel;
}

/**
 * Get a model from a different provider than the given model.
 * Used when a model keeps crashing (not rate-limited, just broken) and we
 * want to try a completely different provider.
 * e.g. codex keeps failing → try claude-sonnet; claude keeps failing → try codex.
 */
export function getAlternateProviderModel(failingModel: string): string | null {
  const failingProvider = getModelProvider(failingModel);
  for (const candidate of MODEL_FALLBACK_CHAIN) {
    if (getModelProvider(candidate) !== failingProvider && !isModelRateLimited(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function getRateLimitStatus(): Array<{ model: string; rateLimited: boolean; expiresAt: number | null }> {
  return MODEL_FALLBACK_CHAIN.map(model => {
    const memExpiry = _rateLimitCooldowns.get(model);
    const noteExpiry = (() => {
      const note = queries.getNote(`ratelimit:${model}`);
      return note ? parseInt(note.value, 10) : 0;
    })();
    const provider = getModelProvider(model);
    const providerExpiry = (() => {
      if (provider === 'unknown') return 0;
      const note = queries.getNote(providerCooldownKey(provider));
      const persisted = note ? parseInt(note.value, 10) : 0;
      const inMem = _rateLimitCooldowns.get(providerCooldownKey(provider)) ?? 0;
      return Math.max(inMem, persisted);
    })();
    const expiry = Math.max(memExpiry ?? 0, noteExpiry, providerExpiry);
    const limited = expiry > Date.now();
    return { model, rateLimited: limited, expiresAt: limited ? expiry : null };
  });
}

/**
 * If the job has no model set (null), ask Haiku to classify it as
 * simple/medium/complex, then map that to haiku/sonnet/opus and persist
 * the result on the job row.
 *
 * If the selected model is rate-limited, falls through the fallback chain.
 * If ANTHROPIC_API_KEY is absent or the API call fails, falls back to sonnet.
 *
 * Returns the model string that should be passed to the agent.
 */
export async function resolveModel(job: Job): Promise<string | null> {
  // Explicit model chosen by user — respect it, but check rate limits
  if (job.model !== null) {
    const effective = getAvailableModel(job.model);
    if (effective == null) return null;
    if (effective !== job.model) {
      queries.updateJobModel(job.id, effective);
      socket.emitJobUpdate(queries.getJobById(job.id)!);
    }
    return effective;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const fallback = getAvailableModel('claude-sonnet-4-6[1m]');
    if (fallback == null) return null;
    console.warn(`[classifier] ANTHROPIC_API_KEY not set — defaulting to ${fallback}`);
    queries.updateJobModel(job.id, fallback);
    socket.emitJobUpdate(queries.getJobById(job.id)!);
    return fallback;
  }

  const prompt = buildClassifierPrompt(job);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLASSIFIER_MODEL,
        max_tokens: 5,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    clearTimeout(timeout);

    if (!response.ok) {
      if (response.status === 429 || response.status === 529) {
        markProviderRateLimited('anthropic');
        markModelRateLimited(CLASSIFIER_MODEL);
      }
      throw new Error(`Anthropic API ${response.status}: ${await response.text()}`);
    }

    const data = await response.json() as { content?: Array<{ text?: string }> };
    const word = (data.content?.[0]?.text ?? '').trim().toLowerCase();
    const complexity = (['simple', 'medium', 'complex'] as const).find(c => word.includes(c)) ?? 'medium';
    const classified = COMPLEXITY_TO_MODEL[complexity];
    const model = getAvailableModel(classified);
    if (model == null) return null;

    console.log(`[classifier] "${job.title}" → ${complexity} → ${classified}${model !== classified ? ` → ${model} (fallback)` : ''}`);

    queries.updateJobModel(job.id, model);
    socket.emitJobUpdate(queries.getJobById(job.id)!);

    return model;
  } catch (err) {
    const fallback = getAvailableModel('claude-sonnet-4-6[1m]');
    if (fallback == null) return null;
    console.error(`[classifier] failed, falling back to ${fallback}:`, err);
    queries.updateJobModel(job.id, fallback);
    socket.emitJobUpdate(queries.getJobById(job.id)!);
    return fallback;
  }
}

/**
 * Pre-load all `ratelimit:*` notes from the DB into the in-memory cooldown Map.
 * Call on server startup so that rate-limit state survives restarts without
 * waiting for a lazy DB fallback on first access.
 */
export function rehydrateCooldownState(): void {
  const notes = queries.listNotes('ratelimit:');
  let count = 0;
  const now = Date.now();
  for (const note of notes) {
    const exp = parseInt(note.value, 10);
    if (!isNaN(exp) && exp > now) {
      // Strip the 'ratelimit:' prefix for model keys, keep full key for provider keys
      const mapKey = note.key.startsWith('ratelimit:provider:')
        ? note.key  // provider keys use full 'ratelimit:provider:X' as map key
        : note.key.replace(/^ratelimit:/, '');  // model keys use just the model name
      _rateLimitCooldowns.set(mapKey, exp);
      count++;
    }
  }
  if (count > 0) {
    console.log(`[classifier] rehydrated ${count} active rate-limit cooldown(s) from DB`);
  }
}

export function _resetForTest(): void {
  _rateLimitCooldowns.clear();
  // Treat codex as auth-available in tests — avoids a disk read for ~/.codex/auth.json
  // that always returns false in CI/dev and breaks tests for codex fallback paths.
  _codexAuthAvailable = true;
}

function buildClassifierPrompt(job: Job): string {
  const desc = job.description.slice(0, 600);
  return `Classify this software task by complexity. Reply with exactly one word: simple, medium, or complex.

simple  = small, well-scoped, one file or one function (e.g. fix a typo, list files, add a log line)
medium  = moderate scope, some reasoning needed (e.g. add a feature, write tests, refactor a module)
complex = broad scope, architecture/design decisions, many files (e.g. new subsystem, large refactor)

Title: ${job.title}
Description: ${desc}`;
}
