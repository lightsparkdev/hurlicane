import type { Workflow, AgentWithJob } from '@shared/types';

interface WorkflowSummaryCardProps {
  workflow: Workflow;
  workflowAgents: AgentWithJob[];
  now: number;
  onClick: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  running: '#22c55e',
  complete: '#3b82f6',
  blocked: '#f59e0b',
  failed: '#ef4444',
  cancelled: '#6b7280',
};

const PHASES = ['assess', 'review', 'implement', 'verify'] as const;

// Client-side cost estimation (mirrors CostEstimator.ts)
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

export function WorkflowSummaryCard({ workflow, workflowAgents, now, onClick }: WorkflowSummaryCardProps) {
  const statusColor = STATUS_COLORS[workflow.status] ?? '#6b7280';
  const milestonePercent = workflow.milestones_total > 0
    ? Math.round((workflow.milestones_done / workflow.milestones_total) * 100)
    : 0;

  // Compute total cost
  let totalCost = 0;
  let hasFinalCost = false;
  for (const agent of workflowAgents) {
    if (agent.cost_usd != null) {
      totalCost += agent.cost_usd;
      hasFinalCost = true;
    } else if (agent.estimated_input_tokens || agent.estimated_output_tokens) {
      totalCost += estimateCost(agent.job?.model ?? null, agent.estimated_input_tokens ?? 0, agent.estimated_output_tokens ?? 0);
    }
  }

  // Compute total elapsed (wall clock from workflow creation to now or last agent finish)
  const wallElapsed = workflow.status === 'running'
    ? now - workflow.created_at
    : (workflow.updated_at - workflow.created_at);

  // Count jobs
  const jobCount = workflowAgents.length;

  // Compute ETA based on completed cycles
  let etaText: string | null = null;
  if (workflow.status === 'running' && workflow.current_cycle > 0 && workflow.current_cycle < workflow.max_cycles) {
    const avgCycleDuration = wallElapsed / workflow.current_cycle;
    const remainingCycles = workflow.max_cycles - workflow.current_cycle;
    const etaMs = avgCycleDuration * remainingCycles;
    etaText = `~${formatElapsed(etaMs)}`;
  }

  return (
    <div className="workflow-summary-card" style={{ borderLeftColor: statusColor }} onClick={onClick}>
      <div className="workflow-summary-top">
        <div className="workflow-summary-title-row">
          <span className="workflow-summary-dot" style={{ background: statusColor }} />
          <span className="workflow-summary-title">{workflow.title}</span>
          <span className="workflow-summary-cycle">C{workflow.current_cycle}/{workflow.max_cycles}</span>
        </div>
        <div className="workflow-summary-phases">
          {PHASES.map(phase => {
            const isCurrent = workflow.current_phase === phase && workflow.status === 'running';
            const isPast = PHASES.indexOf(workflow.current_phase as typeof PHASES[number]) > PHASES.indexOf(phase);
            return (
              <span
                key={phase}
                className={`workflow-phase-pill${isCurrent ? ' workflow-phase-current' : ''}${isPast ? ' workflow-phase-past' : ''}`}
              >
                {phase.charAt(0).toUpperCase() + phase.slice(1)}
              </span>
            );
          })}
        </div>
        {workflow.milestones_total > 0 && (
          <span className="workflow-summary-milestones">
            {workflow.milestones_done}/{workflow.milestones_total}
          </span>
        )}
      </div>

      {workflow.milestones_total > 0 && (
        <div className="workflow-summary-progress-bar">
          <div
            className="workflow-summary-progress-fill"
            style={{ width: `${milestonePercent}%`, background: statusColor }}
          />
        </div>
      )}

      <div className="workflow-summary-stats">
        <span>Elapsed: {formatElapsed(wallElapsed)}</span>
        <span className="workflow-summary-stat-sep" />
        <span>Cost: {totalCost > 0 ? (hasFinalCost ? `$${totalCost.toFixed(2)}` : `~$${totalCost.toFixed(2)}`) : '--'}</span>
        <span className="workflow-summary-stat-sep" />
        <span>Jobs: {jobCount}</span>
        {etaText && (
          <>
            <span className="workflow-summary-stat-sep" />
            <span>ETA: {etaText}</span>
          </>
        )}
      </div>
    </div>
  );
}
