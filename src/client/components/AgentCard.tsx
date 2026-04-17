import React from 'react';
import type { AgentWithJob } from '@shared/types';

interface AgentCardProps {
  agent: AgentWithJob;
  onClick: (agent: AgentWithJob) => void;
  onSelectParent?: (parentId: string) => void;
  onArchiveJob?: () => void;
  onInteractiveChange?: (jobId: string, interactive: boolean) => void;
  templateName?: string;
  isSelected?: boolean;
  isPtyIdle?: boolean;
  now?: number;
}

// Client-side cost estimation (mirrors CostEstimator.ts pricing)
const MODEL_PRICING: Record<string, [number, number]> = {
  'claude-opus-4-7':         [15, 75],
  'claude-opus-4-7[1m]':     [15, 75],
  'claude-opus-4-6':         [15, 75],
  'claude-opus-4-6[1m]':     [15, 75],
  'claude-sonnet-4-6':       [3, 15],
  'claude-sonnet-4-6[1m]':   [3, 15],
  'claude-haiku-4-5-20251001': [0.80, 4],
};

function estimateCost(model: string | null, inputTokens: number, outputTokens: number): number {
  const [inp, out] = (model && MODEL_PRICING[model]) || [3, 15];
  return (inputTokens / 1_000_000) * inp + (outputTokens / 1_000_000) * out;
}

function formatElapsed(ms: number): string {
  if (ms < 0) return '0s';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatCost(cost: number, approximate: boolean): string {
  if (cost < 0.01) return approximate ? `~$${cost.toFixed(4)}` : `$${cost.toFixed(4)}`;
  return approximate ? `~$${cost.toFixed(2)}` : `$${cost.toFixed(4)}`;
}

function ArchiveIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="2" width="14" height="3" rx="0.75"/>
      <path d="M2.5 5v8.5a.5.5 0 00.5.5h10a.5.5 0 00.5-.5V5"/>
      <line x1="8" y1="7.5" x2="8" y2="11.5"/>
      <polyline points="6,9.5 8,11.5 10,9.5"/>
    </svg>
  );
}

function getBorderColor(agent: AgentWithJob, isPtyIdle?: boolean): string {
  if (isPtyIdle && agent.status === 'running') return '#3b82f6';
  switch (agent.status) {
    case 'starting':
    case 'running':
      return '#f59e0b';
    case 'waiting_user':
      return '#ef4444';
    case 'done':
      return agent.output_read ? 'transparent' : '#22c55e';
    case 'failed':
      return 'transparent';
    case 'cancelled':
      return 'transparent';
    default:
      return 'transparent';
  }
}

function getStatusLabel(agent: AgentWithJob, isPtyIdle?: boolean): React.ReactNode {
  switch (agent.status) {
    case 'starting': return 'Starting...';
    case 'running': return agent.status_message ?? (agent.job.is_interactive
      ? (isPtyIdle
          ? <>'Running' <span style={{ color: '#3b82f6' }}>(waiting for input)</span></>
          : <>'Running' <span style={{ color: '#ef4444' }}>(interactive)</span></>)
      : 'Running');
    case 'waiting_user': return 'Waiting for answer';
    case 'done': return agent.output_read ? 'Done (read)' : 'Done';
    case 'failed': {
      if (agent.output_read) return 'Failed (acknowledged)';
      if (agent.error_message) {
        const lastLine = agent.error_message.trim().split('\n').pop() ?? '';
        return lastLine.slice(0, 60) || 'Failed';
      }
      return 'Failed';
    }
    case 'cancelled': return 'Cancelled';
    default: return agent.status;
  }
}

function AgentCardInner({ agent, onClick, onSelectParent, onArchiveJob, onInteractiveChange, templateName, isSelected, isPtyIdle, now }: AgentCardProps) {
  const borderColor = getBorderColor(agent, isPtyIdle);
  const isWaiting = agent.status === 'waiting_user';

  function handleFlag(e: React.MouseEvent) {
    e.stopPropagation();
    fetch(`/api/jobs/${agent.job.id}/flag`, { method: 'POST' });
  }

  function handleInteractiveChange(e: React.ChangeEvent<HTMLInputElement>) {
    e.stopPropagation();
    const newValue = e.target.checked;
    fetch(`/api/jobs/${agent.job.id}/interactive`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interactive: newValue }),
    });
    if (onInteractiveChange) onInteractiveChange(agent.job.id, newValue);
  }

  function handleRequeue(e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm('Requeue this job? This will kill the running agent.')) return;
    fetch(`/api/agents/${agent.id}/requeue`, { method: 'POST' });
  }

  function handleDismissWarnings(e: React.MouseEvent) {
    e.stopPropagation();
    fetch(`/api/agents/${agent.id}/dismiss-warnings`, { method: 'POST' });
  }

  function handleGoToParent(e: React.MouseEvent) {
    e.stopPropagation();
    if (agent.parent_agent_id && onSelectParent) {
      onSelectParent(agent.parent_agent_id);
    }
  }

  return (
    <div
      className={`agent-card${isSelected ? ' agent-card-selected' : ''}`}
      style={borderColor !== 'transparent' ? { borderLeftColor: borderColor, borderLeftWidth: 3 } : undefined}
      onClick={() => onClick(agent)}
    >
      <div className="agent-card-header">
        <span className="agent-id">Agent {agent.id.slice(0, 6)}</span>
        {agent.parent_agent_id && onSelectParent && (
          <button
            className="parent-link-btn"
            onClick={handleGoToParent}
            title={`Go to parent agent ${agent.parent_agent_id.slice(0, 6)}`}
          >
            ↑ parent
          </button>
        )}
        <button
          className={`flag-btn${agent.job.flagged ? ' flag-btn-active' : ''}`}
          onClick={handleFlag}
          title={agent.job.flagged ? 'Remove flag' : 'Flag for review'}
          aria-label={agent.job.flagged ? 'Remove flag' : 'Flag for review'}
          aria-pressed={!!agent.job.flagged}
        >
          ⚑
        </button>
        <label
          className={`interactive-toggle${agent.job.is_interactive ? ' interactive-toggle-active' : ''}`}
          title={agent.job.is_interactive ? 'Interactive (click to disable)' : 'Make interactive'}
          onClick={e => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={!!agent.job.is_interactive}
            onChange={handleInteractiveChange}
            style={{ display: 'none' }}
          />
          ⌨
        </label>
        {onArchiveJob && ['done', 'failed', 'cancelled'].includes(agent.job?.status) && (
          <button
            className="archive-btn"
            onClick={e => { e.stopPropagation(); onArchiveJob(); }}
            title="Archive job"
            aria-label="Archive job"
          >
            <ArchiveIcon />
          </button>
        )}
        {['starting', 'running', 'waiting_user'].includes(agent.status) && (
          <button
            className="requeue-btn"
            onClick={handleRequeue}
            title="Kill agent and requeue job"
          >
            ↺
          </button>
        )}
        <span className={`agent-status-badge status-${agent.status}${isPtyIdle && agent.status === 'running' ? ' status-pty-idle' : ''}`}>
          {agent.status}
        </span>
      </div>
      <div className="agent-job-title">{agent.job.title}</div>
      <div className="agent-status-msg">{getStatusLabel(agent, isPtyIdle)}</div>
      {templateName && (
        <div className="agent-template" title={templateName}>
          {templateName}
        </div>
      )}
      {agent.job.model && (
        <div className="agent-model" title={agent.job.model}>
          {agent.job.model.replace('claude-', '')}
        </div>
      )}

      {agent.job.debate_id && (
        <div className="agent-debate-badge" title={`Debate round ${agent.job.debate_round}, ${agent.job.debate_role} side`}>
          R{agent.job.debate_round} {agent.job.debate_role === 'claude' ? 'Claude' : 'Codex'}
        </div>
      )}

      {agent.job.original_job_id && (
        <div className="agent-retry-badge" title={`Retry ${agent.job.retry_count}/${agent.job.max_retries}`}>
          Retry {agent.job.retry_count}/{agent.job.max_retries}
        </div>
      )}

      {agent.warnings && agent.warnings.length > 0 && (
        <div className="agent-warning-badge" onClick={handleDismissWarnings} title="Click to dismiss warnings">
          <span className="warning-icon">!</span>
          {agent.warnings.map(w => w.message).join('; ')}
        </div>
      )}

      {agent.active_locks.length > 0 && (
        <div className="agent-locks">
          {agent.active_locks.slice(0, 3).map(lock => (
            <span key={lock.id} className="lock-badge" title={lock.reason ?? ''}>
              {lock.file_path.split('/').pop()}
            </span>
          ))}
          {agent.active_locks.length > 3 && (
            <span className="lock-badge">+{agent.active_locks.length - 3}</span>
          )}
        </div>
      )}

      {isWaiting && agent.pending_question && (
        <div className="agent-question-preview">
          <span className="question-icon">?</span>
          {agent.pending_question.question.slice(0, 80)}
          {agent.pending_question.question.length > 80 ? '...' : ''}
        </div>
      )}

      {/* Timing + Cost footer */}
      {(() => {
        const isRunning = agent.status === 'running' || agent.status === 'starting';
        const isFinished = agent.status === 'done' || agent.status === 'failed' || agent.status === 'cancelled';
        if (!isRunning && !isFinished) return null;

        const elapsedMs = isRunning
          ? (now ?? Date.now()) - agent.started_at
          : (agent.duration_ms ?? (agent.finished_at ? agent.finished_at - agent.started_at : 0));

        const cost = isFinished && agent.cost_usd != null
          ? agent.cost_usd
          : (agent.estimated_input_tokens || agent.estimated_output_tokens)
            ? estimateCost(agent.job?.model ?? null, agent.estimated_input_tokens ?? 0, agent.estimated_output_tokens ?? 0)
            : null;

        const isApproxCost = !(isFinished && agent.cost_usd != null);

        return (
          <div className="agent-card-footer">
            <span className={`agent-card-elapsed ${isRunning ? 'agent-card-elapsed-live' : ''}`}>
              {formatElapsed(elapsedMs)}
            </span>
            {cost != null && cost > 0 && (
              <span className="agent-card-cost">
                {formatCost(cost, isApproxCost)}
              </span>
            )}
          </div>
        );
      })()}
    </div>
  );
}

export const AgentCard = React.memo(AgentCardInner, (prev, next) => {
  // Always re-render if agent data changed
  if (prev.agent !== next.agent || prev.isSelected !== next.isSelected || prev.isPtyIdle !== next.isPtyIdle || prev.templateName !== next.templateName) return false;
  // Only re-render on tick if agent is actively running
  const isRunning = prev.agent.status === 'running' || prev.agent.status === 'starting';
  if (isRunning && prev.now !== next.now) return false;
  // Skip re-render for tick on non-running agents
  if (prev.now !== next.now) return true;
  return true;
});
