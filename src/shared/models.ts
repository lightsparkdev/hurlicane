/**
 * Model option descriptor shared between server and client.
 */
export interface ModelOption {
  value: string;
  label: string;
}

/** Claude models available for job dispatch. */
export const CLAUDE_MODEL_OPTIONS: ModelOption[] = [
  { value: 'claude-opus-4-7[1m]',        label: 'claude-opus-4-7[1m] — most capable, 1M context (latest)' },
  { value: 'claude-opus-4-6[1m]',        label: 'claude-opus-4-6[1m] — 1M context (previous)' },
  { value: 'claude-sonnet-4-6[1m]',      label: 'claude-sonnet-4-6[1m] — balanced, 1M context' },
  { value: 'claude-haiku-4-5-20251001',  label: 'claude-haiku-4-5 — fastest, cheapest' },
];

/**
 * Fallback codex model list used when the server cannot reach the OpenAI API.
 * Update this whenever OpenAI releases a new flagship codex model.
 */
export const CODEX_MODEL_OPTIONS_FALLBACK: ModelOption[] = [
  { value: 'codex',              label: 'codex — default (gpt-5.4)' },
  { value: 'codex-gpt-5.4',     label: 'codex — gpt-5.4' },
  { value: 'codex-gpt-5.4-pro', label: 'codex — gpt-5.4-pro' },
  { value: 'codex-gpt-5.3-codex', label: 'codex — gpt-5.3-codex (previous)' },
];
