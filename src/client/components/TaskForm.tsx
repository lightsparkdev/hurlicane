import React, { useState, useEffect, useMemo } from 'react';
import type { CreateTaskRequest, TaskPreset, Template, RetryPolicy, StopMode, Job } from '@shared/types';
import { TemplateModelStats } from './TemplateModelStats';
import { StopModePicker } from './StopModePicker';
import { useModels } from '../hooks/useModels';

interface TaskFormProps {
  onSubmit: (req: CreateTaskRequest) => Promise<void>;
  onClose: () => void;
  availableJobs?: Job[];
}

const PRESET_LABELS: Record<TaskPreset, string> = {
  quick: 'Quick',
  reviewed: 'Reviewed',
  autonomous: 'Autonomous',
};

const PRESET_DESCRIPTIONS: Record<TaskPreset, string> = {
  quick: 'Single-pass job, no review',
  reviewed: 'Single-pass job with review',
  autonomous: 'Multi-cycle assess/review/implement',
};

export function TaskForm({ onSubmit, onClose, availableJobs = [] }: TaskFormProps) {
  const { claude: claudeModels, codex: codexModels } = useModels();

  // ── Preset ────────────────────────────────────────────────────────────────
  const [preset, setPreset] = useState<TaskPreset>('quick');

  // ── Core fields ───────────────────────────────────────────────────────────
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [workDir, setWorkDir] = useState('');
  const [model, setModel] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [templates, setTemplates] = useState<Template[]>([]);

  // ── Complexity dial ───────────────────────────────────────────────────────
  const [review, setReview] = useState(false);
  const [reviewerModel, setReviewerModel] = useState('codex');
  const [iterations, setIterations] = useState(1);
  const [useWorktree, setUseWorktree] = useState(false);

  // ── Job-only: stopping, scheduling, retry ─────────────────────────────────
  const [stopMode, setStopMode] = useState<StopMode>('completion');
  const [stopValue, setStopValue] = useState<number | null>(null);
  const [maxTurns, _setMaxTurns] = useState<number | ''>('');
  const [priority, setPriority] = useState(0);
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const [interactive, setInteractive] = useState(true);
  const [repeatSeconds, setRepeatSeconds] = useState<number | ''>('');
  const [retryPolicy, setRetryPolicy] = useState<RetryPolicy>('none');
  const [maxRetries, setMaxRetries] = useState(3);
  const [checkDiffNotEmpty, setCheckDiffNotEmpty] = useState(false);
  const [checkNoErrors, setCheckNoErrors] = useState(false);
  const [customCheckCmd, setCustomCheckCmd] = useState('');

  // ── Job-only: review config (for reviewed preset) ─────────────────────────
  const [reviewModels, setReviewModels] = useState<string[]>([]);
  const [reviewAuto, setReviewAuto] = useState(true);

  // ── Job-only: debate ──────────────────────────────────────────────────────
  const [debateEnabled, setDebateEnabled] = useState(false);
  const [debateClaudeModel, setDebateClaudeModel] = useState('claude-sonnet-4-6[1m]');
  const [debateCodexModel, setDebateCodexModel] = useState('codex');
  const [debateMaxRounds, setDebateMaxRounds] = useState(3);

  // ── Workflow-only: per-phase stops ────────────────────────────────────────
  const [stopModeAssess, setStopModeAssess] = useState<StopMode>('turns');
  const [stopValueAssess, setStopValueAssess] = useState<number | null>(50);
  const [stopModeReview, setStopModeReview] = useState<StopMode>('turns');
  const [stopValueReview, setStopValueReview] = useState<number | null>(30);
  const [stopModeImplement, setStopModeImplement] = useState<StopMode>('turns');
  const [stopValueImplement, setStopValueImplement] = useState<number | null>(100);

  // ── Workflow-only: start command (for verify agent) ──────────────────────
  const [verifyEnabled, setVerifyEnabled] = useState(true);
  const [startCommand, setStartCommand] = useState<string>('npm run dev');

  // ── UI state ──────────────────────────────────────────────────────────────
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Derived routing ───────────────────────────────────────────────────────
  const routesTo = iterations > 1 ? 'workflow' : 'job';

  const pendingJobs = availableJobs.filter(
    j => j.status === 'queued' || j.status === 'assigned' || j.status === 'running'
  );

  // ── Template loading ──────────────────────────────────────────────────────
  useEffect(() => {
    fetch('/api/templates').then(r => r.json()).then(setTemplates).catch(console.error);
  }, []);

  const selectedTemplate = useMemo(
    () => templates.find(t => t.id === templateId) ?? null,
    [templates, templateId],
  );

  // ── Preset application ────────────────────────────────────────────────────
  const applyPreset = (p: TaskPreset) => {
    setPreset(p);
    switch (p) {
      case 'quick':
        setReview(false);
        setIterations(1);
        setUseWorktree(false);
        setInteractive(true);
        break;
      case 'reviewed':
        setReview(true);
        setIterations(1);
        setUseWorktree(true);
        break;
      case 'autonomous':
        setReview(true);
        setIterations(10);
        setUseWorktree(true);
        setInteractive(false);
        break;
    }
  };

  const handleTemplateChange = (newTemplateId: string) => {
    setTemplateId(newTemplateId);
    const tpl = templates.find(t => t.id === newTemplateId);
    if (tpl?.work_dir) setWorkDir(tpl.work_dir);
    if (tpl?.model) setModel(tpl.model);
  };

  const toggleDepend = (id: string) => {
    setDependsOn(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  // ── Submit ────────────────────────────────────────────────────────────────
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!description.trim() && !templateId) return;
    setLoading(true);
    setError(null);

    try {
      const req: CreateTaskRequest = {
        description: description.trim(),
        title: title.trim() || undefined,
        preset,
        model: model.trim() || undefined,
        workDir: workDir.trim() || undefined,
        templateId: templateId || undefined,
        review,
        iterations,
        useWorktree: useWorktree || undefined,
      };

      if (routesTo === 'job') {
        // Job-specific fields
        req.reviewerModel = review ? (reviewerModel || undefined) : undefined;
        req.stopMode = stopMode;
        req.stopValue = stopValue ?? undefined;
        req.maxTurns = maxTurns ? Number(maxTurns) : undefined;
        req.priority = priority || undefined;
        req.dependsOn = dependsOn.length > 0 ? dependsOn : undefined;
        req.interactive = interactive || undefined;
        req.repeatIntervalMs = repeatSeconds ? (repeatSeconds as number) * 1000 : undefined;
        req.retryPolicy = retryPolicy !== 'none' ? retryPolicy : undefined;
        req.maxRetries = retryPolicy !== 'none' ? maxRetries : undefined;

        const completionChecks: string[] = [];
        if (checkDiffNotEmpty) completionChecks.push('diff_not_empty');
        if (checkNoErrors) completionChecks.push('no_error_in_output');
        if (customCheckCmd.trim()) completionChecks.push(`custom_command:${customCheckCmd.trim()}`);
        if (completionChecks.length > 0) req.completionChecks = completionChecks;

        if (review && reviewModels.length > 0) {
          req.reviewConfig = { models: reviewModels, auto: reviewAuto };
        }

        if (debateEnabled) {
          req.debate = true;
          req.debateClaudeModel = debateClaudeModel;
          req.debateCodexModel = debateCodexModel;
          req.debateMaxRounds = debateMaxRounds;
        }
      } else {
        // Workflow-specific fields
        req.reviewerModel = reviewerModel || undefined;
        req.stopModeAssess = stopModeAssess;
        req.stopValueAssess = stopValueAssess ?? undefined;
        req.stopModeReview = stopModeReview;
        req.stopValueReview = stopValueReview ?? undefined;
        req.stopModeImplement = stopModeImplement;
        req.stopValueImplement = stopValueImplement ?? undefined;
        req.startCommand = verifyEnabled && startCommand.trim() ? startCommand.trim() : undefined;
      }

      await onSubmit(req);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create task');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>New Task</h2>
          <button className="btn-icon" onClick={onClose}>&#x2715;</button>
        </div>
        <form onSubmit={handleSubmit} className="job-form">
          {/* ── Preset strip ─────────────────────────────────────────── */}
          <div className="form-group">
            <label>Preset</label>
            <div className="stop-mode-buttons">
              {(['quick', 'reviewed', 'autonomous'] as TaskPreset[]).map(p => (
                <button
                  key={p}
                  type="button"
                  className={`stop-mode-btn${preset === p ? ' active' : ''}`}
                  onClick={() => applyPreset(p)}
                  title={PRESET_DESCRIPTIONS[p]}
                >
                  {PRESET_LABELS[p]}
                </button>
              ))}
            </div>
            <span className="form-label-hint" style={{ marginTop: 4, display: 'block' }}>
              {PRESET_DESCRIPTIONS[preset]} {routesTo === 'workflow' ? '(workflow)' : '(job)'}
            </span>
          </div>

          {/* ── Title ────────────────────────────────────────────────── */}
          <div className="form-group">
            <label htmlFor="task-title">Title <span className="form-label-hint">(optional, auto-generated if blank)</span></label>
            <input
              id="task-title"
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Leave blank to auto-generate from description"
              autoFocus
            />
          </div>

          {/* ── Template ─────────────────────────────────────────────── */}
          <div className="form-group">
            <label htmlFor="task-template">Template <span className="form-label-hint">(optional)</span></label>
            <select id="task-template" value={templateId} onChange={e => handleTemplateChange(e.target.value)}>
              <option value="">None</option>
              {templates.map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            {selectedTemplate && (
              <div className="template-preview">
                {selectedTemplate.content.slice(0, 200)}
                {selectedTemplate.content.length > 200 ? '...' : ''}
              </div>
            )}
          </div>

          {/* ── Description ──────────────────────────────────────────── */}
          <div className="form-group">
            <label htmlFor="task-description">
              Task Description
              {templateId && routesTo === 'job' && <span className="form-label-hint"> (optional when template is provided)</span>}
              {routesTo === 'workflow' && <span className="form-label-hint"> (required for autonomous tasks)</span>}
            </label>
            <textarea
              id="task-description"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder={
                routesTo === 'workflow'
                  ? 'Describe what the agents should accomplish across multiple cycles...'
                  : templateId
                    ? 'Additional instructions (optional)...'
                    : 'Detailed instructions for the agent...'
              }
              rows={5}
              required={routesTo === 'workflow' || !templateId}
            />
          </div>

          {/* ── Working directory + model ─────────────────────────────── */}
          <div className="form-group">
            <label htmlFor="task-workdir">Working Directory</label>
            <input
              id="task-workdir"
              type="text"
              value={workDir}
              onChange={e => setWorkDir(e.target.value)}
              placeholder="/path/to/project (optional)"
            />
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="task-model">
                {routesTo === 'workflow' ? 'Implementer Model' : 'Model'}
                <span className="form-label-hint"> (leave blank to auto-select)</span>
              </label>
              <select id="task-model" value={model} onChange={e => setModel(e.target.value)}>
                <option value="">{routesTo === 'workflow' ? 'Default (Sonnet)' : 'Auto-select (Haiku classifies)'}</option>
                {claudeModels.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                {routesTo === 'job' && codexModels.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
            {review && (
              <div className="form-group">
                <label htmlFor="task-reviewer">Reviewer Model</label>
                <select id="task-reviewer" value={reviewerModel} onChange={e => setReviewerModel(e.target.value)}>
                  {codexModels.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                  {claudeModels.map(m => <option key={`c-${m.value}`} value={m.value}>{m.label}</option>)}
                </select>
              </div>
            )}
          </div>

          <TemplateModelStats templateId={templateId} model={model} />

          {/* ── Review toggle ────────────────────────────────────────── */}
          <div className="form-group">
            <label className="form-checkbox-label">
              <input
                type="checkbox"
                checked={review}
                onChange={e => setReview(e.target.checked)}
                disabled={routesTo === 'workflow'}
              />
              Review on completion
              {routesTo === 'workflow' && <span className="form-label-hint"> (always on for workflows)</span>}
            </label>
          </div>

          {/* ── Iterations + worktree ────────────────────────────────── */}
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="task-iterations">
                Iterations
                <span className="tooltip-icon" data-tip="1 = single-pass job. >1 = multi-cycle autonomous workflow with assess/review/implement phases.">?</span>
              </label>
              <input
                id="task-iterations"
                type="number"
                min={1}
                max={50}
                value={iterations}
                onChange={e => {
                  const v = parseInt(e.target.value, 10);
                  const n = Number.isNaN(v) || v < 1 ? 1 : Math.min(v, 50);
                  setIterations(n);
                  if (n > 1) {
                    setReview(true);
                    setUseWorktree(true);
                  }
                }}
              />
            </div>
            <div className="form-group">
              <label className="form-checkbox-label" style={{ marginTop: 22 }}>
                <input
                  type="checkbox"
                  checked={useWorktree}
                  onChange={e => setUseWorktree(e.target.checked)}
                />
                Use worktree
                <span className="tooltip-icon" data-tip="Creates a git worktree so the agent works in an isolated checkout on a new branch">?</span>
              </label>
            </div>
          </div>

          {/* ── Job-only: review config (when review enabled on job route) */}
          {routesTo === 'job' && review && (
            <div className="form-group" style={{ paddingLeft: 20 }}>
              <label>Review Models</label>
              <div className="completion-checks-list">
                {[
                  { value: 'claude-haiku-4-5-20251001', label: 'Haiku' },
                  { value: 'claude-sonnet-4-6[1m]', label: 'Sonnet' },
                  { value: 'claude-opus-4-7[1m]', label: 'Opus' },
                ].map(m => (
                  <label key={m.value} className="form-checkbox-label">
                    <input
                      type="checkbox"
                      checked={reviewModels.includes(m.value)}
                      onChange={e => setReviewModels(prev =>
                        e.target.checked ? [...prev, m.value] : prev.filter(x => x !== m.value)
                      )}
                    />
                    {m.label}
                  </label>
                ))}
              </div>
              <label className="form-checkbox-label" style={{ marginTop: 8 }}>
                <input
                  type="checkbox"
                  checked={reviewAuto}
                  onChange={e => setReviewAuto(e.target.checked)}
                />
                Auto-trigger reviews
              </label>
            </div>
          )}

          {/* ── Job-only advanced section ─────────────────────────────── */}
          {routesTo === 'job' && (
            <>
              <button
                type="button"
                className="btn btn-ghost"
                style={{ fontSize: 12, padding: '4px 0', marginBottom: 8 }}
                onClick={() => setShowAdvanced(v => !v)}
              >
                {showAdvanced ? '\u25be' : '\u25b8'} Advanced settings
              </button>

              {showAdvanced && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {priority !== undefined && (
                    <div className="form-group form-group-sm">
                      <label htmlFor="task-priority">
                        Priority
                        <span className="tooltip-icon" data-tip="Controls dispatch order when multiple jobs are waiting. Higher = started sooner (range: -10 to 10).">?</span>
                      </label>
                      <input
                        id="task-priority"
                        type="number"
                        value={priority}
                        onChange={e => setPriority(Number(e.target.value))}
                        min={-10}
                        max={10}
                      />
                    </div>
                  )}

                  {pendingJobs.length > 0 && (
                    <div className="form-group">
                      <label>
                        Depends On <span className="form-label-hint">(job won't start until selected jobs finish)</span>
                      </label>
                      <div className="depends-on-list">
                        {pendingJobs.map(j => (
                          <label key={j.id} className="depends-on-item">
                            <input
                              type="checkbox"
                              checked={dependsOn.includes(j.id)}
                              onChange={() => toggleDepend(j.id)}
                            />
                            <span className={`depends-on-status status-${j.status}`}>{j.status}</span>
                            <span className="depends-on-title">{j.title}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="form-group">
                    <label className="form-checkbox-label">
                      <input
                        type="checkbox"
                        checked={interactive}
                        onChange={e => setInteractive(e.target.checked)}
                      />
                      Interactive session
                      <span className="tooltip-icon" data-tip="Keeps terminal open for direct conversation">?</span>
                    </label>
                  </div>

                  <StopModePicker
                    label="Stopping condition"
                    mode={stopMode}
                    value={stopValue}
                    onModeChange={setStopMode}
                    onValueChange={setStopValue}
                  />

                  <div className="form-group">
                    <label htmlFor="task-repeat">
                      Repeat every
                      <span className="tooltip-icon" data-tip="After the job completes, automatically re-queue it after this many seconds. Leave blank for no repeat.">?</span>
                    </label>
                    <div className="repeat-input-row">
                      <input
                        id="task-repeat"
                        type="number"
                        value={repeatSeconds}
                        onChange={e => setRepeatSeconds(e.target.value === '' ? '' : Number(e.target.value))}
                        placeholder="no repeat"
                        min={1}
                      />
                      <span className="repeat-unit">seconds</span>
                    </div>
                  </div>

                  <div className="form-row">
                    <div className="form-group">
                      <label htmlFor="task-retry">
                        On Failure
                        <span className="tooltip-icon" data-tip="What to do when the agent fails. 'Retry same' re-queues the identical task. 'Analyze & retry' spawns a lightweight agent to diagnose the failure and create a refined retry.">?</span>
                      </label>
                      <select
                        id="task-retry"
                        value={retryPolicy}
                        onChange={e => setRetryPolicy(e.target.value as RetryPolicy)}
                      >
                        <option value="none">No retry</option>
                        <option value="same">Retry same</option>
                        <option value="analyze">Analyze & retry</option>
                      </select>
                    </div>
                    {retryPolicy !== 'none' && (
                      <div className="form-group form-group-sm">
                        <label htmlFor="task-max-retries">Max Retries</label>
                        <input
                          id="task-max-retries"
                          type="number"
                          value={maxRetries}
                          onChange={e => setMaxRetries(Number(e.target.value))}
                          min={1}
                          max={10}
                        />
                      </div>
                    )}
                  </div>

                  <div className="form-group">
                    <label>
                      Completion Checks
                      <span className="tooltip-icon" data-tip="Validate agent output before accepting 'done'. Failed checks convert the job to 'failed' and can trigger retry.">?</span>
                    </label>
                    <div className="completion-checks-list">
                      <label className="form-checkbox-label">
                        <input
                          type="checkbox"
                          checked={checkDiffNotEmpty}
                          onChange={e => setCheckDiffNotEmpty(e.target.checked)}
                        />
                        Diff not empty
                      </label>
                      <label className="form-checkbox-label">
                        <input
                          type="checkbox"
                          checked={checkNoErrors}
                          onChange={e => setCheckNoErrors(e.target.checked)}
                        />
                        No errors in output
                      </label>
                    </div>
                    <input
                      type="text"
                      value={customCheckCmd}
                      onChange={e => setCustomCheckCmd(e.target.value)}
                      placeholder="Custom check command (exit 0 = pass)"
                      style={{ marginTop: 6 }}
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-checkbox-label">
                      <input
                        type="checkbox"
                        checked={debateEnabled}
                        onChange={e => setDebateEnabled(e.target.checked)}
                      />
                      Debate before start
                      <span className="tooltip-icon" data-tip="Two models argue about the best approach before the job starts. The debate outcome enriches the job description.">?</span>
                    </label>
                  </div>

                  {debateEnabled && (
                    <div className="form-group" style={{ paddingLeft: 20 }}>
                      <div className="form-row">
                        <div className="form-group">
                          <label htmlFor="task-debate-claude">Claude Model</label>
                          <select id="task-debate-claude" value={debateClaudeModel} onChange={e => setDebateClaudeModel(e.target.value)}>
                            <option value="claude-opus-4-7[1m]">claude-opus-4-7[1m]</option>
                            <option value="claude-opus-4-6[1m]">claude-opus-4-6[1m]</option>
                            <option value="claude-sonnet-4-6[1m]">claude-sonnet-4-6[1m]</option>
                            <option value="claude-haiku-4-5-20251001">claude-haiku-4-5</option>
                          </select>
                        </div>
                        <div className="form-group">
                          <label htmlFor="task-debate-codex">Codex Model</label>
                          <select id="task-debate-codex" value={debateCodexModel} onChange={e => setDebateCodexModel(e.target.value)}>
                            {codexModels.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                          </select>
                        </div>
                      </div>
                      <div className="form-group form-group-sm">
                        <label htmlFor="task-debate-rounds">Max Rounds</label>
                        <input
                          id="task-debate-rounds"
                          type="number"
                          value={debateMaxRounds}
                          onChange={e => setDebateMaxRounds(Number(e.target.value))}
                          min={1}
                          max={10}
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* ── Workflow-only advanced section ─────────────────────────── */}
          {routesTo === 'workflow' && (
            <>
              <button
                type="button"
                className="btn btn-ghost"
                style={{ fontSize: 12, padding: '4px 0', marginBottom: 8 }}
                onClick={() => setShowAdvanced(v => !v)}
              >
                {showAdvanced ? '\u25be' : '\u25b8'} Per-phase stopping conditions
              </button>

              {showAdvanced && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <StopModePicker
                    label="Assess stopping condition"
                    mode={stopModeAssess}
                    value={stopValueAssess}
                    onModeChange={setStopModeAssess}
                    onValueChange={setStopValueAssess}
                  />
                  <StopModePicker
                    label="Review stopping condition"
                    mode={stopModeReview}
                    value={stopValueReview}
                    onModeChange={setStopModeReview}
                    onValueChange={setStopValueReview}
                  />
                  <StopModePicker
                    label="Implement stopping condition"
                    mode={stopModeImplement}
                    value={stopValueImplement}
                    onModeChange={setStopModeImplement}
                    onValueChange={setStopValueImplement}
                  />
                  <div className="form-group">
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={verifyEnabled}
                        onChange={e => setVerifyEnabled(e.target.checked)}
                      />
                      Verify before PR
                    </label>
                    {verifyEnabled && (
                      <>
                        <input
                          id="task-start-cmd"
                          type="text"
                          value={startCommand}
                          onChange={e => setStartCommand(e.target.value)}
                          placeholder="e.g. npm run dev, docker compose up"
                          style={{ fontFamily: 'var(--font-mono)', fontSize: 12, marginTop: 4 }}
                        />
                        <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>
                          Command to start the app. A QA agent will write and run smoke tests against it.
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {error && <div className="form-error">{error}</div>}

          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading
                ? 'Creating...'
                : routesTo === 'workflow'
                  ? 'Start Autonomous Run'
                  : 'Create Job'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
