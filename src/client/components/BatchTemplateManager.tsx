import React, { useEffect, useState } from 'react';
import type { BatchTemplate, Template, Project, RunBatchTemplateResponse } from '@shared/types';
import { useModels } from '../hooks/useModels';

interface BatchTemplateManagerProps {
  onClose: () => void;
  onRun: (project: Project) => void;
}

export function BatchTemplateManager({ onClose, onRun }: BatchTemplateManagerProps) {
  const { claude: claudeModels, codex: codexModels } = useModels();
  const [batchTemplates, setBatchTemplates] = useState<BatchTemplate[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [selected, setSelected] = useState<BatchTemplate | null>(null);
  const [creating, setCreating] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null); // which batch template is in "run config" mode

  // Edit form state
  const [name, setName] = useState('');
  const [items, setItems] = useState<string[]>(['']);
  const [saving, setSaving] = useState(false);

  // Run config state
  const [runProjectName, setRunProjectName] = useState('');
  const [runTemplateId, setRunTemplateId] = useState('');
  const [runModel, setRunModel] = useState('');
  const [runWorkDir, setRunWorkDir] = useState('');
  const [runMaxTurns, setRunMaxTurns] = useState(50);
  const [runInteractive, setRunInteractive] = useState(false);
  const [runUseWorktree, setRunUseWorktree] = useState(false);
  const [runDebate, setRunDebate] = useState(false);
  const [runClaudeModel, setRunClaudeModel] = useState('claude-sonnet-4-6[1m]');
  const [runCodexModel, setRunCodexModel] = useState('codex');
  const [runDebateMaxRounds, setRunDebateMaxRounds] = useState(3);
  const [runPostActionPrompt, setRunPostActionPrompt] = useState('');
  const [runPostActionRole, setRunPostActionRole] = useState<'claude' | 'codex'>('claude');
  const [runPostActionVerification, setRunPostActionVerification] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [confirmDeleteBt, setConfirmDeleteBt] = useState<BatchTemplate | null>(null);

  useEffect(() => {
    fetch('/api/batch-templates').then(r => r.json()).then(setBatchTemplates).catch(console.error);
    fetch('/api/templates').then(r => r.json()).then(setTemplates).catch(console.error);
  }, []);

  function startCreate() {
    setSelected(null);
    setRunningId(null);
    setName('');
    setItems(['']);
    setCreating(true);
  }

  function startEdit(bt: BatchTemplate) {
    setCreating(false);
    setRunningId(null);
    setSelected(bt);
    setName(bt.name);
    setItems(bt.items.length > 0 ? [...bt.items] : ['']);
  }

  function startRun(bt: BatchTemplate) {
    setCreating(false);
    setSelected(null);
    setRunningId(bt.id);
    setRunProjectName(bt.name);
    setRunTemplateId('');
    setRunModel('');
    setRunWorkDir('');
    setRunMaxTurns(50);
    setRunInteractive(false);
    setRunUseWorktree(false);
    setRunDebate(false);
    setRunClaudeModel('claude-sonnet-4-6[1m]');
    setRunCodexModel('codex');
    setRunDebateMaxRounds(3);
    setRunPostActionPrompt('');
    setRunPostActionRole('claude');
    setRunPostActionVerification(false);
  }

  function cancelForm() {
    setCreating(false);
    setSelected(null);
    setRunningId(null);
  }

  function addItem() {
    setItems(prev => [...prev, '']);
  }

  function removeItem(idx: number) {
    setItems(prev => prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx));
  }

  function updateItem(idx: number, value: string) {
    setItems(prev => prev.map((v, i) => i === idx ? value : v));
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const cleanedItems = items.map(i => i.trim()).filter(Boolean);
    if (!name.trim() || cleanedItems.length === 0) return;
    setSaving(true);
    try {
      if (selected) {
        const res = await fetch(`/api/batch-templates/${selected.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name.trim(), items: cleanedItems }),
        });
        const updated: BatchTemplate = await res.json();
        setBatchTemplates(prev => prev.map(bt => bt.id === updated.id ? updated : bt));
      } else {
        const res = await fetch('/api/batch-templates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name.trim(), items: cleanedItems }),
        });
        const created: BatchTemplate = await res.json();
        setBatchTemplates(prev => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
      }
      cancelForm();
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(bt: BatchTemplate) {
    await fetch(`/api/batch-templates/${bt.id}`, { method: 'DELETE' });
    setBatchTemplates(prev => prev.filter(x => x.id !== bt.id));
    if (selected?.id === bt.id || runningId === bt.id) cancelForm();
    setConfirmDeleteBt(null);
  }

  async function handleRun(e: React.FormEvent) {
    e.preventDefault();
    if (!runningId) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/batch-templates/${runningId}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templateId: runTemplateId || undefined,
          model: runDebate ? undefined : (runModel || undefined),
          interactive: runDebate ? undefined : (runInteractive || undefined),
          useWorktree: runDebate ? undefined : (runUseWorktree || undefined),
          workDir: runWorkDir.trim() || undefined,
          maxTurns: runMaxTurns,
          projectName: runProjectName.trim() || undefined,
          debate: runDebate || undefined,
          claudeModel: runDebate ? runClaudeModel : undefined,
          codexModel: runDebate ? runCodexModel : undefined,
          debateMaxRounds: runDebate ? runDebateMaxRounds : undefined,
          postActionPrompt: runDebate && runPostActionPrompt.trim() ? runPostActionPrompt.trim() : undefined,
          postActionRole: runDebate && runPostActionPrompt.trim() ? runPostActionRole : undefined,
          postActionVerification: runDebate && runPostActionPrompt.trim() ? runPostActionVerification : undefined,
        }),
      });
      if (!res.ok) return;
      const data: RunBatchTemplateResponse = await res.json();
      onRun(data.project);
    } finally {
      setSubmitting(false);
    }
  }

  const handleTemplateChange = (newTemplateId: string) => {
    setRunTemplateId(newTemplateId);
    const tpl = templates.find(t => t.id === newTemplateId);
    if (tpl?.work_dir) setRunWorkDir(tpl.work_dir);
    if (tpl?.model) setRunModel(tpl.model);
  };

  const runBt = runningId ? batchTemplates.find(bt => bt.id === runningId) : null;
  const isEditing = creating || selected;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Batch Templates</h2>
          <button className="btn-icon" onClick={onClose}>✕</button>
        </div>

        <div className="template-layout">
          {/* Left pane: list */}
          <div className="template-list">
            <button className="btn btn-secondary btn-sm template-new-btn" onClick={startCreate}>
              + New Batch
            </button>
            {batchTemplates.length === 0 && !creating && (
              <p className="sidebar-empty">No batch templates yet</p>
            )}
            {batchTemplates.map(bt => (
              <div
                key={bt.id}
                className={`template-item ${selected?.id === bt.id || runningId === bt.id ? 'template-item-active' : ''}`}
                onClick={() => startEdit(bt)}
              >
                <span className="template-item-name">{bt.name}</span>
                <span style={{ fontSize: 11, color: '#6e7681', flexShrink: 0 }}>{bt.items.length}</span>
                <button
                  className="btn-icon template-delete-btn"
                  onClick={e => { e.stopPropagation(); setConfirmDeleteBt(bt); }}
                  title="Delete"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>

          {/* Right pane */}
          <div className="template-editor">
            {isEditing ? (
              <form onSubmit={handleSave} className="template-form">
                <div className="form-group">
                  <label htmlFor="bt-name">Name</label>
                  <input
                    id="bt-name"
                    type="text"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    placeholder="e.g. Code Quality Checks"
                    autoFocus
                    required
                  />
                </div>

                <div className="form-group" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                  <label>Items</label>
                  <div className="batch-item-list">
                    {items.map((item, idx) => (
                      <div key={idx} className="batch-item-row">
                        <textarea
                          value={item}
                          onChange={e => {
                            updateItem(idx, e.target.value);
                            e.target.style.height = 'auto';
                            e.target.style.height = e.target.scrollHeight + 'px';
                          }}
                          ref={el => {
                            if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; }
                          }}
                          placeholder={`Item ${idx + 1}...`}
                          rows={1}
                          style={{ resize: 'none', overflow: 'hidden' }}
                        />
                        <button type="button" className="batch-item-remove" onClick={() => removeItem(idx)} title="Remove">✕</button>
                      </div>
                    ))}
                  </div>
                  <button type="button" className="btn btn-secondary btn-sm batch-add-btn" onClick={addItem}>
                    + Add Item
                  </button>
                </div>

                <div className="form-actions">
                  <button type="button" className="btn btn-secondary" onClick={cancelForm}>Cancel</button>
                  {selected && (
                    <>
                      <button type="button" className="btn btn-danger" onClick={() => setConfirmDeleteBt(selected)}>
                        Delete
                      </button>
                      <button type="button" className="btn btn-primary" onClick={() => startRun(selected)}>
                        Run
                      </button>
                    </>
                  )}
                  <button type="submit" className="btn btn-primary" disabled={saving}>
                    {saving ? 'Saving...' : selected ? 'Save Changes' : 'Create'}
                  </button>
                </div>
              </form>
            ) : runBt ? (
              <form onSubmit={handleRun} className="batch-run-config">
                <h3 style={{ margin: '0 0 4px 0', fontSize: 15, color: '#e6edf3' }}>
                  Run "{runBt.name}" ({runBt.items.length} items)
                </h3>

                <div className="form-group">
                  <label htmlFor="run-project-name">Project Name</label>
                  <input
                    id="run-project-name"
                    type="text"
                    value={runProjectName}
                    onChange={e => setRunProjectName(e.target.value)}
                    placeholder="Name for the project"
                  />
                </div>

                <div className="form-group">
                  <label htmlFor="run-template">Job Template <span className="form-label-hint">(optional)</span></label>
                  <select
                    id="run-template"
                    value={runTemplateId}
                    onChange={e => handleTemplateChange(e.target.value)}
                  >
                    <option value="">None</option>
                    {templates.map(t => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                </div>

                <div className="form-group">
                  <label className="form-checkbox-label">
                    <input type="checkbox" checked={runDebate} onChange={e => setRunDebate(e.target.checked)} />
                    Debate mode
                    <span className="form-label-hint" style={{ marginLeft: 4 }}>(each item runs as a Claude vs Codex debate)</span>
                  </label>
                </div>

                {runDebate ? (
                  <>
                    <div className="form-row">
                      <div className="form-group">
                        <label htmlFor="run-claude-model">Claude Model</label>
                        <select
                          id="run-claude-model"
                          value={runClaudeModel}
                          onChange={e => setRunClaudeModel(e.target.value)}
                        >
                          <option value="claude-opus-4-7[1m]">claude-opus-4-7[1m]</option>
                          <option value="claude-opus-4-6[1m]">claude-opus-4-6[1m]</option>
                          <option value="claude-sonnet-4-6[1m]">claude-sonnet-4-6[1m]</option>
                          <option value="claude-haiku-4-5-20251001">claude-haiku-4-5</option>
                        </select>
                      </div>
                      <div className="form-group">
                        <label htmlFor="run-codex-model">Codex Model</label>
                        <select
                          id="run-codex-model"
                          value={runCodexModel}
                          onChange={e => setRunCodexModel(e.target.value)}
                        >
                          {codexModels.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                        </select>
                      </div>
                    </div>

                    <div className="form-row">
                      <div className="form-group form-group-sm">
                        <label htmlFor="run-debate-max-rounds">Max Rounds</label>
                        <input
                          id="run-debate-max-rounds"
                          type="number"
                          value={runDebateMaxRounds}
                          onChange={e => setRunDebateMaxRounds(Number(e.target.value))}
                          min={1}
                          max={10}
                        />
                      </div>
                      <div className="form-group">
                        <label htmlFor="run-workdir">Working Directory</label>
                        <input
                          id="run-workdir"
                          type="text"
                          value={runWorkDir}
                          onChange={e => setRunWorkDir(e.target.value)}
                          placeholder="/path/to/project (optional)"
                        />
                      </div>
                    </div>

                    <div className="form-group">
                      <label htmlFor="run-post-action">Post-Debate Action <span className="form-label-hint">(optional — runs after each debate concludes)</span></label>
                      <textarea
                        id="run-post-action"
                        value={runPostActionPrompt}
                        onChange={e => setRunPostActionPrompt(e.target.value)}
                        placeholder="e.g. Implement what you agreed upon"
                        rows={3}
                      />
                    </div>

                    {runPostActionPrompt.trim() && (
                      <div className="form-group">
                        <label>Run action with</label>
                        <div className="radio-group">
                          <label className="radio-label">
                            <input type="radio" value="claude" checked={runPostActionRole === 'claude'} onChange={() => setRunPostActionRole('claude')} />
                            Claude ({runClaudeModel})
                          </label>
                          <label className="radio-label">
                            <input type="radio" value="codex" checked={runPostActionRole === 'codex'} onChange={() => setRunPostActionRole('codex')} />
                            Codex ({runCodexModel})
                          </label>
                        </div>
                      </div>
                    )}

                    {runPostActionPrompt.trim() && (
                      <div className="form-group">
                        <label className="form-checkbox-label">
                          <input
                            type="checkbox"
                            checked={runPostActionVerification}
                            onChange={e => setRunPostActionVerification(e.target.checked)}
                          />
                          Verification
                          <span className="form-label-hint" style={{ marginLeft: 4 }}>
                            (after action, the other model reviews and the implementer can apply feedback)
                          </span>
                        </label>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="form-group">
                      <label htmlFor="run-model">Model <span className="form-label-hint">(leave blank to auto-select)</span></label>
                      <select
                        id="run-model"
                        value={runModel}
                        onChange={e => setRunModel(e.target.value)}
                      >
                        <option value="">Auto-select (Haiku classifies the task)</option>
                        {claudeModels.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                        {codexModels.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                      </select>
                    </div>

                    <div className="form-row">
                      <div className="form-group">
                        <label htmlFor="run-workdir">Working Directory</label>
                        <input
                          id="run-workdir"
                          type="text"
                          value={runWorkDir}
                          onChange={e => setRunWorkDir(e.target.value)}
                          placeholder="/path/to/project (optional)"
                        />
                      </div>
                    </div>

                    <div className="form-group">
                      <label className="form-checkbox-label">
                        <input type="checkbox" checked={runInteractive} onChange={e => setRunInteractive(e.target.checked)} />
                        Interactive session
                      </label>
                    </div>

                    <div className="form-group">
                      <label className="form-checkbox-label">
                        <input type="checkbox" checked={runUseWorktree} onChange={e => setRunUseWorktree(e.target.checked)} />
                        Use worktree
                      </label>
                    </div>
                  </>
                )}

                <div className="form-actions">
                  <button type="button" className="btn btn-secondary" onClick={cancelForm}>Cancel</button>
                  <button type="submit" className="btn btn-primary" disabled={submitting}>
                    {submitting ? 'Running...' : runDebate
                      ? `Run Batch (${runBt.items.length} debates)`
                      : `Run Batch (${runBt.items.length} jobs)`}
                  </button>
                </div>
              </form>
            ) : (
              <div className="template-editor-empty">
                Select a batch template to edit, or create a new one.
              </div>
            )}
          </div>
        </div>
      </div>
      {confirmDeleteBt && (
        <div className="modal-overlay" onClick={() => setConfirmDeleteBt(null)}>
          <div className="modal" style={{ width: 360 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Delete Batch Template</h2>
              <button className="btn-icon" onClick={() => setConfirmDeleteBt(null)} aria-label="Close">&times;</button>
            </div>
            <div className="confirm-body">
              <p className="confirm-text">Delete <strong>{confirmDeleteBt.name}</strong>? This cannot be undone.</p>
              <div className="confirm-actions">
                <button className="btn btn-secondary btn-sm" onClick={() => setConfirmDeleteBt(null)}>Cancel</button>
                <button className="btn btn-danger btn-sm" onClick={() => handleDelete(confirmDeleteBt)}>Delete</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
